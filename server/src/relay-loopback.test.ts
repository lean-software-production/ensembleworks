// Loopback-relay integration test (spike spec §7.2): the EXISTING Node
// terminal gateway, unmodified, reached through the relay plane via a
// test-only bridging shim. Also prints relay-vs-direct echo latency.
// Precondition: tmux on PATH. Run with: npx tsx src/relay-loopback.test.ts
import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'
import { encodeBinaryFrame } from './gateway-registry.ts'

const execFileP = promisify(execFile)
const TERM_PORT = 18789
const SESSION = `lbtest${Date.now().toString(36).slice(-4)}`

const openSocket = (url: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.once('open', () => resolve(ws))
		ws.once('error', reject)
	})

/** Collect binary output on a terminal-protocol socket until `needle` appears. */
function waitForOutput(ws: WebSocket, needle: string, timeoutMs = 10_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let acc = ''
		const handler = (data: Buffer, isBinary: boolean) => {
			if (!isBinary) return
			acc += data.toString()
			if (acc.includes(needle)) {
				clearTimeout(timer)
				ws.off('message', handler) // measureEcho loops — listeners must not accumulate
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

/** Test-only bridging shim: registers as gateway 'loopback' and proxies each
 * relay channel to the real gateway's /term/ws — a per-channel protocol
 * translator (relay framing ↔ plain frames). ~The existing gateway never
 * dials out, so this shim is what lets the splicer reach it. */
async function startShim(canvasWsBase: string) {
	const gw = await openSocket(`${canvasWsBase}/api/gateway/connect?gatewayId=loopback&label=Loopback`)
	const channels = new Map<number, WebSocket>()
	gw.on('message', (data, isBinary) => {
		if (isBinary) return // canvas→connector is all text
		const msg = JSON.parse(data.toString())
		if (msg.type === 'relay-open') {
			const term = new WebSocket(
				`ws://127.0.0.1:${TERM_PORT}/term/ws?session=${msg.sessionId}&cols=${msg.cols}&rows=${msg.rows}`
			)
			channels.set(msg.channelId, term)
			term.on('message', (tData, tBinary) => {
				if (tBinary) gw.send(encodeBinaryFrame(msg.channelId, tData as Buffer), { binary: true })
				else gw.send(JSON.stringify({ type: 'relay-msg', channelId: msg.channelId, msg: JSON.parse(tData.toString()) }))
			})
			term.on('close', () => {
				channels.delete(msg.channelId)
				if (gw.readyState === WebSocket.OPEN) gw.send(JSON.stringify({ type: 'relay-closed', channelId: msg.channelId }))
			})
		} else if (msg.type === 'relay-msg') {
			const term = channels.get(msg.channelId)
			if (term?.readyState === WebSocket.OPEN) term.send(JSON.stringify(msg.msg))
		} else if (msg.type === 'relay-close') {
			channels.get(msg.channelId)?.close()
			channels.delete(msg.channelId)
		}
	})
	return gw
}

/** Echo RTT: write a marker with `input`, time until it appears in output. */
async function measureEcho(ws: WebSocket, rounds: number): Promise<number[]> {
	const times: number[] = []
	for (let i = 0; i < rounds; i++) {
		const marker = `m${i}x`
		const t0 = performance.now()
		const seen = waitForOutput(ws, marker)
		ws.send(JSON.stringify({ type: 'input', data: marker }))
		await seen
		times.push(performance.now() - t0)
		// clear the line so markers don't accumulate in the prompt
		ws.send(JSON.stringify({ type: 'input', data: '\x15' })) // Ctrl-U clears the line so markers don't accumulate
		await new Promise((r) => setTimeout(r, 50))
	}
	return times.sort((a, b) => a - b)
}

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!

async function main() {
	let termGw: ChildProcess | null = null
	let server: http.Server | null = null
	let shim: WebSocket | null = null

	try {
		// 1. Spawn the real terminal gateway, unmodified, on a fixed test port.
		termGw = spawn('npx', ['tsx', 'src/terminal-gateway.ts'], {
			env: { ...process.env, PORT: String(TERM_PORT) },
			stdio: ['ignore', 'pipe', 'inherit'],
		})
		await new Promise<void>((resolve, reject) => {
			termGw!.stdout!.on('data', (d: Buffer) => {
				if (d.toString().includes('listening')) resolve()
			})
			termGw!.once('exit', () => reject(new Error('terminal gateway exited early')))
		})

		// 2. Boot the sync app + shim.
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'relay-loopback-test-'))
		const { server: appServer } = createSyncApp({ dataDir })
		server = appServer
		await new Promise<void>((resolve) => server!.listen(0, resolve))
		const port = (server.address() as { port: number }).port
		const wsBase = `ws://127.0.0.1:${port}`
		shim = await startShim(wsBase)

		// 3. Browser through the relay: attached handshake + echo round-trip.
		const relayUrl = `${wsBase}/api/term/relay?session=${SESSION}&gateway=loopback&cols=80&rows=24`
		const b1 = await openSocket(relayUrl)
		const attached = await new Promise<any>((resolve) => {
			b1.on('message', (data, isBinary) => {
				if (!isBinary) resolve(JSON.parse(data.toString()))
			})
		})
		assert.equal(attached.type, 'attached')
		const echoed = waitForOutput(b1, 'relay-roundtrip-ok')
		b1.send(JSON.stringify({ type: 'input', data: 'echo relay-roundtrip-ok\r' }))
		await echoed

		// 4. Second viewer: attached carries the SESSION's size; sees same bytes.
		const b2 = await openSocket(relayUrl.replace('cols=80', 'cols=999'))
		const attached2 = await new Promise<any>((resolve) => {
			b2.on('message', (data, isBinary) => {
				if (!isBinary) resolve(JSON.parse(data.toString()))
			})
		})
		assert.equal(attached2.type, 'attached')
		assert.equal(attached2.cols, 80, 'attached must carry session size, not the newcomer request')
		const replay = waitForOutput(b2, 'relay-roundtrip-ok') // scrollback replay
		await replay
		b2.close()

		// 5. Latency: relay vs direct, printed for the findings write-back.
		const relayTimes = await measureEcho(b1, 20)
		const direct = await openSocket(`ws://127.0.0.1:${TERM_PORT}/term/ws?session=${SESSION}&cols=80&rows=24`)
		await new Promise((r) => setTimeout(r, 300)) // let attach replay settle
		const directTimes = await measureEcho(direct, 20)
		console.log(`LATENCY relay  p50=${pct(relayTimes, 50).toFixed(1)}ms p95=${pct(relayTimes, 95).toFixed(1)}ms`)
		console.log(`LATENCY direct p50=${pct(directTimes, 50).toFixed(1)}ms p95=${pct(directTimes, 95).toFixed(1)}ms`)
		b1.close()
		direct.close()

		console.log('relay-loopback.test.ts: all assertions passed')
	} finally {
		shim?.close()
		server?.close()
		termGw?.kill()
		await execFileP('tmux', ['kill-session', '-t', `canvas-${SESSION}`]).catch(() => {})
	}
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
