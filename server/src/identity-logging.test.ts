// The Cloudflare Access identity binding logged on every authenticated
// connection — issue #55 Problem 1. Without it a `user=<uuid>` in the logs can
// never be traced back to a person.
//
// The assertions are on the JOIN, not on the string: an `[sync] identity` line
// is only useful if it names the same session= as the `[sync] open` line it
// enriches. It is deliberately a SEPARATE line emitted when the (fire-and-forget)
// Access resolution completes, so it never has to beat `[sync] open` in a race
// and the WS handshake is never delayed by it.
// Run with: bun src/identity-logging.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'

// Capture console.log while `fn` runs. `fn` receives the growing line buffer so
// it can wait on a line that only lands mid-run.
async function captureLog(fn: (lines: string[]) => Promise<void>): Promise<string[]> {
	const lines: string[] = []
	const original = console.log
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(' '))
	}
	try {
		await fn(lines)
		return lines
	} finally {
		console.log = original
	}
}

// Poll until `pred` matches a captured line, or give up. The identity line is
// asynchronous by design (it waits on Access resolution), so it can land after
// the socket is already open.
async function waitFor(lines: string[], pred: (l: string) => boolean, ms = 2000): Promise<string> {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		const hit = lines.find(pred)
		if (hit) return hit
		await new Promise((r) => setTimeout(r, 20))
	}
	assert.fail(`no matching log line within ${ms}ms. Captured:\n${lines.join('\n')}`)
}

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'identity-log-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((r) => server.listen(0, r))
	const { port } = server.address() as { port: number }

	// --- sync connect --------------------------------------------------------
	// Header-trust mode (CF_ACCESS_* unset) is the deployed default today.
	const sessionId = 'sess-abc'
	const userId = 'e2f1c0de-0000-4000-8000-000000000001'
	const lines = await captureLog(async (lines) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/room1?sessionId=${sessionId}&userId=${userId}`, {
			headers: { 'cf-access-authenticated-user-email': 'alice@example.com' },
		})
		await new Promise<void>((resolve, reject) => {
			ws.once('open', () => resolve())
			ws.once('error', reject)
		})
		await waitFor(lines, (l) => l.startsWith('[sync] identity'))
		ws.close()
	})

	const open = lines.find((l) => l.startsWith('[sync] open'))
	const identity = lines.find((l) => l.startsWith('[sync] identity'))
	assert.ok(open, 'sync open still logged')
	assert.ok(identity, 'sync connect logs an identity binding line')
	// The join: same room, user and session as the open line, plus the person.
	assert.ok(identity!.includes(`room=room1`), 'identity line names the room')
	assert.ok(identity!.includes(`user=${userId}`), 'identity line names the same user as open')
	assert.ok(identity!.includes(`session=${sessionId}`), 'identity line names the same session as open')
	assert.ok(open!.includes(`session=${sessionId}`), 'open line names that session')
	assert.ok(
		identity!.includes('person=alice@example.com verified=false'),
		`identity line carries the Access identity — got: ${identity}`,
	)

	// An unauthenticated connect (local dev) still logs, as person=none — silence
	// would be indistinguishable from a broken resolver.
	const anonLines = await captureLog(async (lines) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/room1?sessionId=sess-anon&userId=u-anon`)
		await new Promise<void>((resolve, reject) => {
			ws.once('open', () => resolve())
			ws.once('error', reject)
		})
		await waitFor(lines, (l) => l.startsWith('[sync] identity'))
		ws.close()
	})
	const anon = anonLines.find((l) => l.startsWith('[sync] identity'))
	assert.ok(anon?.includes('person=none'), `anonymous connect logs person=none — got: ${anon}`)

	// --- A/V token mint ------------------------------------------------------
	// LiveKit's own logs only ever see the participant UUID, so the binding has
	// to be logged where the token is minted.
	process.env.LIVEKIT_API_KEY = 'devkey'
	process.env.LIVEKIT_API_SECRET = 'devsecretdevsecretdevsecret00000'
	process.env.LIVEKIT_URL = 'wss://livekit.example'
	const avDataDir = await mkdtemp(path.join(os.tmpdir(), 'identity-log-av-'))
	const { server: avServer } = createSyncApp({ dataDir: avDataDir })
	await new Promise<void>((r) => avServer.listen(0, r))
	const { port: avPort } = avServer.address() as { port: number }

	const avLines = await captureLog(async () => {
		const res = await fetch(`http://127.0.0.1:${avPort}/api/av/token?room=room1&identity=${userId}&name=Alice`, {
			headers: { 'cf-access-authenticated-user-email': 'alice@example.com' },
		})
		assert.equal(res.status, 200)
		const body = (await res.json()) as { enabled: boolean }
		assert.equal(body.enabled, true, 'LiveKit configured for this leg')
	})
	const avLine = avLines.find((l) => l.startsWith('[av] token'))
	assert.ok(avLine, 'token mint logs an identity binding line')
	assert.ok(avLine!.includes(`identity=${userId}`), 'av line names the LiveKit participant identity')
	assert.ok(avLine!.includes('room=room1'), 'av line names the room')
	assert.ok(
		avLine!.includes('person=alice@example.com verified=false'),
		`av line carries the Access identity — got: ${avLine}`,
	)

	delete process.env.LIVEKIT_API_KEY
	delete process.env.LIVEKIT_API_SECRET
	delete process.env.LIVEKIT_URL
	server.close()
	avServer.close()
	console.log('ok: access identity binding logged on sync + av')
}

await main()
process.exit(0)
