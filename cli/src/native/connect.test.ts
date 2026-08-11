// terminal connect slot (§10): resolveConnectConfig builds the ws url + defaults
// (gateway-id = a stable per-box id, NOT bare hostname; label = hostname); the
// slot prints the config on --dry-run (exit 0). A plain run now dispatches to
// runConnector (slice #5) — that real-dial path is network-free-incompatible,
// so it is pinned end-to-end by the booted server/src/connector-loopback.test.ts,
// not exercised here. Network-free. Run with: bun src/native/connect.test.ts
import assert from 'node:assert/strict'
import { hostname } from 'node:os'
import type { Conn } from '../resolve.ts'
import { connectSlot, resolveConnectConfig } from './connect.ts'

const conn: Conn = {
	url: 'https://canvas.example.com',
	room: 'team',
	auth: { method: 'service-token', tokenId: 'i', tokenSecret: 's' },
}

// Config resolution + defaults.
{
	const cfg = resolveConnectConfig(conn, {}, process.env)
	assert.equal(cfg.url, 'https://canvas.example.com')
	assert.equal(cfg.room, 'team')
	assert.equal(cfg.authMethod, 'service-token')
	assert.equal(cfg.label, hostname(), 'label defaults to hostname')
	assert.ok(cfg.gatewayId.startsWith(`${hostname()}-`), 'gateway-id is hostname + a stable per-box suffix')
	assert.notEqual(cfg.gatewayId, hostname(), 'gateway-id is NOT the bare hostname (would collide, tripping resolveGatewayOwner)')
	assert.ok(cfg.wsUrl.startsWith('wss://canvas.example.com/api/terminal/connect?'), 'wss ws url on the connect route')
	assert.ok(cfg.wsUrl.includes(`gatewayId=${encodeURIComponent(cfg.gatewayId)}`))
	assert.ok(cfg.wsUrl.includes(`label=${encodeURIComponent(cfg.label)}`))
	assert.equal(cfg.backend, 'tmux', 'backend defaults to tmux (legacy path unchanged)')
	assert.equal(cfg.repo, undefined, 'repo metadata absent by default')
	assert.equal(cfg.branch, undefined, 'branch metadata absent by default')
	assert.ok(!cfg.wsUrl.includes('repo='), 'no repo param when unset')
}

// Explicit flags win.
{
	const cfg = resolveConnectConfig(conn, { label: 'my-box', gatewayId: 'fixed-id', backend: 'pty' }, process.env)
	assert.equal(cfg.label, 'my-box')
	assert.equal(cfg.gatewayId, 'fixed-id')
	assert.equal(cfg.backend, 'pty', 'explicit --backend pty wins')

	const meta = resolveConnectConfig(conn, { repo: 'ensembleworks', branch: 'main' }, process.env)
	assert.equal(meta.repo, 'ensembleworks')
	assert.equal(meta.branch, 'main')
	assert.ok(meta.wsUrl.includes('repo=ensembleworks'), 'repo rides the connect URL (SP3 registration metadata)')
	assert.ok(meta.wsUrl.includes('branch=main'), 'branch rides the connect URL')
}

// http url → ws (not wss) for a none/localhost instance.
{
	const local: Conn = { url: 'http://localhost:8788', room: 'team', auth: { method: 'none' } }
	const cfg = resolveConnectConfig(local, {}, process.env)
	assert.ok(cfg.wsUrl.startsWith('ws://localhost:8788/api/terminal/connect?'))
}

// Slot behaviour: --dry-run prints JSON to stdout (exit 0). A plain run now
// dials the real connector (runConnector) — that path is covered end-to-end by
// the booted server/src/connector-loopback.test.ts, not here (network-free).
{
	const env = { ...process.env, ENSEMBLEWORKS_URL: 'http://localhost:8788' } as NodeJS.ProcessEnv
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	let dryCode: number
	try {
		dryCode = await connectSlot([], { refresh: false, json: false, dryRun: true, help: false }, env)
	} finally {
		;(process.stdout as any).write = realOut
	}
	assert.equal(dryCode, 0, '--dry-run exits 0')
	const printed = JSON.parse(outChunks.join(''))
	assert.equal(printed.url, 'http://localhost:8788')
	assert.ok(printed.wsUrl.startsWith('ws://localhost:8788/api/terminal/connect?'))
}

// --backend parsing: valid values pass through --dry-run; invalid rejects (exit-2 CliError).
{
	const env = { ...process.env, ENSEMBLEWORKS_URL: 'http://localhost:8788' } as NodeJS.ProcessEnv
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	try {
		const code = await connectSlot(['--backend', 'pty'], { refresh: false, json: false, dryRun: true, help: false }, env)
		assert.equal(code, 0)
	} finally {
		;(process.stdout as any).write = realOut
	}
	assert.equal(JSON.parse(outChunks.join('')).backend, 'pty', '--dry-run config carries the backend')

	await assert.rejects(
		() => connectSlot(['--backend', 'screen'], { refresh: false, json: false, dryRun: true, help: false }, env),
		/--backend must be tmux or pty/,
		'invalid backend value rejected',
	)
}

// --repo/--branch parse through the slot (decision #3 — codespace exec passes them).
{
	const env = { ...process.env, ENSEMBLEWORKS_URL: 'http://localhost:8788' } as NodeJS.ProcessEnv
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	try {
		const code = await connectSlot(['--repo', 'myrepo', '--branch', 'dev'], { refresh: false, json: false, dryRun: true, help: false }, env)
		assert.equal(code, 0)
	} finally {
		;(process.stdout as any).write = realOut
	}
	const printed = JSON.parse(outChunks.join(''))
	assert.equal(printed.repo, 'myrepo', '--dry-run config carries repo')
	assert.equal(printed.branch, 'dev', '--dry-run config carries branch')
}

console.log('ok: connect — ws url + stable-gateway-id/hostname defaults, flags win, --backend default/validation, --repo/--branch metadata, --dry-run config')
