// Booted WS integration for the SP3 input ACL (spec §4 / §7): real
// /api/terminal/connect registrations under service-token identities, real
// /api/terminal/relay attaches per viewer, and proof over the wire that a
// locked gateway drops non-owner input AT THE RELAY while resize and output
// still flow — and that a plain (no-repo) gateway keeps today's shared
// behavior. Also pins GET /api/terminal/list's new fields incl. the
// server-stamped viewerIsOwner. Ordering trick: a ws connection delivers
// frames in order, so "send input, then resize; observe resize arrive" proves
// the input was dropped, not merely late. Network-free of tmux/pty — the
// "connector" is a bare recording ws. Run with: bun src/gateway-acl.test.ts
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

const dir = await mkdtemp(path.join(os.tmpdir(), 'gw-acl-'))
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
const authHeaders = (token?: string) =>
	token ? { 'cf-access-jwt-assertion': jwt({ common_name: token }) } : {}

const openWs = (url: string, token?: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url, { headers: authHeaders(token) })
		ws.once('open', () => resolve(ws))
		ws.on('error', reject)
	})

/** Recording "connector": collects every text frame the relay forwards. */
function recordFrames(ws: WebSocket): Array<{ type: string; channelId?: number; msg?: { type?: string } }> {
	const frames: Array<{ type: string; channelId?: number; msg?: { type?: string } }> = []
	ws.on('message', (data, isBinary) => {
		if (!isBinary) frames.push(JSON.parse(data.toString()))
	})
	return frames
}

const until = async <T>(what: string, poll: () => T | undefined, timeoutMs = 5000): Promise<T> => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const v = poll()
		if (v !== undefined) return v
		await new Promise((r) => setTimeout(r, 25))
	}
	throw new Error(`timeout waiting for ${what}`)
}

const inputsFor = (frames: ReturnType<typeof recordFrames>, ch: number) =>
	frames.filter((f) => f.type === 'relay-msg' && f.channelId === ch && f.msg?.type === 'input')
const resizesFor = (frames: ReturnType<typeof recordFrames>, ch: number) =>
	frames.filter((f) => f.type === 'relay-msg' && f.channelId === ch && f.msg?.type === 'resize')

async function main() {
	const { server } = createSyncApp({ dataDir: dir })
	await new Promise<void>((r) => server.listen(0, r))
	const port = (server.address() as { port: number }).port
	const base = `http://127.0.0.1:${port}`
	const wsBase = `ws://127.0.0.1:${port}`

	// Codespace gateway: owner is bot A, repo metadata → locked by default.
	const repo = encodeURIComponent('github.com/acme/app')
	const gw = await openWs(
		`${wsBase}/api/terminal/connect?gatewayId=cs1&label=CS&repo=${repo}&branch=main`,
		'a.access',
	)
	const gwFrames = recordFrames(gw)

	// Plain gateway (no repo) by the same owner → shared, legacy behavior.
	const plain = await openWs(`${wsBase}/api/terminal/connect?gatewayId=plain1&label=Box`, 'a.access')
	const plainFrames = recordFrames(plain)

	// --- list(): new fields + server-stamped viewerIsOwner -------------------
	const listAs = async (token?: string) => {
		const res = await fetch(`${base}/api/terminal/list`, { headers: authHeaders(token) })
		assert.equal(res.status, 200)
		const body = (await res.json()) as { gateways: Array<Record<string, unknown>> }
		return Object.fromEntries(body.gateways.map((g) => [g.gatewayId as string, g]))
	}
	const anonList = await listAs()
	assert.equal(anonList.cs1!.repo, 'github.com/acme/app')
	assert.equal(anonList.cs1!.branch, 'main')
	assert.equal(anonList.cs1!.inputPolicy, 'locked')
	assert.equal(anonList.cs1!.owner, 'token:a.access')
	assert.equal(anonList.cs1!.viewerIsOwner, false, 'anonymous (dev) viewer is not the owner')
	assert.equal(anonList.plain1!.inputPolicy, 'shared')
	assert.equal(anonList.plain1!.repo, undefined)
	const ownerList = await listAs('a.access')
	assert.equal(ownerList.cs1!.viewerIsOwner, true, 'owner sees viewerIsOwner true')
	assert.equal((await listAs('b.access')).cs1!.viewerIsOwner, false)

	// --- locked codespace: owner types, non-owner is read-only ---------------
	const relay = (gateway: string, session: string) =>
		`${wsBase}/api/terminal/relay?session=${session}&gateway=${gateway}&cols=80&rows=24`

	const ownerB = await openWs(relay('cs1', 's1'), 'a.access')
	const chOwner = (await until('owner relay-open', () =>
		gwFrames.find((f) => f.type === 'relay-open'),
	)).channelId!
	ownerB.send(JSON.stringify({ type: 'input', data: 'owner-types\r' }))
	await until('owner input forwarded', () => inputsFor(gwFrames, chOwner)[0])

	const guestB = await openWs(relay('cs1', 's1'), 'b.access')
	const chGuest = (await until('guest relay-open', () =>
		gwFrames.filter((f) => f.type === 'relay-open')[1],
	)).channelId!
	guestB.send(JSON.stringify({ type: 'input', data: 'guest-types\r' }))
	guestB.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
	await until('guest resize forwarded', () => resizesFor(gwFrames, chGuest)[0])
	// The resize (sent AFTER the input, same ordered ws) arrived — so the input
	// was dropped at the relay, not delayed.
	assert.equal(inputsFor(gwFrames, chGuest).length, 0, 'locked: non-owner input dropped at the relay')

	// Output still flows to the read-only viewer.
	const guestSaw = new Promise<string>((resolve) => {
		guestB.on('message', (data, isBinary) => {
			if (isBinary) resolve((data as Buffer).toString())
		})
	})
	const prefix = Buffer.allocUnsafe(4)
	prefix.writeUInt32BE(chGuest, 0)
	gw.send(Buffer.concat([prefix, Buffer.from('pty-output')]), { binary: true })
	assert.equal(await guestSaw, 'pty-output', 'locked: output still reaches the non-owner')

	// Anonymous viewer (dev identity ≠ token owner): also read-only.
	const anonB = await openWs(relay('cs1', 's1'))
	const chAnon = (await until('anon relay-open', () =>
		gwFrames.filter((f) => f.type === 'relay-open')[2],
	)).channelId!
	anonB.send(JSON.stringify({ type: 'input', data: 'anon-types\r' }))
	anonB.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 }))
	await until('anon resize forwarded', () => resizesFor(gwFrames, chAnon)[0])
	assert.equal(inputsFor(gwFrames, chAnon).length, 0, 'locked: anonymous input dropped')

	// --- plain gateway: unchanged — everyone's input flows -------------------
	const plainB = await openWs(relay('plain1', 's2'), 'b.access')
	const chPlain = (await until('plain relay-open', () =>
		plainFrames.find((f) => f.type === 'relay-open'),
	)).channelId!
	plainB.send(JSON.stringify({ type: 'input', data: 'still-shared\r' }))
	await until('plain non-owner input forwarded', () => inputsFor(plainFrames, chPlain)[0])

	for (const ws of [ownerB, guestB, anonB, plainB, gw, plain]) ws.close()
	server.close()
	console.log('gateway-acl.test.ts: all assertions passed')
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
