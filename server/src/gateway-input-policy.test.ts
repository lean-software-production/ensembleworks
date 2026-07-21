// POST /api/terminal/input-policy — the first owner-match-or-403 endpoint
// (spec §4 "Toggle"): the owner flips a gateway's input policy; anyone else
// (including dev-anonymous) is 403'd; unknown gateway 404; bad body 400. The
// flip is live (a previously dropped non-owner input flows after unlock) and
// remembered across a reconnect within the server lifetime (decision log 3).
// Identity via fake CF Access service-token JWTs (gateway-identity.test.ts
// pattern). Run with: bun src/gateway-input-policy.test.ts
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'

delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL

const dir = await mkdtemp(path.join(os.tmpdir(), 'gw-policy-'))
const mapFile = path.join(dir, 'service-tokens.toml')
writeFileSync(
	mapFile,
	[
		'[tokens."a.access"]',
		'identity = "🤖 A"',
		'scope = "read-write"',
		'[tokens."b.access"]',
		'identity = "🤖 B"',
		'scope = "read-write"',
	].join('\n') + '\n',
)
process.env.EW_SERVICE_TOKENS_FILE = mapFile

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`
const authHeaders = (token?: string): Record<string, string> =>
	token ? { 'cf-access-jwt-assertion': jwt({ common_name: token }) } : {}

const openWs = (url: string, token?: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url, { headers: authHeaders(token) })
		ws.once('open', () => resolve(ws))
		ws.on('error', reject)
	})

const until = async <T>(what: string, poll: () => T | undefined, timeoutMs = 5000): Promise<T> => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const v = poll()
		if (v !== undefined) return v
		await new Promise((r) => setTimeout(r, 25))
	}
	throw new Error(`timeout waiting for ${what}`)
}

async function main() {
	const { server } = createSyncApp({ dataDir: dir })
	await new Promise<void>((r) => server.listen(0, r))
	const port = (server.address() as { port: number }).port
	const base = `http://127.0.0.1:${port}`
	const wsBase = `ws://127.0.0.1:${port}`

	const post = async (body: unknown, token?: string) =>
		fetch(`${base}/api/terminal/input-policy`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...authHeaders(token) },
			body: JSON.stringify(body),
		})
	const policyOf = async (id: string) => {
		const res = await fetch(`${base}/api/terminal/list`)
		const body = (await res.json()) as { gateways: Array<{ gatewayId: string; inputPolicy: string }> }
		return body.gateways.find((g) => g.gatewayId === id)?.inputPolicy
	}

	// Owner A registers a locked codespace; a recording ws stands in for the connector.
	const repo = encodeURIComponent('github.com/acme/app')
	const gw = await openWs(`${wsBase}/api/terminal/connect?gatewayId=cs1&label=CS&repo=${repo}`, 'a.access')
	const gwFrames: Array<{ type: string; channelId?: number; msg?: { type?: string } }> = []
	gw.on('message', (data, isBinary) => {
		if (!isBinary) gwFrames.push(JSON.parse(data.toString()))
	})
	assert.equal(await policyOf('cs1'), 'locked')

	// Validation + authz matrix.
	assert.equal((await post({ policy: 'shared' }, 'a.access')).status, 400, 'missing gatewayId → 400')
	assert.equal((await post({ gatewayId: 'cs1', policy: 'open' }, 'a.access')).status, 400, 'bad policy → 400')
	assert.equal((await post({ gatewayId: 'nope', policy: 'shared' }, 'a.access')).status, 404, 'unknown gateway → 404')
	assert.equal((await post({ gatewayId: 'cs1', policy: 'shared' })).status, 403, 'anonymous (dev) → 403')
	assert.equal((await post({ gatewayId: 'cs1', policy: 'shared' }, 'b.access')).status, 403, 'non-owner → 403')
	assert.equal(await policyOf('cs1'), 'locked', 'rejected calls change nothing')

	// Owner flips to shared → 200, visible in list, and LIVE at the relay:
	// guest input that was dropped now flows.
	const guest = await openWs(`${wsBase}/api/terminal/relay?session=s1&gateway=cs1&cols=80&rows=24`, 'b.access')
	const chGuest = (await until('relay-open', () => gwFrames.find((f) => f.type === 'relay-open'))).channelId!
	guest.send(JSON.stringify({ type: 'input', data: 'locked-out\r' }))
	guest.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
	await until('resize (drop barrier)', () =>
		gwFrames.find((f) => f.type === 'relay-msg' && f.channelId === chGuest && f.msg?.type === 'resize'),
	)
	assert.equal(
		gwFrames.filter((f) => f.type === 'relay-msg' && f.channelId === chGuest && f.msg?.type === 'input').length,
		0,
		'locked: guest input dropped before the flip',
	)

	const ok = await post({ gatewayId: 'cs1', policy: 'shared' }, 'a.access')
	assert.equal(ok.status, 200, 'owner flip → 200')
	assert.deepEqual(await ok.json(), { ok: true, gatewayId: 'cs1', policy: 'shared' })
	assert.equal(await policyOf('cs1'), 'shared')

	guest.send(JSON.stringify({ type: 'input', data: 'now-shared\r' }))
	await until('guest input flows after unlock', () =>
		gwFrames.find((f) => f.type === 'relay-msg' && f.channelId === chGuest && f.msg?.type === 'input'),
	)

	// Persistence across reconnect: the remembered 'shared' beats the
	// repo-derived 'locked' default when the same owner reconnects.
	gw.close()
	await new Promise((r) => setTimeout(r, 100))
	const gw2 = await openWs(`${wsBase}/api/terminal/connect?gatewayId=cs1&label=CS&repo=${repo}`, 'a.access')
	assert.equal(await policyOf('cs1'), 'shared', 'policy survives reconnect within server lifetime')

	guest.close()
	gw2.close()
	server.close()
	console.log('gateway-input-policy.test.ts: all assertions passed')
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
