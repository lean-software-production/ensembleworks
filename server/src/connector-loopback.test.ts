// Booted parity gate (connector spec §7.5): relay-loopback.test.ts's assertions,
// but driving the REAL Bun connector subprocess instead of the test shim. Boot
// createSyncApp on an ephemeral port (the splice plane under test), spawn
// `bun cli/src/main.ts terminal connect --url … --gateway-id loopback` (a none
// instance, no auth), wait until GET /api/terminal/list shows the gateway, then
// a browser WS at /api/terminal/relay asserts: attached handshake, echo
// round-trip through the real tmux client, and a second viewer whose attached
// carries the SESSION size (not its request) + replays scrollback.
// Precondition: tmux on PATH. Run with: bun src/connector-loopback.test.ts
import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'

const execFileP = promisify(execFile)
const SESSION = `cbtest${Date.now().toString(36).slice(-4)}`
const GATEWAY = 'loopback'

const openSocket = (url: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.once('open', () => resolve(ws))
		ws.once('error', reject)
	})

/** First non-binary (control) frame, parsed. */
const firstText = (ws: WebSocket) =>
	new Promise<any>((resolve) => {
		const h = (data: Buffer, isBinary: boolean) => {
			if (isBinary) return
			ws.off('message', h)
			resolve(JSON.parse(data.toString()))
		}
		ws.on('message', h)
	})

/** Collect binary output until `needle` appears. */
function waitForOutput(ws: WebSocket, needle: string, timeoutMs = 15_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let acc = ''
		const handler = (data: Buffer, isBinary: boolean) => {
			if (!isBinary) return
			acc += data.toString()
			if (acc.includes(needle)) {
				clearTimeout(timer)
				ws.off('message', handler)
				resolve(acc)
			}
		}
		const timer = setTimeout(() => {
			ws.off('message', handler)
			reject(new Error(`timeout waiting for ${JSON.stringify(needle)}; got: ${acc.slice(-500)}`))
		}, timeoutMs)
		ws.on('message', handler)
	})
}

/** Poll GET /api/terminal/list until the connector has registered. */
async function waitForGateway(httpBase: string, id: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${httpBase}/api/terminal/list`)
			const body = (await res.json()) as { gateways: Array<{ gatewayId: string }> }
			if (body.gateways.some((g) => g.gatewayId === id)) return
		} catch {
			// server not ready / transient — retry
		}
		await new Promise((r) => setTimeout(r, 150))
	}
	throw new Error(`connector did not register gateway ${id} within ${timeoutMs}ms`)
}

async function main() {
	let connector: ChildProcess | null = null
	let server: http.Server | null = null

	try {
		// 1. Boot the sync app (the splice plane) on an ephemeral port.
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connector-loopback-test-'))
		const { server: appServer } = createSyncApp({ dataDir })
		server = appServer
		await new Promise<void>((resolve) => server!.listen(0, resolve))
		const port = (server.address() as { port: number }).port
		const httpBase = `http://127.0.0.1:${port}`
		const wsBase = `ws://127.0.0.1:${port}`

		// 2. Spawn the REAL connector. Resolve cli/src/main.ts relative to THIS
		// file (the runner launches suites from the repo root). --url is a global
		// flag (extractGlobals scans all argv); --gateway-id feeds the slot. A none
		// instance → no auth headers, matching the shim's anonymous connect.
		const cliMain = path.join(import.meta.dir, '..', '..', 'cli', 'src', 'main.ts')
		connector = spawn('bun', [cliMain, 'terminal', 'connect', '--url', httpBase, '--gateway-id', GATEWAY], {
			env: { ...process.env },
			stdio: ['ignore', 'inherit', 'inherit'],
		})
		connector.once('exit', (code) => {
			if (code && code !== 0) console.error(`[connector] exited early with code ${code}`)
		})

		// 3. Wait until connect-equals-register lands in the registry.
		await waitForGateway(httpBase, GATEWAY)

		// 4. Browser through the relay: attached handshake + echo round-trip.
		const relayUrl = `${wsBase}/api/terminal/relay?session=${SESSION}&gateway=${GATEWAY}&cols=80&rows=24`
		const b1 = await openSocket(relayUrl)
		const attached = await firstText(b1)
		assert.equal(attached.type, 'attached')
		const echoed = waitForOutput(b1, 'connector-roundtrip-ok')
		b1.send(JSON.stringify({ type: 'input', data: 'echo connector-roundtrip-ok\r' }))
		await echoed

		// 5. Second viewer: attached carries the SESSION size; replays scrollback.
		const b2 = await openSocket(relayUrl.replace('cols=80', 'cols=999'))
		const attached2 = await firstText(b2)
		assert.equal(attached2.type, 'attached')
		assert.equal(attached2.cols, 80, 'attached must carry session size, not the newcomer request')
		await waitForOutput(b2, 'connector-roundtrip-ok') // scrollback replay
		b1.close()
		b2.close()

		console.log('connector-loopback.test.ts: all assertions passed')
		console.log('ok: connector-loopback — real Bun connector splice: attached handshake, echo round-trip, second-viewer session-size + scrollback replay')
	} finally {
		connector?.kill()
		server?.close()
		await execFileP('tmux', ['kill-session', '-t', `canvas-${SESSION}`]).catch(() => {})
	}
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
