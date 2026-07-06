// Run: bun src/gateway-identity.test.ts   (from server/)
// WS integration for gateway-id binding (network-free): in dev mode a different
// identity can't take over a live gateway id and the same identity replaces; in
// strict mode an anonymous connect is refused before upgrade.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'
import { makeTestClient } from './test-helpers.ts'

delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL

const dir = await mkdtemp(path.join(os.tmpdir(), 'gw-identity-'))
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
const closed = (ws: WebSocket) =>
	new Promise<void>((resolve) => {
		if (ws.readyState === WebSocket.CLOSED) return resolve()
		ws.once('close', () => resolve())
	})

// --- dev mode: cross-identity binding over real WS ---
{
	const { server } = createSyncApp({ dataDir: dir })
	await new Promise<void>((r) => server.listen(0, r))
	const address = server.address() as { port: number }
	const base = `http://127.0.0.1:${address.port}`
	const wsBase = `ws://127.0.0.1:${address.port}`
	const { getJson } = makeTestClient(base)
	const ids = async () =>
		((await getJson('/api/terminal/list')).body.gateways as Array<{ gatewayId: string }>).map((g) => g.gatewayId)
	const openGw = (id: string, token?: string) =>
		new Promise<WebSocket>((resolve, reject) => {
			const headers = token ? { 'cf-access-jwt-assertion': jwt({ common_name: token }) } : {}
			const ws = new WebSocket(`${wsBase}/api/terminal/connect?gatewayId=${id}&label=${id}`, { headers })
			ws.once('open', () => resolve(ws))
			ws.on('error', reject)
		})

	const a = await openGw('g1', 'a.access')
	assert.ok((await ids()).includes('g1'), 'A registered g1')

	// bot B tries g1 → rejected (its ws closes 1008); A + g1 survive.
	const b = await openGw('g1', 'b.access')
	await closed(b)
	assert.ok((await ids()).includes('g1'), 'g1 survives B rejection')
	assert.equal(a.readyState, WebSocket.OPEN, 'A still connected')

	// A reconnects (same owner) → replaces; old A closes.
	const a2 = await openGw('g1', 'a.access')
	await closed(a)
	assert.ok((await ids()).includes('g1'), 'g1 survives A replace')

	// anonymous (dev owner) can't take over A2's g1 → rejected.
	const anon = await openGw('g1')
	await closed(anon)
	assert.equal(a2.readyState, WebSocket.OPEN, 'A2 keeps g1 after anon rejected')

	a2.close()
	server.close()
}

// --- strict mode: an anonymous connect is refused before upgrade (network-free) ---
{
	process.env.CF_ACCESS_TEAM_DOMAIN = 'example.cloudflareaccess.com'
	process.env.CF_ACCESS_AUD = 'dummy-aud'
	const { server } = createSyncApp({ dataDir: dir })
	await new Promise<void>((r) => server.listen(0, r))
	const address = server.address() as { port: number }
	const wsBase = `ws://127.0.0.1:${address.port}`
	await assert.rejects(
		new Promise<WebSocket>((resolve, reject) => {
			const ws = new WebSocket(`${wsBase}/api/terminal/connect?gatewayId=g9&label=g9`)
			ws.once('open', () => resolve(ws))
			ws.on('error', reject)
		}),
		'strict mode: anonymous gateway connect refused',
	)
	server.close()
	delete process.env.CF_ACCESS_TEAM_DOMAIN
	delete process.env.CF_ACCESS_AUD
}

console.log('gateway-identity.test.ts: all assertions passed')
process.exit(0)
