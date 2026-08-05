// PTY-backend loopback (EW Codespaces coexistence spec §6.1/§7): the
// connector-loopback assertions, driving the REAL Bun connector with
// --backend pty — a raw login shell on a connector-owned PTY, NO tmux on the
// box. Boot createSyncApp on an ephemeral port, spawn
// `bun cli/src/main.ts terminal connect --url … --gateway-id ptyloop --backend pty`
// (a none instance, no auth), then through /api/terminal/relay assert:
// attached handshake, echo round-trip, second-viewer session-size + scrollback
// replay, and the exit broadcast ({type:'exit'} when the shell exits).
// Precondition: bash on PATH (tmux NOT required — that's the point).
// Run with: bun src/connector-pty-loopback.test.ts
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'

const SESSION = `ptytest${Date.now().toString(36).slice(-4)}`
const GATEWAY = 'ptyloop'

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

/** Resolve when a control frame matching pred arrives. */
const waitForText = (ws: WebSocket, pred: (m: any) => boolean, what: string, timeoutMs = 15_000) =>
	new Promise<any>((resolve, reject) => {
		const h = (data: Buffer, isBinary: boolean) => {
			if (isBinary) return
			const m = JSON.parse(data.toString())
			if (!pred(m)) return
			clearTimeout(timer)
			ws.off('message', h)
			resolve(m)
		}
		const timer = setTimeout(() => {
			ws.off('message', h)
			reject(new Error(`timeout waiting for ${what}`))
		}, timeoutMs)
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
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connector-pty-loopback-test-'))
		const { server: appServer } = createSyncApp({ dataDir })
		server = appServer
		await new Promise<void>((resolve) => server!.listen(0, resolve))
		const port = (server.address() as { port: number }).port
		const httpBase = `http://127.0.0.1:${port}`
		const wsBase = `ws://127.0.0.1:${port}`

		// 2. Spawn the REAL connector with --backend pty. SHELL forced to bash so
		// the spawned login shell is deterministic on any CI box.
		const cliMain = path.join(import.meta.dir, '..', '..', 'cli', 'src', 'main.ts')
		connector = spawn(
			'bun',
			[cliMain, 'terminal', 'connect', '--url', httpBase, '--gateway-id', GATEWAY, '--backend', 'pty'],
			{ env: { ...process.env, SHELL: 'bash' }, stdio: ['ignore', 'inherit', 'inherit'] },
		)
		connector.once('exit', (code) => {
			if (code && code !== 0) console.error(`[connector] exited early with code ${code}`)
		})

		// 3. Wait until connect-equals-register lands in the registry.
		await waitForGateway(httpBase, GATEWAY)

		// 4. Browser through the relay: attached handshake + echo round-trip
		// through a raw bash on a connector-owned PTY.
		const relayUrl = `${wsBase}/api/terminal/relay?session=${SESSION}&gateway=${GATEWAY}&cols=80&rows=24`
		const b1 = await openSocket(relayUrl)
		const attached = await firstText(b1)
		assert.equal(attached.type, 'attached')
		const echoed = waitForOutput(b1, 'pty-roundtrip-ok')
		b1.send(JSON.stringify({ type: 'input', data: 'echo pty-roundtrip-ok\r' }))
		await echoed

		// 5. Second viewer: attached carries the SESSION size; replays scrollback.
		const b2 = await openSocket(relayUrl.replace('cols=80', 'cols=999'))
		const attached2 = await firstText(b2)
		assert.equal(attached2.type, 'attached')
		assert.equal(attached2.cols, 80, 'attached must carry session size, not the newcomer request')
		await waitForOutput(b2, 'pty-roundtrip-ok') // scrollback replay

		// 6. Exit broadcast: `exit` ends the raw shell (no tmux server behind it) →
		// every viewer gets {type:'exit'}.
		const exit1 = waitForText(b1, (m) => m.type === 'exit', 'exit broadcast on b1')
		const exit2 = waitForText(b2, (m) => m.type === 'exit', 'exit broadcast on b2')
		b1.send(JSON.stringify({ type: 'input', data: 'exit\r' }))
		await Promise.all([exit1, exit2])
		b1.close()
		b2.close()

		console.log('connector-pty-loopback.test.ts: all assertions passed')
		console.log('ok: connector-pty-loopback — raw-PTY backend splice: attached handshake, echo round-trip, second-viewer replay, exit broadcast (no tmux)')
	} finally {
		connector?.kill()
		server?.close()
	}
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
