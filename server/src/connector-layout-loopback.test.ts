// Layout restore loopback (SP4 decision #4): boot createSyncApp, pre-write a
// v1 layout file (one session with a known cwd + a history marker), spawn the
// REAL connector with --backend pty and ENSEMBLEWORKS_LAYOUT_FILE, then via
// the real relay assert: (1) the restored session's first bytes are the
// persisted history; (2) `pwd` lands in the seeded cwd; then SIGTERM the
// connector and assert the layout file was rewritten with every live session.
// No docker, no external network — same in-glob pattern as
// connector-loopback.test.ts. Precondition: bash on PATH; linux (/proc cwd).
// Run with: bun src/connector-layout-loopback.test.ts
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'

const GATEWAY = 'layoutloop'
const RESTORED = 'layoutsess'

const openSocket = (url: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.once('open', () => resolve(ws))
		ws.once('error', reject)
	})

const firstText = (ws: WebSocket) =>
	new Promise<any>((resolve) => {
		const h = (data: Buffer, isBinary: boolean) => {
			if (isBinary) return
			ws.off('message', h)
			resolve(JSON.parse(data.toString()))
		}
		ws.on('message', h)
	})

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

async function waitForGateway(httpBase: string, id: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${httpBase}/api/terminal/list`)
			const body = (await res.json()) as { gateways: Array<{ gatewayId: string }> }
			if (body.gateways.some((g) => g.gatewayId === id)) return
		} catch {
			// server warming up — retry
		}
		await new Promise((r) => setTimeout(r, 150))
	}
	throw new Error(`gateway ${id} did not register within ${timeoutMs}ms`)
}

async function main() {
	let connector: ChildProcess | null = null
	let server: http.Server | null = null
	try {
		// 1. Boot the splice plane.
		const dataDir = mkdtempSync(path.join(os.tmpdir(), 'connector-layout-loopback-'))
		const { server: appServer } = createSyncApp({ dataDir })
		server = appServer
		await new Promise<void>((resolve) => server!.listen(0, resolve))
		const port = (server.address() as { port: number }).port
		const httpBase = `http://127.0.0.1:${port}`

		// 2. Pre-write a layout: one session, seeded cwd, a history marker.
		const seededCwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'layout-cwd-')))
		const layoutFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'layout-file-')), 'layout.json')
		writeFileSync(
			layoutFile,
			`${JSON.stringify({
				version: 1,
				sessions: [{ id: RESTORED, cwd: seededCwd, scrollbackTail: Buffer.from('=== RESTORED HISTORY ===\r\n').toString('base64') }],
			})}\n`,
		)

		// 3. Spawn the REAL connector: pty backend, layout file injected via env.
		const cliMain = path.join(import.meta.dir, '..', '..', 'cli', 'src', 'main.ts')
		connector = spawn(
			'bun',
			[cliMain, 'terminal', 'connect', '--url', httpBase, '--gateway-id', GATEWAY, '--backend', 'pty'],
			{ env: { ...process.env, SHELL: 'bash', ENSEMBLEWORKS_LAYOUT_FILE: layoutFile }, stdio: ['ignore', 'inherit', 'inherit'] },
		)
		await waitForGateway(httpBase, GATEWAY)

		// 4. Attach to the RESTORED session: history replays first, and the
		// respawned shell is sitting in the seeded cwd.
		const relay = (session: string) =>
			`ws://127.0.0.1:${port}/api/terminal/relay?session=${session}&gateway=${GATEWAY}&cols=80&rows=24`
		const b1 = await openSocket(relay(RESTORED))
		assert.equal((await firstText(b1)).type, 'attached')
		await waitForOutput(b1, '=== RESTORED HISTORY ===') // the persisted tail, replayed as history
		const pwdOut = waitForOutput(b1, seededCwd)
		b1.send(JSON.stringify({ type: 'input', data: 'pwd\r' }))
		await pwdOut // pwd printed the seeded cwd → respawned in the right directory

		// 5. A second, brand-new session (proves the snapshot below covers all
		// live sessions, not just restored ones).
		const b2 = await openSocket(relay('freshsess'))
		assert.equal((await firstText(b2)).type, 'attached')
		const fresh = waitForOutput(b2, 'fresh-ok')
		b2.send(JSON.stringify({ type: 'input', data: 'echo fresh-ok\r' }))
		await fresh
		b1.close()
		b2.close()

		// 6. SIGTERM → the connector snapshots BEFORE exiting (exit 0 on clean
		// signal), and the file now holds BOTH live sessions with real cwds.
		const exited = new Promise<number | null>((resolve) => connector!.once('exit', (code) => resolve(code)))
		connector.kill('SIGTERM')
		assert.equal(await exited, 0, 'clean SIGTERM exit')
		const rewritten = JSON.parse(readFileSync(layoutFile, 'utf8')) as {
			version: number
			sessions: Array<{ id: string; cwd?: string; scrollbackTail: string }>
		}
		assert.equal(rewritten.version, 1)
		assert.deepEqual(rewritten.sessions.map((s) => s.id).sort(), ['freshsess', RESTORED].sort(), 'snapshot covers every live session')
		const restoredEntry = rewritten.sessions.find((s) => s.id === RESTORED)!
		assert.equal(restoredEntry.cwd, seededCwd, 'cwd re-captured from /proc at snapshot time')
		assert.ok(restoredEntry.scrollbackTail.length > 0, 'tail persisted')
		connector = null

		console.log('connector-layout-loopback.test.ts: all assertions passed')
		console.log('ok: layout loopback — restored history + cwd through the real relay; SIGTERM rewrites the snapshot')
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
