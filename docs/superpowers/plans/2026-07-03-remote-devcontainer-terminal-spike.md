# Remote Devcontainer Terminal Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Go connector inside a devcontainer on a remote box hosts tmux terminals that appear as live multi-viewer terminal shapes on the canvas, via a relay plane on the sync server.

**Architecture:** The connector dials one outbound WSS to the sync server (`/api/gateway/connect` — connecting *is* registering); browsers reach remote terminals same-origin at `/api/term/relay?gateway=…`, spliced onto the gateway's WS as multiplexed channels. Terminal shapes gain an optional `gateway` prop (undefined = existing same-origin path, untouched). The connector is packaged as a devcontainer *feature*.

**Tech Stack:** Node/Express/ws (sync server, splicer), TypeScript/React/tldraw (client), Go ≥1.22 with only `creack/pty` + `coder/websocket` (connector), devcontainer CLI (packaging).

**Spec:** `docs/superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md` — read it before starting any task.

## Global Constraints

- Wire protocol constants (must match `server/src/terminal-gateway.ts` exactly): resize clamps **20–500 cols / 5–200 rows**; scrollback replay limit **256 KB**; heartbeat **20 s**; tmux session name prefix **`canvas-`**.
- Relay framing: `channelId` is a **uint32**, allocated monotonically per gateway connection by the splicer, JSON number in text frames, **4-byte big-endian prefix** on binary frames.
- Splicer backpressure: close a browser socket whose `bufferedAmount` exceeds **4 MB** (`4 * 1024 * 1024`).
- Resize authority: `attached` carries the **session's current** cols/rows; `relay-open` cols/rows are used only at session creation; a resize to the current (clamped) size is a **no-op with no broadcast**.
- Server tests are standalone scripts: `node:assert/strict`, `async function main()`, run with `npx tsx src/<name>.test.ts` from `server/`, exit non-zero on failure. Boot the app in-process via `createSyncApp({ dataDir })` with a `mkdtemp` data dir and `server.listen(0)`.
- Go tests: `go test ./...` from `gateway-go/`. No tmux dependency in automated tests (stub pty factory); tmux is exercised only by the manual demo.
- `gateway-go/` is **not** an npm workspace. `npm run typecheck` and `npm run build` from the repo root must stay green after every task.
- Existing `/term/ws` path, terminal-gateway.ts, and Caddyfiles are **not modified** by any task.
- Commit after every task with a conventional-commits message; end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Relay framing + gateway registry core (`server/src/gateway-registry.ts`)

Pure logic: binary frame encode/decode, the registry with replace-on-reconnect and socket-identity-checked deregistration, and the per-direction message splice functions. No HTTP/WS wiring yet — everything is testable with fake sockets.

**Files:**
- Create: `server/src/gateway-registry.ts`
- Test: `server/src/gateway-registry.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2–3):
  - `interface RelaySocket { readyState: number; bufferedAmount: number; send(data: string | Buffer, opts?: { binary?: boolean }): void; close(): void }` (structurally satisfied by `ws.WebSocket`)
  - `const WS_OPEN = 1`, `const BROWSER_BUFFER_LIMIT = 4 * 1024 * 1024`
  - `encodeBinaryFrame(channelId: number, payload: Buffer): Buffer` / `decodeBinaryFrame(frame: Buffer): { channelId: number; payload: Buffer } | null`
  - `class GatewayRegistry` with `connect(gatewayId, label, ws): GatewayEntry`, `disconnect(gatewayId, ws): void`, `get(gatewayId): GatewayEntry | undefined`, `list(): Array<{ gatewayId; label; relayOnly: true; connectedAt: number }>`
  - `openChannel(entry: GatewayEntry, browser: RelaySocket, sessionId: string, cols: number, rows: number): number` (sends `relay-open`, registers the channel)
  - `closeChannel(entry: GatewayEntry, channelId: number): void` (sends `relay-close`, forgets the channel)
  - `onBrowserMessage(entry, channelId, raw: string): void` (wraps as `relay-msg`)
  - `onGatewayFrame(entry, data: Buffer, isBinary: boolean): void` (routes binary by prefix / unwraps `relay-msg` / handles `relay-closed`; enforces `BROWSER_BUFFER_LIMIT`)
  - `interface GatewayEntry { gatewayId: string; label: string; ws: RelaySocket; connectedAt: number; channels: Map<number, RelaySocket>; nextChannelId: number }`

- [ ] **Step 1: Write the failing test**

Create `server/src/gateway-registry.test.ts`:

```typescript
// Unit tests for the relay framing + registry core (spike spec §1/§2/§5).
// Pure fakes — no sockets, no HTTP. Run with: npx tsx src/gateway-registry.test.ts
import assert from 'node:assert/strict'
import {
	BROWSER_BUFFER_LIMIT,
	GatewayRegistry,
	WS_OPEN,
	closeChannel,
	decodeBinaryFrame,
	encodeBinaryFrame,
	onBrowserMessage,
	onGatewayFrame,
	openChannel,
	type RelaySocket,
} from './gateway-registry.ts'

function fakeSocket() {
	const sent: Array<{ data: string | Buffer; binary: boolean }> = []
	const sock = {
		readyState: WS_OPEN,
		bufferedAmount: 0,
		closed: false,
		sent,
		send(data: string | Buffer, opts?: { binary?: boolean }) {
			sent.push({ data, binary: opts?.binary ?? false })
		},
		close() {
			this.closed = true
		},
	}
	return sock as typeof sock & RelaySocket
}

function lastJson(sock: ReturnType<typeof fakeSocket>) {
	return JSON.parse(String(sock.sent.at(-1)!.data))
}

async function main() {
	// --- binary framing round-trip ---
	const frame = encodeBinaryFrame(7, Buffer.from('hello'))
	assert.equal(frame.readUInt32BE(0), 7)
	const decoded = decodeBinaryFrame(frame)
	assert.ok(decoded)
	assert.equal(decoded.channelId, 7)
	assert.equal(decoded.payload.toString(), 'hello')
	assert.equal(decodeBinaryFrame(Buffer.from([0, 1])), null) // too short

	// --- connect / list ---
	const reg = new GatewayRegistry()
	const gw1 = fakeSocket()
	const entry1 = reg.connect('gw-a', 'Box A', gw1)
	assert.equal(reg.list()[0]!.gatewayId, 'gw-a')
	assert.equal(reg.list()[0]!.label, 'Box A')
	assert.equal(reg.list()[0]!.relayOnly, true)

	// --- openChannel sends relay-open with monotonic uint32 ids ---
	const browser1 = fakeSocket()
	const ch1 = openChannel(entry1, browser1, 'sess1', 80, 24)
	assert.equal(ch1, 1)
	assert.deepEqual(lastJson(gw1), {
		type: 'relay-open',
		channelId: 1,
		sessionId: 'sess1',
		cols: 80,
		rows: 24,
	})
	const ch2 = openChannel(entry1, fakeSocket(), 'sess1', 80, 24)
	assert.equal(ch2, 2)

	// --- browser → gateway wraps as relay-msg ---
	onBrowserMessage(entry1, ch1, JSON.stringify({ type: 'input', data: 'ls\r' }))
	assert.deepEqual(lastJson(gw1), {
		type: 'relay-msg',
		channelId: 1,
		msg: { type: 'input', data: 'ls\r' },
	})

	// --- gateway binary → browser binary, prefix stripped ---
	onGatewayFrame(entry1, encodeBinaryFrame(ch1, Buffer.from('out')), true)
	const bin = browser1.sent.at(-1)!
	assert.equal(bin.binary, true)
	assert.equal(bin.data.toString(), 'out')

	// --- gateway relay-msg → browser text, unwrapped ---
	onGatewayFrame(
		entry1,
		Buffer.from(JSON.stringify({ type: 'relay-msg', channelId: ch1, msg: { type: 'attached', cols: 80, rows: 24 } })),
		false
	)
	assert.deepEqual(lastJson(browser1), { type: 'attached', cols: 80, rows: 24 })

	// --- relay-closed closes the browser and forgets the channel ---
	onGatewayFrame(
		entry1,
		Buffer.from(JSON.stringify({ type: 'relay-closed', channelId: ch1 })),
		false
	)
	assert.equal(browser1.closed, true)
	assert.equal(entry1.channels.has(ch1), false)

	// --- backpressure: over-limit browser is closed, not written ---
	const slow = fakeSocket()
	const ch3 = openChannel(entry1, slow, 'sess1', 80, 24)
	slow.bufferedAmount = BROWSER_BUFFER_LIMIT + 1
	const sentBefore = slow.sent.length
	onGatewayFrame(entry1, encodeBinaryFrame(ch3, Buffer.from('x')), true)
	assert.equal(slow.closed, true)
	assert.equal(slow.sent.length, sentBefore)

	// --- closeChannel notifies the gateway ---
	const browser4 = fakeSocket()
	const ch4 = openChannel(entry1, browser4, 'sess1', 80, 24)
	closeChannel(entry1, ch4)
	assert.deepEqual(lastJson(gw1), { type: 'relay-close', channelId: ch4 })
	assert.equal(entry1.channels.has(ch4), false)

	// --- replace-on-reconnect: old ws closed, riding browsers closed ---
	const browser5 = fakeSocket()
	openChannel(entry1, browser5, 'sess1', 80, 24)
	const gw2 = fakeSocket()
	const entry2 = reg.connect('gw-a', 'Box A again', gw2)
	assert.equal(gw1.closed, true)
	assert.equal(browser5.closed, true)
	assert.equal(reg.get('gw-a'), entry2)

	// --- the replaced socket's async close must NOT deregister the new one ---
	reg.disconnect('gw-a', gw1) // stale close event arrives late
	assert.equal(reg.get('gw-a'), entry2, 'socket-identity check must protect the new entry')
	reg.disconnect('gw-a', gw2) // genuine close
	assert.equal(reg.get('gw-a'), undefined)
	assert.equal(reg.list().length, 0)

	console.log('gateway-registry.test.ts: all assertions passed')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `npx tsx src/gateway-registry.test.ts`
Expected: FAIL — `Cannot find module './gateway-registry.ts'`

- [ ] **Step 3: Write the implementation**

Create `server/src/gateway-registry.ts`:

```typescript
/**
 * Gateway registry + relay splice core for remote terminal gateways
 * (spike spec: docs/superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md).
 *
 * A remote connector dials ONE outbound WS to /api/gateway/connect; browsers
 * attach at /api/term/relay?gateway=… and are spliced onto that WS as
 * multiplexed channels. This module is the pure core — sockets are duck-typed
 * (RelaySocket) so the whole thing unit-tests with fakes; the HTTP/WS upgrade
 * wiring lives in createGatewayPlane() (added in the next slice).
 *
 * Wire protocol (canvas ↔ connector):
 *   text JSON  canvas→connector: {type:'relay-open',channelId,sessionId,cols,rows}
 *                                {type:'relay-close',channelId}
 *                                {type:'relay-msg',channelId,msg}   (browser's input/resize)
 *   text JSON  connector→canvas: {type:'relay-msg',channelId,msg}   (attached/resize/exit)
 *                                {type:'relay-closed',channelId}
 *   binary     connector→canvas: 4-byte BE uint32 channelId prefix + raw pty bytes
 */

export const WS_OPEN = 1
// A browser that can't drain 4 MB is closed rather than buffered forever —
// its reconnect-with-backoff re-attaches; full flow control is out of spike scope.
export const BROWSER_BUFFER_LIMIT = 4 * 1024 * 1024

// Structural socket type so ws.WebSocket satisfies it and tests can use fakes.
export interface RelaySocket {
	readyState: number
	bufferedAmount: number
	send(data: string | Buffer, opts?: { binary?: boolean }): void
	close(): void
}

export interface GatewayEntry {
	gatewayId: string
	label: string
	ws: RelaySocket
	connectedAt: number
	channels: Map<number, RelaySocket>
	nextChannelId: number
}

export function encodeBinaryFrame(channelId: number, payload: Buffer): Buffer {
	const prefix = Buffer.allocUnsafe(4)
	prefix.writeUInt32BE(channelId >>> 0, 0)
	return Buffer.concat([prefix, payload])
}

export function decodeBinaryFrame(frame: Buffer): { channelId: number; payload: Buffer } | null {
	if (frame.byteLength < 4) return null
	return { channelId: frame.readUInt32BE(0), payload: frame.subarray(4) }
}

export class GatewayRegistry {
	private gateways = new Map<string, GatewayEntry>()

	/** Connect-equals-register. A reconnect with a live id replaces it: the old
	 * socket and every browser riding it are closed (their client-side backoff
	 * re-establishes channels on the new connection). */
	connect(gatewayId: string, label: string, ws: RelaySocket): GatewayEntry {
		const existing = this.gateways.get(gatewayId)
		if (existing) {
			for (const browser of existing.channels.values()) browser.close()
			existing.channels.clear()
			existing.ws.close()
		}
		const entry: GatewayEntry = {
			gatewayId,
			label,
			ws,
			connectedAt: Date.now(),
			channels: new Map(),
			nextChannelId: 1,
		}
		this.gateways.set(gatewayId, entry)
		return entry
	}

	/** Deregistration checks SOCKET IDENTITY, not just id — the replaced
	 * socket's close event fires asynchronously after the new registration and
	 * must not delete it. */
	disconnect(gatewayId: string, ws: RelaySocket): void {
		const entry = this.gateways.get(gatewayId)
		if (!entry || entry.ws !== ws) return
		for (const browser of entry.channels.values()) browser.close()
		this.gateways.delete(gatewayId)
	}

	get(gatewayId: string): GatewayEntry | undefined {
		return this.gateways.get(gatewayId)
	}

	// Field names match distributed-terminals-design.md's envelope so the
	// dropdown survives the upgrade to the full design.
	list(): Array<{ gatewayId: string; label: string; relayOnly: true; connectedAt: number }> {
		return [...this.gateways.values()].map((e) => ({
			gatewayId: e.gatewayId,
			label: e.label,
			relayOnly: true,
			connectedAt: e.connectedAt,
		}))
	}
}

export function openChannel(
	entry: GatewayEntry,
	browser: RelaySocket,
	sessionId: string,
	cols: number,
	rows: number
): number {
	const channelId = entry.nextChannelId++
	entry.channels.set(channelId, browser)
	entry.ws.send(JSON.stringify({ type: 'relay-open', channelId, sessionId, cols, rows }))
	return channelId
}

export function closeChannel(entry: GatewayEntry, channelId: number): void {
	if (!entry.channels.delete(channelId)) return
	if (entry.ws.readyState === WS_OPEN) {
		entry.ws.send(JSON.stringify({ type: 'relay-close', channelId }))
	}
}

/** Browser → gateway: wrap the inner text message (input/resize) as relay-msg. */
export function onBrowserMessage(entry: GatewayEntry, channelId: number, raw: string): void {
	let msg: unknown
	try {
		msg = JSON.parse(raw)
	} catch {
		return
	}
	if (entry.ws.readyState === WS_OPEN) {
		entry.ws.send(JSON.stringify({ type: 'relay-msg', channelId, msg }))
	}
}

/** Gateway → browser: binary output by channel prefix; relay-msg unwrapped to a
 * text frame (the client dispatches on frame type); relay-closed closes. */
export function onGatewayFrame(entry: GatewayEntry, data: Buffer, isBinary: boolean): void {
	if (isBinary) {
		const decoded = decodeBinaryFrame(data)
		if (!decoded) return
		const browser = entry.channels.get(decoded.channelId)
		if (!browser || browser.readyState !== WS_OPEN) return
		if (browser.bufferedAmount > BROWSER_BUFFER_LIMIT) {
			entry.channels.delete(decoded.channelId)
			browser.close()
			return
		}
		browser.send(decoded.payload, { binary: true })
		return
	}
	let msg: { type?: string; channelId?: number; msg?: unknown }
	try {
		msg = JSON.parse(data.toString())
	} catch {
		return
	}
	if (typeof msg.channelId !== 'number') return
	const browser = entry.channels.get(msg.channelId)
	if (msg.type === 'relay-msg') {
		if (browser && browser.readyState === WS_OPEN) browser.send(JSON.stringify(msg.msg))
	} else if (msg.type === 'relay-closed') {
		entry.channels.delete(msg.channelId)
		browser?.close()
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `server/`): `npx tsx src/gateway-registry.test.ts`
Expected: `gateway-registry.test.ts: all assertions passed`

- [ ] **Step 5: Typecheck and commit**

Run from repo root: `npm run typecheck` — Expected: PASS.

```bash
git add server/src/gateway-registry.ts server/src/gateway-registry.test.ts
git commit -m "feat(relay): gateway registry + relay framing core"
```

---

### Task 2: Gateway plane — upgrade wiring, splicer, `/api/gateway/list` (modify `app.ts`)

**Files:**
- Modify: `server/src/gateway-registry.ts` (append `createGatewayPlane`)
- Modify: `server/src/app.ts` (two insertions: route + upgrade branch)
- Test: `server/src/gateway-plane.test.ts`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `createGatewayPlane(): { registry: GatewayRegistry; listHandler: (req, res) => void; handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean }`
  - HTTP: `GET /api/gateway/list` → `{ gateways: [{ gatewayId, label, relayOnly, connectedAt }] }`
  - WS: `/api/gateway/connect?gatewayId=…&label=…` (connector side), `/api/term/relay?session=…&gateway=…&cols=…&rows=…` (browser side). `gatewayId`/`session` sanitized with `/^[a-zA-Z0-9_-]{1,48}$/`; label defaults to gatewayId, sliced to 64 chars.

- [ ] **Step 1: Write the failing integration test**

Create `server/src/gateway-plane.test.ts`:

```typescript
// Integration test for the gateway plane: connect-equals-register, list,
// relay splicing end-to-end over real WebSockets against an in-process app.
// Run with: npx tsx src/gateway-plane.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'
import { encodeBinaryFrame } from './gateway-registry.ts'
import { makeTestClient } from './test-helpers.ts'

const openSocket = (url: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.once('open', () => resolve(ws))
		ws.once('error', reject)
	})

const nextMessage = (ws: WebSocket) =>
	new Promise<{ data: Buffer; isBinary: boolean }>((resolve) => {
		ws.once('message', (data, isBinary) => resolve({ data: data as Buffer, isBinary }))
	})

const closed = (ws: WebSocket) => new Promise<void>((resolve) => ws.once('close', () => resolve()))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-plane-test-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const base = `http://127.0.0.1:${address.port}`
	const wsBase = `ws://127.0.0.1:${address.port}`
	const { getJson } = makeTestClient(base)

	// 1. Empty list before any connector.
	assert.deepEqual((await getJson('/api/gateway/list')).body, { gateways: [] })

	// 2. Connect = register.
	const gw = await openSocket(`${wsBase}/api/gateway/connect?gatewayId=gw-test&label=Test%20Box`)
	const list = (await getJson('/api/gateway/list')).body
	assert.equal(list.gateways.length, 1)
	assert.equal(list.gateways[0].gatewayId, 'gw-test')
	assert.equal(list.gateways[0].label, 'Test Box')

	// 3. Browser attach → relay-open arrives at the gateway.
	const browser = await openSocket(`${wsBase}/api/term/relay?session=s1&gateway=gw-test&cols=80&rows=24`)
	const open = JSON.parse((await nextMessage(gw)).data.toString())
	assert.deepEqual(open, { type: 'relay-open', channelId: 1, sessionId: 's1', cols: 80, rows: 24 })

	// 4. Gateway relay-msg → browser text frame (unwrapped).
	gw.send(JSON.stringify({ type: 'relay-msg', channelId: 1, msg: { type: 'attached', cols: 80, rows: 24 } }))
	const attached = await nextMessage(browser)
	assert.equal(attached.isBinary, false)
	assert.deepEqual(JSON.parse(attached.data.toString()), { type: 'attached', cols: 80, rows: 24 })

	// 5. Gateway binary frame → browser binary, prefix stripped.
	gw.send(encodeBinaryFrame(1, Buffer.from('output!')), { binary: true })
	const out = await nextMessage(browser)
	assert.equal(out.isBinary, true)
	assert.equal(out.data.toString(), 'output!')

	// 6. Browser input → gateway relay-msg wrap.
	browser.send(JSON.stringify({ type: 'input', data: 'ls\r' }))
	const wrapped = JSON.parse((await nextMessage(gw)).data.toString())
	assert.deepEqual(wrapped, { type: 'relay-msg', channelId: 1, msg: { type: 'input', data: 'ls\r' } })

	// 7. Browser close → gateway sees relay-close.
	browser.close()
	const relayClose = JSON.parse((await nextMessage(gw)).data.toString())
	assert.deepEqual(relayClose, { type: 'relay-close', channelId: 1 })

	// 8. Replacement: new connect with same id closes old gw + riding browsers,
	//    and the old socket's late close does not deregister the new one.
	const browser2 = await openSocket(`${wsBase}/api/term/relay?session=s1&gateway=gw-test&cols=80&rows=24`)
	const gw2 = await openSocket(`${wsBase}/api/gateway/connect?gatewayId=gw-test&label=Test%20Box%20v2`)
	await closed(gw)
	await closed(browser2)
	await sleep(50) // let the old socket's close event land
	const list2 = (await getJson('/api/gateway/list')).body
	assert.equal(list2.gateways.length, 1, 'replacement survived the stale close event')
	assert.equal(list2.gateways[0].label, 'Test Box v2')

	// 9. Offline gateway → browser upgrade destroyed immediately.
	gw2.close()
	await sleep(50)
	await assert.rejects(openSocket(`${wsBase}/api/term/relay?session=s1&gateway=gw-test&cols=80&rows=24`))

	// 10. Bad ids rejected.
	await assert.rejects(openSocket(`${wsBase}/api/gateway/connect?gatewayId=bad%20id!`))

	server.close()
	console.log('gateway-plane.test.ts: all assertions passed')
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `npx tsx src/gateway-plane.test.ts`
Expected: FAIL at step 1 — `/api/gateway/list` returns 404 (route doesn't exist).

- [ ] **Step 3: Append `createGatewayPlane` to `server/src/gateway-registry.ts`**

Add at the top of the file, with the existing imports:

```typescript
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
```

Append at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// HTTP/WS wiring — createSyncApp mounts listHandler and calls handleUpgrade
// before its /sync matching. Kept here so app.ts gains only two lines.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-zA-Z0-9_-]{1,48}$/
const HEARTBEAT_INTERVAL_MS = 20_000

export function createGatewayPlane() {
	const registry = new GatewayRegistry()
	const wss = new WebSocketServer({ noServer: true })
	const alive = new WeakMap<WebSocket, boolean>()

	// Same half-open detection as the terminal gateway: unanswered ping → kill.
	const heartbeat = setInterval(() => {
		for (const ws of wss.clients) {
			if (ws.readyState !== ws.OPEN) continue
			if (alive.get(ws) === false) {
				ws.terminate()
				continue
			}
			alive.set(ws, false)
			ws.ping()
		}
	}, HEARTBEAT_INTERVAL_MS)
	heartbeat.unref()

	function accept(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<WebSocket> {
		;(socket as Socket).setNoDelay(true)
		return new Promise((resolve) => {
			wss.handleUpgrade(req, socket, head, (ws) => {
				alive.set(ws, true)
				ws.on('pong', () => alive.set(ws, true))
				resolve(ws)
			})
		})
	}

	return {
		registry,

		listHandler(_req: unknown, res: { json(body: unknown): void }) {
			res.json({ gateways: registry.list() })
		},

		/** Returns true when it owned the upgrade (matched path), else false. */
		handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
			if (url.pathname === '/api/gateway/connect') {
				const gatewayId = url.searchParams.get('gatewayId') ?? ''
				if (!ID_RE.test(gatewayId)) {
					socket.destroy()
					return true
				}
				const label = (url.searchParams.get('label') || gatewayId).slice(0, 64)
				void accept(req, socket, head).then((ws) => {
					const entry = registry.connect(gatewayId, label, ws)
					console.log(`[gateway ${gatewayId}] connected (${label})`)
					ws.on('message', (data, isBinary) => onGatewayFrame(entry, data as Buffer, isBinary))
					ws.on('close', () => {
						registry.disconnect(gatewayId, ws)
						console.log(`[gateway ${gatewayId}] disconnected`)
					})
				})
				return true
			}

			if (url.pathname === '/api/term/relay') {
				const sessionId = url.searchParams.get('session') ?? ''
				const gatewayId = url.searchParams.get('gateway') ?? ''
				const cols = Number(url.searchParams.get('cols') ?? 80) || 80
				const rows = Number(url.searchParams.get('rows') ?? 24) || 24
				const entry = registry.get(gatewayId)
				if (!ID_RE.test(sessionId) || !entry || entry.ws.readyState !== WS_OPEN) {
					socket.destroy() // offline gateway → immediate destroy (client backoff handles it)
					return true
				}
				void accept(req, socket, head).then((ws) => {
					const channelId = openChannel(entry, ws, sessionId, cols, rows)
					ws.on('message', (raw, isBinary) => {
						if (isBinary) return // browsers never send binary (matches terminal-gateway.ts)
						onBrowserMessage(entry, channelId, raw.toString())
					})
					ws.on('close', () => closeChannel(entry, channelId))
				})
				return true
			}

			return false
		},
	}
}
```

- [ ] **Step 4: Wire into `server/src/app.ts` (two insertions)**

Insertion A — import (with the other local imports near the top of app.ts):

```typescript
import { createGatewayPlane } from './gateway-registry.ts'
```

Insertion B — inside `createSyncApp`, directly after the `GET /api/health` route handler, add the plane + route:

```typescript
	// Remote terminal gateways (spike): connect-equals-register + relay splicer.
	// See docs/superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md
	const gatewayPlane = createGatewayPlane()
	app.get('/api/gateway/list', gatewayPlane.listHandler)
```

Insertion C — in the `server.on('upgrade', …)` handler (around `app.ts:1237`), add the plane branch as the FIRST thing after the `url` is parsed, before the `/sync` match:

```typescript
	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '', 'http://internal')
		if (gatewayPlane.handleUpgrade(req, socket, head, url)) return
		const match = url.pathname.match(/^\/sync\/([^/]+)$/)
		// … existing code unchanged from here …
```

- [ ] **Step 5: Run test to verify it passes**

Run (from `server/`): `npx tsx src/gateway-plane.test.ts`
Expected: `gateway-plane.test.ts: all assertions passed`

- [ ] **Step 6: Regression-check the existing suites and typecheck**

Run (from `server/`):
```bash
npx tsx src/canvas-api.test.ts && npx tsx src/gateway-registry.test.ts
```
Run (from repo root): `npm run typecheck`
Expected: all PASS — the upgrade handler change must not disturb `/sync`.

- [ ] **Step 7: Commit**

```bash
git add server/src/gateway-registry.ts server/src/gateway-plane.test.ts server/src/app.ts
git commit -m "feat(relay): gateway connect/list endpoints + relay splicer wired into sync server"
```

---

### Task 3: Loopback-relay integration test + latency harness

Prove the plane against the *existing, unmodified* Node terminal gateway via a test-only bridging shim, and print the relay-vs-direct echo latency numbers (spike decision question 2). **Precondition: tmux installed** (dev boxes/ash have it).

**Files:**
- Test: `server/src/relay-loopback.test.ts`

**Interfaces:**
- Consumes: Task 2's WS endpoints; the existing `terminal-gateway.ts` spawned as a child process on port 18789.
- Produces: nothing for later tasks — this is the known-good-gateway checkpoint and the loopback latency harness.

- [ ] **Step 1: Write the test (fails until the shim logic inside it is correct — this task is test-is-the-deliverable)**

Create `server/src/relay-loopback.test.ts`:

```typescript
// Loopback-relay integration test (spike spec §7.2): the EXISTING Node
// terminal gateway, unmodified, reached through the relay plane via a
// test-only bridging shim. Also prints relay-vs-direct echo latency.
// Precondition: tmux on PATH. Run with: npx tsx src/relay-loopback.test.ts
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
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
	// 1. Spawn the real terminal gateway, unmodified, on a fixed test port.
	const termGw = spawn('npx', ['tsx', 'src/terminal-gateway.ts'], {
		env: { ...process.env, PORT: String(TERM_PORT) },
		stdio: ['ignore', 'pipe', 'inherit'],
	})
	await new Promise<void>((resolve, reject) => {
		termGw.stdout.on('data', (d: Buffer) => {
			if (d.toString().includes('listening')) resolve()
		})
		termGw.once('exit', () => reject(new Error('terminal gateway exited early')))
	})

	// 2. Boot the sync app + shim.
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'relay-loopback-test-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const port = (server.address() as { port: number }).port
	const wsBase = `ws://127.0.0.1:${port}`
	const shim = await startShim(wsBase)

	try {
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
		shim.close()
		server.close()
		termGw.kill()
		await execFileP('tmux', ['kill-session', '-t', `canvas-${SESSION}`]).catch(() => {})
	}
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
```

- [ ] **Step 2: Run it**

Run (from `server/`): `npx tsx src/relay-loopback.test.ts`
Expected: two `LATENCY …` lines and `all assertions passed`. If `attached must carry session size` fails, the bug is in the splicer or shim, NOT the gateway — the existing gateway is the known-good reference.

- [ ] **Step 3: Commit**

```bash
git add server/src/relay-loopback.test.ts
git commit -m "test(relay): loopback integration test against unmodified gateway + latency harness"
```

---

### Task 4: Client — `gateway` prop + relay URL builder + Vite `ws:true`

**Files:**
- Create: `client/src/terminal/wsUrl.ts`
- Test: `client/src/terminal/wsUrl.test.ts`
- Modify: `client/src/terminal/TerminalShapeUtil.tsx` (props interface, static props, delete local `termWsUrl`, update the call site at ~line 316)
- Modify: `server/src/schema.ts` (terminal props)
- Modify: `client/vite.config.ts` (`/api` proxy gains `ws: true`)

**Interfaces:**
- Produces (consumed by Task 5):
  - `TerminalShapeProps` gains `gateway?: string`
  - `buildTermWsUrl(loc: { protocol: string; host: string }, sessionId: string, cols: number, rows: number, gateway?: string): string` in `client/src/terminal/wsUrl.ts`, plus `termWsUrl(sessionId, cols, rows, gateway?)` wrapper using `window.location`.

- [ ] **Step 1: Write the failing test**

Create `client/src/terminal/wsUrl.test.ts`:

```typescript
// Run with: npx tsx src/terminal/wsUrl.test.ts   (from client/)
import assert from 'node:assert/strict'
import { buildTermWsUrl } from './wsUrl.ts'

const loc = { protocol: 'https:', host: 'canvas.example.com' }

// No gateway → existing same-origin path, byte-identical to today.
assert.equal(
	buildTermWsUrl(loc, 'abc1', 80, 24),
	'wss://canvas.example.com/term/ws?session=abc1&cols=80&rows=24'
)

// Gateway set → relay path under /api (prod Caddy routes /term* elsewhere).
assert.equal(
	buildTermWsUrl(loc, 'abc1', 80, 24, 'gw-box'),
	'wss://canvas.example.com/api/term/relay?session=abc1&gateway=gw-box&cols=80&rows=24'
)

// http origin → ws scheme.
assert.equal(
	buildTermWsUrl({ protocol: 'http:', host: 'localhost:5173' }, 'x', 10, 5, 'g'),
	'ws://localhost:5173/api/term/relay?session=x&gateway=g&cols=10&rows=5'
)

console.log('wsUrl.test.ts: all assertions passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `client/`): `npx tsx src/terminal/wsUrl.test.ts`
Expected: FAIL — `Cannot find module './wsUrl.ts'`

- [ ] **Step 3: Implement `client/src/terminal/wsUrl.ts`**

```typescript
/**
 * Terminal WebSocket URL resolution. Undefined gateway → the existing
 * same-origin /term/ws path (unchanged). A gateway id → the relay path,
 * which lives under /api because prod Caddy routes /term* to the co-located
 * gateway on :8789 while /api* reaches the sync server (spike spec §1).
 */
export function buildTermWsUrl(
	loc: { protocol: string; host: string },
	sessionId: string,
	cols: number,
	rows: number,
	gateway?: string
): string {
	const proto = loc.protocol === 'https:' ? 'wss' : 'ws'
	if (gateway) {
		return `${proto}://${loc.host}/api/term/relay?session=${sessionId}&gateway=${encodeURIComponent(gateway)}&cols=${cols}&rows=${rows}`
	}
	return `${proto}://${loc.host}/term/ws?session=${sessionId}&cols=${cols}&rows=${rows}`
}

export function termWsUrl(sessionId: string, cols: number, rows: number, gateway?: string): string {
	return buildTermWsUrl(location, sessionId, cols, rows, gateway)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `client/`): `npx tsx src/terminal/wsUrl.test.ts`
Expected: `wsUrl.test.ts: all assertions passed`

- [ ] **Step 5: Wire the shape prop through `TerminalShapeUtil.tsx`**

Three edits:

(a) Extend the props interface (~line 36):

```typescript
export interface TerminalShapeProps {
	w: number
	h: number
	sessionId: string
	title: string
	// Optional status light set by agents via POST /api/terminal-status.
	status?: string
	// Remote gateway id (spike): undefined = same-origin gateway, zero
	// migration for existing rooms. See /api/gateway/list.
	gateway?: string
}
```

(b) Extend the static props validator (~line 82) — add one line after `status`:

```typescript
		status: T.string.optional(),
		gateway: T.string.optional(),
```

(c) Delete the local `termWsUrl` function (~lines 122–125) and import from the new module instead — add to the existing imports:

```typescript
import { termWsUrl } from './wsUrl'
```

then update the connect call site (~line 316):

```typescript
			const ws = new WebSocket(
				termWsUrl(shape.props.sessionId, term.cols, term.rows, shape.props.gateway)
			)
```

- [ ] **Step 6: Mirror the prop in `server/src/schema.ts`**

In `terminalShapeProps` (line 10), add after `status`:

```typescript
	// Remote gateway id (spike); optional so existing rooms need no migration.
	// Keep in sync with client/src/terminal/TerminalShapeUtil.tsx
	gateway: T.string.optional(),
```

- [ ] **Step 7: Vite dev proxy — `/api` must forward WS upgrades**

In `client/vite.config.ts`, change the `/api` proxy line to:

```typescript
			'/api': { target: 'http://localhost:8788', ws: true },
```

- [ ] **Step 8: Typecheck, regression, commit**

Run from repo root: `npm run typecheck` — Expected: PASS (all three workspaces).
Run (from `server/`): `npx tsx src/canvas-api.test.ts` — Expected: PASS (schema change is additive).

```bash
git add client/src/terminal/wsUrl.ts client/src/terminal/wsUrl.test.ts \
  client/src/terminal/TerminalShapeUtil.tsx server/src/schema.ts client/vite.config.ts
git commit -m "feat(terminal): optional gateway prop routes shapes through the relay path"
```

---

### Task 5: Client — gateway dropdown on "New terminal"

Move `createTerminalShape` into the terminal module (avoids a ui.tsx circular import), extend it with a `gateway` argument, and replace the plain toolbar item with a dropdown fed by `/api/gateway/list`.

**Files:**
- Create: `client/src/terminal/createTerminalShape.ts`
- Create: `client/src/terminal/TerminalToolbarItem.tsx`
- Modify: `client/src/ui.tsx` (delete the old `createTerminalShape`, delete the `tools['terminal']` entry, swap the toolbar item)

**Interfaces:**
- Consumes: `TerminalShapeProps.gateway` (Task 4); `GET /api/gateway/list` → `{ gateways: [{ gatewayId, label, relayOnly, connectedAt }] }` (Task 2).
- Produces: `createTerminalShape(editor: Editor, gateway?: string): void`.

- [ ] **Step 1: Create `client/src/terminal/createTerminalShape.ts`** (moved verbatim from ui.tsx, plus the `gateway` parameter):

```typescript
import { createShapeId, type Editor } from 'tldraw'

export function createTerminalShape(editor: Editor, gateway?: string) {
	// Short, human-typeable ID — it is also the tmux session name suffix, so
	// `ssh vm` + `tmux attach -t canvas-<id>` works.
	const sessionId = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'terminal',
		x: x - 360,
		y: y - 220,
		props: { w: 720, h: 440, sessionId, title: 'terminal', ...(gateway ? { gateway } : {}) },
	})
	editor.setSelectedShapes([id])
}
```

- [ ] **Step 2: Create `client/src/terminal/TerminalToolbarItem.tsx`**

```tsx
/**
 * "New terminal" toolbar button with a gateway picker (spike spec §4).
 * Plain click = default same-origin terminal; the dropdown lists remote
 * gateways from /api/gateway/list, fetched on open (no caching/polling).
 */
import { useState } from 'react'
import {
	TldrawUiButton,
	TldrawUiButtonIcon,
	TldrawUiDropdownMenuContent,
	TldrawUiDropdownMenuItem,
	TldrawUiDropdownMenuRoot,
	TldrawUiDropdownMenuTrigger,
	useEditor,
} from 'tldraw'
import { createTerminalShape } from './createTerminalShape'

interface GatewayInfo {
	gatewayId: string
	label: string
}

export function TerminalToolbarItem() {
	const editor = useEditor()
	const [gateways, setGateways] = useState<GatewayInfo[]>([])

	const refresh = () => {
		fetch('/api/gateway/list')
			.then((res) => res.json())
			.then((body: { gateways: GatewayInfo[] }) => setGateways(body.gateways))
			.catch(() => setGateways([]))
	}

	return (
		<TldrawUiDropdownMenuRoot id="terminal-gateway">
			<TldrawUiDropdownMenuTrigger>
				<TldrawUiButton type="icon" title="New terminal" onPointerDown={refresh}>
					<TldrawUiButtonIcon icon="tool-frame" />
				</TldrawUiButton>
			</TldrawUiDropdownMenuTrigger>
			<TldrawUiDropdownMenuContent side="top" align="center">
				<TldrawUiDropdownMenuItem>
					<TldrawUiButton type="menu" onClick={() => createTerminalShape(editor)}>
						This canvas (default)
					</TldrawUiButton>
				</TldrawUiDropdownMenuItem>
				{gateways.map((gw) => (
					<TldrawUiDropdownMenuItem key={gw.gatewayId}>
						<TldrawUiButton type="menu" onClick={() => createTerminalShape(editor, gw.gatewayId)}>
							{gw.label}
						</TldrawUiButton>
					</TldrawUiDropdownMenuItem>
				))}
			</TldrawUiDropdownMenuContent>
		</TldrawUiDropdownMenuRoot>
	)
}
```

Note: `TldrawUiDropdownMenu*` components are tldraw v5 exports (used by tldraw's own menus). If the import fails at typecheck, check the exact names with `grep -r 'TldrawUiDropdownMenu' node_modules/tldraw/dist-cjs/index.d.ts` — do NOT hand-roll a popover before checking.

- [ ] **Step 3: Rewire `client/src/ui.tsx`**

Three edits:
(a) Delete the whole `createTerminalShape` function; add imports:

```typescript
import { createTerminalShape } from './terminal/createTerminalShape'
import { TerminalToolbarItem } from './terminal/TerminalToolbarItem'
```

(`createTerminalShape` stays imported because nothing else in ui.tsx uses it — if the import is unused after (b), drop it.)

(b) Delete the `tools['terminal'] = { … }` block from `uiOverrides.tools` (the dropdown handles both creation paths now).

(c) In `ToolbarWithTerminal`, replace

```tsx
			{tools['terminal'] && <TldrawUiMenuItem {...tools['terminal']} />}
```

with

```tsx
			<TerminalToolbarItem />
```

- [ ] **Step 4: Typecheck + manual verification**

Run from repo root: `npm run typecheck` — Expected: PASS.
Manual check (dev stack per `dev-tmux-stack` conventions, or `npm run dev`): toolbar shows the terminal button; click → dropdown with "This canvas (default)"; selecting it creates a working local terminal (regression); with the Task 3 loopback shim running, "Loopback" appears and creates a terminal whose bytes flow through the relay.

- [ ] **Step 5: Commit**

```bash
git add client/src/terminal/createTerminalShape.ts client/src/terminal/TerminalToolbarItem.tsx client/src/ui.tsx
git commit -m "feat(terminal): gateway picker dropdown on the New terminal button"
```

---

### Task 6: Go module + `protocol` package

**Files:**
- Create: `gateway-go/go.mod`
- Create: `gateway-go/protocol/protocol.go`
- Test: `gateway-go/protocol/protocol_test.go`

**Interfaces:**
- Produces (consumed by Tasks 7–8):
  - `type Control struct { Type string; ChannelID uint32; SessionID string; Cols, Rows int; Msg json.RawMessage }` (JSON tags matching the Node side exactly: `type`, `channelId`, `sessionId`, `cols`, `rows`, `msg`)
  - `type Inner struct { Type string; Data string; Cols, Rows int }` (tags `type`, `data`, `cols`, `rows`; omitempty on all but Type)
  - `EncodeBinary(channelID uint32, payload []byte) []byte`
  - `DecodeBinary(frame []byte) (channelID uint32, payload []byte, ok bool)`
  - `WrapMsg(channelID uint32, inner any) ([]byte, error)` → relay-msg JSON
  - `RelayClosed(channelID uint32) []byte`

- [ ] **Step 1: Initialise the module**

```bash
mkdir -p gateway-go/protocol && cd gateway-go && go mod init github.com/lean-software-production/ensembleworks/gateway-go
```

- [ ] **Step 2: Write the failing test**

Create `gateway-go/protocol/protocol_test.go`:

```go
package protocol

import (
	"encoding/json"
	"testing"
)

func TestBinaryRoundTrip(t *testing.T) {
	frame := EncodeBinary(7, []byte("hello"))
	id, payload, ok := DecodeBinary(frame)
	if !ok || id != 7 || string(payload) != "hello" {
		t.Fatalf("round trip failed: ok=%v id=%d payload=%q", ok, id, payload)
	}
	if _, _, ok := DecodeBinary([]byte{0, 1}); ok {
		t.Fatal("short frame must not decode")
	}
}

func TestControlJSONWireNames(t *testing.T) {
	// Must parse exactly what the Node splicer sends.
	cases := []struct {
		raw  string
		want Control
	}{
		{`{"type":"relay-open","channelId":1,"sessionId":"s1","cols":80,"rows":24}`,
			Control{Type: "relay-open", ChannelID: 1, SessionID: "s1", Cols: 80, Rows: 24}},
		{`{"type":"relay-close","channelId":2}`, Control{Type: "relay-close", ChannelID: 2}},
		{`{"type":"relay-msg","channelId":3,"msg":{"type":"input","data":"ls\r"}}`,
			Control{Type: "relay-msg", ChannelID: 3, Msg: json.RawMessage(`{"type":"input","data":"ls\r"}`)}},
	}
	for _, c := range cases {
		var got Control
		if err := json.Unmarshal([]byte(c.raw), &got); err != nil {
			t.Fatalf("unmarshal %s: %v", c.raw, err)
		}
		if got.Type != c.want.Type || got.ChannelID != c.want.ChannelID ||
			got.SessionID != c.want.SessionID || got.Cols != c.want.Cols || got.Rows != c.want.Rows {
			t.Fatalf("got %+v want %+v", got, c.want)
		}
		if c.want.Msg != nil && string(got.Msg) != string(c.want.Msg) {
			t.Fatalf("msg: got %s want %s", got.Msg, c.want.Msg)
		}
	}
}

func TestInnerParse(t *testing.T) {
	var in Inner
	if err := json.Unmarshal([]byte(`{"type":"resize","cols":120,"rows":40}`), &in); err != nil {
		t.Fatal(err)
	}
	if in.Type != "resize" || in.Cols != 120 || in.Rows != 40 {
		t.Fatalf("got %+v", in)
	}
}

func TestWrapMsg(t *testing.T) {
	b, err := WrapMsg(5, Inner{Type: "attached", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"relay-msg","channelId":5,"msg":{"type":"attached","cols":80,"rows":24}}`
	if string(b) != want {
		t.Fatalf("got %s want %s", b, want)
	}
	if string(RelayClosed(9)) != `{"type":"relay-closed","channelId":9}` {
		t.Fatalf("relay-closed encoding wrong: %s", RelayClosed(9))
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `gateway-go/`): `go test ./protocol`
Expected: FAIL — undefined symbols.

- [ ] **Step 4: Implement `gateway-go/protocol/protocol.go`**

```go
// Package protocol defines the relay wire protocol shared with the Node
// splicer (server/src/gateway-registry.ts) and the inner terminal protocol
// shared with the browser client. Field names are the wire contract — change
// nothing without changing both sides.
package protocol

import (
	"encoding/binary"
	"encoding/json"
)

// Control is a canvas↔connector text frame.
type Control struct {
	Type      string          `json:"type"`
	ChannelID uint32          `json:"channelId"`
	SessionID string          `json:"sessionId,omitempty"`
	Cols      int             `json:"cols,omitempty"`
	Rows      int             `json:"rows,omitempty"`
	Msg       json.RawMessage `json:"msg,omitempty"`
}

// Inner is a browser↔terminal message (input/resize up; attached/resize/exit down).
type Inner struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

// EncodeBinary prefixes pty output with the 4-byte big-endian channel id.
func EncodeBinary(channelID uint32, payload []byte) []byte {
	frame := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(frame, channelID)
	copy(frame[4:], payload)
	return frame
}

// DecodeBinary splits a prefixed frame. ok=false for frames under 4 bytes.
func DecodeBinary(frame []byte) (uint32, []byte, bool) {
	if len(frame) < 4 {
		return 0, nil, false
	}
	return binary.BigEndian.Uint32(frame), frame[4:], true
}

// WrapMsg encodes an inner message as a connector→canvas relay-msg frame.
func WrapMsg(channelID uint32, inner any) ([]byte, error) {
	raw, err := json.Marshal(inner)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Control{Type: "relay-msg", ChannelID: channelID, Msg: raw})
}

// RelayClosed encodes the connector→canvas channel-teardown notification.
func RelayClosed(channelID uint32) []byte {
	b, _ := json.Marshal(Control{Type: "relay-closed", ChannelID: channelID})
	return b
}
```

- [ ] **Step 5: Run test to verify it passes**

Run (from `gateway-go/`): `go test ./protocol`
Expected: `ok  …/protocol`

- [ ] **Step 6: Commit**

```bash
git add gateway-go/go.mod gateway-go/protocol/
git commit -m "feat(gateway-go): module init + relay/inner protocol package"
```

---

### Task 7: Go `session` package — tmux sessions, ring buffer, fan-out, concurrency invariants

**Files:**
- Create: `gateway-go/session/session.go`
- Create: `gateway-go/session/tmux.go`
- Test: `gateway-go/session/session_test.go`

**Interfaces:**
- Consumes: `protocol.Inner`.
- Produces (consumed by Task 8):
  - `type Pty interface { io.ReadWriter; Resize(cols, rows int) error; Close() error }`
  - `type PtyFactory func(sessionID string, cols, rows int) (Pty, error)`
  - `type Sink interface { SendMsg(inner protocol.Inner); SendOutput(payload []byte); Close() }`
  - `NewManager(spawn PtyFactory) *Manager`
  - `(m *Manager) Attach(sessionID string, channelID uint32, cols, rows int, sink Sink) error` — get-or-create under the manager mutex; `attached` (session's current size) + ring replay + subscribe atomically under the session mutex
  - `(m *Manager) Input(sessionID string, channelID uint32, data string)`
  - `(m *Manager) Resize(sessionID string, cols, rows int)` — clamp 20–500/5–200, dedup no-op, broadcast
  - `(m *Manager) Detach(sessionID string, channelID uint32)`
  - `(m *Manager) DetachAll()` — used on relay disconnect; never touches the pty
  - `TmuxFactory(tmuxConf string) PtyFactory` in `tmux.go`

- [ ] **Step 1: Write the failing test**

Create `gateway-go/session/session_test.go`:

```go
package session

import (
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lean-software-production/ensembleworks/gateway-go/protocol"
)

// stubPty echoes writes back as output and records resizes.
type stubPty struct {
	mu      sync.Mutex
	out     chan []byte
	resizes []([2]int)
	closed  bool
}

func newStubPty() *stubPty { return &stubPty{out: make(chan []byte, 64)} }

func (p *stubPty) Read(b []byte) (int, error) {
	chunk, ok := <-p.out
	if !ok {
		return 0, io.EOF
	}
	return copy(b, chunk), nil
}
func (p *stubPty) Write(b []byte) (int, error) { p.out <- append([]byte("echo:"), b...); return len(b), nil }
func (p *stubPty) Resize(cols, rows int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resizes = append(p.resizes, [2]int{cols, rows})
	return nil
}
func (p *stubPty) Close() error { p.closed = true; close(p.out); return nil }

// recSink records everything, thread-safely.
type recSink struct {
	mu     sync.Mutex
	msgs   []protocol.Inner
	output strings.Builder
	closed bool
}

func (s *recSink) SendMsg(m protocol.Inner)  { s.mu.Lock(); s.msgs = append(s.msgs, m); s.mu.Unlock() }
func (s *recSink) SendOutput(p []byte)       { s.mu.Lock(); s.output.Write(p); s.mu.Unlock() }
func (s *recSink) Close()                    { s.mu.Lock(); s.closed = true; s.mu.Unlock() }
func (s *recSink) firstMsg() protocol.Inner  { s.mu.Lock(); defer s.mu.Unlock(); return s.msgs[0] }
func (s *recSink) allMsgs() []protocol.Inner { s.mu.Lock(); defer s.mu.Unlock(); return append([]protocol.Inner{}, s.msgs...) }
func (s *recSink) out() string               { s.mu.Lock(); defer s.mu.Unlock(); return s.output.String() }

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within 2s")
}

func TestAttachEchoAndReplay(t *testing.T) {
	var spawned int
	m := NewManager(func(id string, cols, rows int) (Pty, error) { spawned++; return newStubPty(), nil })

	s1 := &recSink{}
	if err := m.Attach("t1", 1, 80, 24, s1); err != nil {
		t.Fatal(err)
	}
	if got := s1.firstMsg(); got.Type != "attached" || got.Cols != 80 || got.Rows != 24 {
		t.Fatalf("attached: %+v", got)
	}

	m.Input("t1", 1, "hi")
	waitFor(t, func() bool { return strings.Contains(s1.out(), "echo:hi") })

	// Second viewer with a silly requested size: attached carries the SESSION
	// size, no resize occurs, and the ring replays earlier output.
	s2 := &recSink{}
	if err := m.Attach("t1", 2, 999, 999, s2); err != nil {
		t.Fatal(err)
	}
	if spawned != 1 {
		t.Fatalf("second attach must not respawn: %d", spawned)
	}
	if got := s2.firstMsg(); got.Cols != 80 || got.Rows != 24 {
		t.Fatalf("attached must carry session size: %+v", got)
	}
	waitFor(t, func() bool { return strings.Contains(s2.out(), "echo:hi") })
}

func TestResizeClampDedupBroadcast(t *testing.T) {
	pty := newStubPty()
	m := NewManager(func(string, int, int) (Pty, error) { return pty, nil })
	s1, s2 := &recSink{}, &recSink{}
	m.Attach("t1", 1, 80, 24, s1)
	m.Attach("t1", 2, 80, 24, s2)

	m.Resize("t1", 80, 24) // dedup: identical → no pty resize, no broadcast
	m.Resize("t1", 1000, 1) // clamp → 500x5, broadcast to both
	waitFor(t, func() bool {
		for _, msg := range s2.allMsgs() {
			if msg.Type == "resize" && msg.Cols == 500 && msg.Rows == 5 {
				return true
			}
		}
		return false
	})
	pty.mu.Lock()
	defer pty.mu.Unlock()
	if len(pty.resizes) != 1 || pty.resizes[0] != [2]int{500, 5} {
		t.Fatalf("pty resizes: %v", pty.resizes)
	}
}

func TestConcurrentAttachSpawnsOnce(t *testing.T) {
	var mu sync.Mutex
	spawned := 0
	m := NewManager(func(string, int, int) (Pty, error) {
		mu.Lock()
		spawned++
		mu.Unlock()
		return newStubPty(), nil
	})
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(ch uint32) {
			defer wg.Done()
			m.Attach("race", ch, 80, 24, &recSink{})
		}(uint32(i + 1))
	}
	wg.Wait()
	if spawned != 1 {
		t.Fatalf("concurrent attach spawned %d ptys", spawned)
	}
}

func TestPtyExitBroadcastsExitAndForgets(t *testing.T) {
	pty := newStubPty()
	spawnCount := 0
	m := NewManager(func(string, int, int) (Pty, error) { spawnCount++; return pty, nil })
	s1 := &recSink{}
	m.Attach("t1", 1, 80, 24, s1)
	pty.Close() // EOF → exit broadcast, session forgotten
	waitFor(t, func() bool {
		for _, msg := range s1.allMsgs() {
			if msg.Type == "exit" {
				return true
			}
		}
		return false
	})
	waitFor(t, func() bool { s1.mu.Lock(); defer s1.mu.Unlock(); return s1.closed })
	// Re-attach spawns fresh (tmux new -A semantics live in the factory).
	m.Attach("t1", 2, 80, 24, &recSink{})
	if spawnCount != 2 {
		t.Fatalf("expected respawn after exit, got %d spawns", spawnCount)
	}
}

func TestDetachAllLeavesPtyRunning(t *testing.T) {
	pty := newStubPty()
	m := NewManager(func(string, int, int) (Pty, error) { return pty, nil })
	s1 := &recSink{}
	m.Attach("t1", 1, 80, 24, s1)
	m.DetachAll()
	if pty.closed {
		t.Fatal("DetachAll must never kill the pty — tmux survives relay drops")
	}
	waitFor(t, func() bool { s1.mu.Lock(); defer s1.mu.Unlock(); return s1.closed })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `gateway-go/`): `go test ./session`
Expected: FAIL — undefined symbols.

- [ ] **Step 3: Implement `gateway-go/session/session.go`**

```go
// Package session owns tmux-backed terminal sessions: one pty per session,
// fanned out to every attached channel sink, with the resize-authority and
// scrollback semantics of server/src/terminal-gateway.ts.
//
// Concurrency invariants (the Node gateway got these free from its single
// thread; here they are explicit — spike spec §3):
//   - get-or-create holds the manager mutex: concurrent Attach for a new
//     session spawns exactly one pty.
//   - attached + ring replay + channel subscription happen atomically under
//     the session mutex, so live read-loop output can neither interleave
//     into the replay nor be dropped between replay and subscribe.
//   - Input/Resize are serialized per session by the same mutex.
package session

import (
	"io"
	"sync"

	"github.com/lean-software-production/ensembleworks/gateway-go/protocol"
)

const (
	minCols, maxCols = 20, 500
	minRows, maxRows = 5, 200
	scrollbackLimit  = 256 * 1024
)

type Pty interface {
	io.ReadWriter
	Resize(cols, rows int) error
	Close() error
}

type PtyFactory func(sessionID string, cols, rows int) (Pty, error)

// Sink is one attached viewer (a relay channel). Implementations must be
// safe to call from the session read-loop goroutine.
type Sink interface {
	SendMsg(inner protocol.Inner)
	SendOutput(payload []byte)
	Close()
}

type sessionState struct {
	mu        sync.Mutex
	id        string
	pty       Pty
	cols, rows int
	ring      [][]byte
	ringBytes int
	channels  map[uint32]Sink
	gone      bool
}

type Manager struct {
	mu       sync.Mutex
	spawn    PtyFactory
	sessions map[string]*sessionState
}

func NewManager(spawn PtyFactory) *Manager {
	return &Manager{spawn: spawn, sessions: make(map[string]*sessionState)}
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func (m *Manager) getOrCreate(id string, cols, rows int) (*sessionState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[id]; ok {
		return s, nil
	}
	cols, rows = clamp(cols, minCols, maxCols), clamp(rows, minRows, maxRows)
	pty, err := m.spawn(id, cols, rows)
	if err != nil {
		return nil, err
	}
	s := &sessionState{id: id, pty: pty, cols: cols, rows: rows, channels: make(map[uint32]Sink)}
	m.sessions[id] = s
	go m.readLoop(s)
	return s, nil
}

func (m *Manager) readLoop(s *sessionState) {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.pty.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			s.mu.Lock()
			s.ring = append(s.ring, chunk)
			s.ringBytes += len(chunk)
			for s.ringBytes > scrollbackLimit && len(s.ring) > 1 {
				s.ringBytes -= len(s.ring[0])
				s.ring = s.ring[1:]
			}
			for _, sink := range s.channels {
				sink.SendOutput(chunk)
			}
			s.mu.Unlock()
		}
		if err != nil {
			s.mu.Lock()
			s.gone = true
			for _, sink := range s.channels {
				sink.SendMsg(protocol.Inner{Type: "exit"})
				sink.Close()
			}
			s.channels = make(map[uint32]Sink)
			s.mu.Unlock()
			m.mu.Lock()
			if m.sessions[s.id] == s {
				delete(m.sessions, s.id)
			}
			m.mu.Unlock()
			return
		}
	}
}

func (m *Manager) Attach(sessionID string, channelID uint32, cols, rows int, sink Sink) error {
	s, err := m.getOrCreate(sessionID, cols, rows)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// attached carries the SESSION's current size — a newcomer's requested
	// grid must not resize existing viewers (spike spec §2).
	sink.SendMsg(protocol.Inner{Type: "attached", Cols: s.cols, Rows: s.rows})
	for _, chunk := range s.ring {
		sink.SendOutput(chunk)
	}
	s.channels[channelID] = sink
	return nil
}

func (m *Manager) Input(sessionID string, channelID uint32, data string) {
	if s := m.lookup(sessionID); s != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		if _, attached := s.channels[channelID]; attached && !s.gone {
			_, _ = s.pty.Write([]byte(data))
		}
	}
}

func (m *Manager) Resize(sessionID string, cols, rows int) {
	s := m.lookup(sessionID)
	if s == nil {
		return
	}
	cols, rows = clamp(cols, minCols, maxCols), clamp(rows, minRows, maxRows)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gone || (cols == s.cols && rows == s.rows) {
		return // dedup: no pty call, no broadcast (client grid logic relies on this)
	}
	s.cols, s.rows = cols, rows
	_ = s.pty.Resize(cols, rows)
	for _, sink := range s.channels {
		sink.SendMsg(protocol.Inner{Type: "resize", Cols: cols, Rows: rows})
	}
}

func (m *Manager) Detach(sessionID string, channelID uint32) {
	if s := m.lookup(sessionID); s != nil {
		s.mu.Lock()
		delete(s.channels, channelID)
		s.mu.Unlock()
	}
}

// DetachAll drops every viewer (relay disconnect). The ptys stay running —
// tmux sessions must survive connector↔canvas link failures.
func (m *Manager) DetachAll() {
	m.mu.Lock()
	all := make([]*sessionState, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()
	for _, s := range all {
		s.mu.Lock()
		for _, sink := range s.channels {
			sink.Close()
		}
		s.channels = make(map[uint32]Sink)
		s.mu.Unlock()
	}
}

func (m *Manager) lookup(id string) *sessionState {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}
```

- [ ] **Step 4: Implement `gateway-go/session/tmux.go`**

```go
package session

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

const tmuxPrefix = "canvas-" // must match terminal-gateway.ts TMUX_PREFIX

type tmuxPty struct{ f *os.File }

func (p *tmuxPty) Read(b []byte) (int, error)  { return p.f.Read(b) }
func (p *tmuxPty) Write(b []byte) (int, error) { return p.f.Write(b) }
func (p *tmuxPty) Resize(cols, rows int) error {
	return pty.Setsize(p.f, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}
func (p *tmuxPty) Close() error { return p.f.Close() }

// TmuxFactory spawns `tmux new-session -A -s canvas-<id>` — `-A` attaches
// when the session exists, so a connector restart reattaches to surviving
// sessions. `-f` is passed only when tmuxConf exists (matches the Node
// gateway's existence-check behaviour; missing conf silently degrades
// clipboard/status-bar, never crashes).
func TmuxFactory(tmuxConf string) PtyFactory {
	return func(id string, cols, rows int) (Pty, error) {
		args := []string{}
		if tmuxConf != "" {
			if _, err := os.Stat(tmuxConf); err == nil {
				args = append(args, "-f", tmuxConf)
			}
		}
		args = append(args, "new-session", "-A", "-s", tmuxPrefix+id)
		cmd := exec.Command("tmux", args...)
		cmd.Env = append(os.Environ(), "TERM=xterm-256color")
		f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
		if err != nil {
			return nil, err
		}
		return &tmuxPty{f: f}, nil
	}
}
```

- [ ] **Step 5: Fetch deps, run tests (with the race detector — the invariants are the point)**

Run (from `gateway-go/`):
```bash
go get github.com/creack/pty@latest && go test -race ./session ./protocol
```
Expected: both packages `ok`.

- [ ] **Step 6: Commit**

```bash
git add gateway-go/go.mod gateway-go/go.sum gateway-go/session/
git commit -m "feat(gateway-go): session manager with tmux backend and explicit concurrency invariants"
```

---

### Task 8: Go `relay` package + `main` — dial, demux, per-channel FIFO, backoff

**Files:**
- Create: `gateway-go/relay/relay.go`
- Create: `gateway-go/main.go`
- Test: `gateway-go/relay/relay_test.go`

**Interfaces:**
- Consumes: `protocol.*`, `session.Manager` / `session.Sink` / `session.PtyFactory`.
- Produces:
  - `relay.Run(ctx context.Context, cfg relay.Config) error` where `Config{CanvasURL, GatewayID, Label, CFAccessClientID, CFAccessClientSecret string; Manager *session.Manager}` — dials `<CanvasURL ws(s)>/api/gateway/connect?gatewayId=…&label=…`, reconnects with jittered exponential backoff (1 s base, 30 s cap), `DetachAll()` on disconnect.
  - Binary `termgw`: env `CANVAS_URL` (required), `GATEWAY_ID` (default hostname), `GATEWAY_LABEL` (default GATEWAY_ID), `TMUX_CONF` (default `/usr/local/share/termgw/tmux.conf`), `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` (optional).

- [ ] **Step 1: Write the failing integration test (mock relay server, stub pty)**

Create `gateway-go/relay/relay_test.go`:

```go
package relay

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/lean-software-production/ensembleworks/gateway-go/protocol"
	"github.com/lean-software-production/ensembleworks/gateway-go/session"
)

type stubPty struct{ out chan []byte }

func (p *stubPty) Read(b []byte) (int, error) {
	c, ok := <-p.out
	if !ok {
		return 0, io.EOF
	}
	return copy(b, c), nil
}
func (p *stubPty) Write(b []byte) (int, error) { p.out <- append([]byte("echo:"), b...); return len(b), nil }
func (p *stubPty) Resize(int, int) error       { return nil }
func (p *stubPty) Close() error                { close(p.out); return nil }

func TestRelayEndToEnd(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	type recv struct {
		control *protocol.Control
		binary  []byte
	}
	fromConnector := make(chan recv, 256)
	var connMu sync.Mutex
	var serverConn *websocket.Conn

	// Mock canvas: accept the connector, record every frame it sends.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/gateway/connect" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("gatewayId") != "gw-test" {
			t.Errorf("gatewayId missing from dial: %s", r.URL)
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		connMu.Lock()
		serverConn = c
		connMu.Unlock()
		for {
			typ, data, err := c.Read(context.Background())
			if err != nil {
				return
			}
			if typ == websocket.MessageBinary {
				fromConnector <- recv{binary: data}
			} else {
				var ctl protocol.Control
				if err := json.Unmarshal(data, &ctl); err == nil {
					fromConnector <- recv{control: &ctl}
				}
			}
		}
	}))
	defer srv.Close()

	mgr := session.NewManager(func(string, int, int) (session.Pty, error) {
		return &stubPty{out: make(chan []byte, 64)}, nil
	})
	go Run(ctx, Config{CanvasURL: srv.URL, GatewayID: "gw-test", Label: "Test", Manager: mgr})

	// Wait for the connector to dial in.
	deadline := time.Now().Add(3 * time.Second)
	for {
		connMu.Lock()
		c := serverConn
		connMu.Unlock()
		if c != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("connector never dialed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	send := func(ctl protocol.Control) {
		b, _ := json.Marshal(ctl)
		connMu.Lock()
		defer connMu.Unlock()
		if err := serverConn.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatal(err)
		}
	}
	nextControl := func(typ string) protocol.Control {
		for {
			select {
			case r := <-fromConnector:
				if r.control != nil && r.control.Type == typ {
					return *r.control
				}
			case <-time.After(3 * time.Second):
				t.Fatalf("timed out waiting for %s", typ)
			}
		}
	}
	nextBinaryContaining := func(ch uint32, needle string) {
		var acc strings.Builder
		for {
			select {
			case r := <-fromConnector:
				if r.binary != nil {
					id, payload, ok := protocol.DecodeBinary(r.binary)
					if ok && id == ch {
						acc.Write(payload)
						if strings.Contains(acc.String(), needle) {
							return
						}
					}
				}
			case <-time.After(3 * time.Second):
				t.Fatalf("timed out waiting for %q on ch %d; got %q", needle, ch, acc.String())
			}
		}
	}
	inner := func(t2 string, extra map[string]any) json.RawMessage {
		m := map[string]any{"type": t2}
		for k, v := range extra {
			m[k] = v
		}
		b, _ := json.Marshal(m)
		return b
	}

	// relay-open → attached (relay-msg) with the requested size (new session).
	send(protocol.Control{Type: "relay-open", ChannelID: 1, SessionID: "s1", Cols: 80, Rows: 24})
	att := nextControl("relay-msg")
	var attInner protocol.Inner
	json.Unmarshal(att.Msg, &attInner)
	if att.ChannelID != 1 || attInner.Type != "attached" || attInner.Cols != 80 {
		t.Fatalf("bad attached: %+v %+v", att, attInner)
	}

	// input → echoed binary on channel 1.
	send(protocol.Control{Type: "relay-msg", ChannelID: 1, Msg: inner("input", map[string]any{"data": "hi"})})
	nextBinaryContaining(1, "echo:hi")

	// second channel, same session: attached carries session size + replay.
	send(protocol.Control{Type: "relay-open", ChannelID: 2, SessionID: "s1", Cols: 999, Rows: 999})
	att2 := nextControl("relay-msg")
	var att2Inner protocol.Inner
	json.Unmarshal(att2.Msg, &att2Inner)
	if att2.ChannelID != 2 || att2Inner.Cols != 80 {
		t.Fatalf("newcomer must get session size: %+v", att2Inner)
	}
	nextBinaryContaining(2, "echo:hi") // scrollback replay

	// resize dedup: identical size → NO resize broadcast; then a real resize.
	send(protocol.Control{Type: "relay-msg", ChannelID: 1, Msg: inner("resize", map[string]any{"cols": 80, "rows": 24})})
	send(protocol.Control{Type: "relay-msg", ChannelID: 1, Msg: inner("resize", map[string]any{"cols": 120, "rows": 40})})
	rz := nextControl("relay-msg")
	var rzInner protocol.Inner
	json.Unmarshal(rz.Msg, &rzInner)
	if rzInner.Type != "resize" || rzInner.Cols != 120 {
		t.Fatalf("expected the 120x40 broadcast first (dedup swallowed 80x24): %+v", rzInner)
	}

	// relay-close detaches channel 1 without killing the session.
	send(protocol.Control{Type: "relay-close", ChannelID: 1})
	send(protocol.Control{Type: "relay-msg", ChannelID: 2, Msg: inner("input", map[string]any{"data": "bye"})})
	nextBinaryContaining(2, "echo:bye")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `gateway-go/`): `go get github.com/coder/websocket@latest && go test ./relay`
Expected: FAIL — `Run`/`Config` undefined.

- [ ] **Step 3: Implement `gateway-go/relay/relay.go`**

```go
// Package relay maintains the single outbound WS to the canvas
// (/api/gateway/connect — connecting IS registering) and demuxes relay
// channels onto the session manager. Messages are processed per-channel
// FIFO: the read loop enqueues onto a per-channel goroutine, so
// relay-open → relay-msg{resize} ordering survives concurrency (spec §3).
package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/lean-software-production/ensembleworks/gateway-go/protocol"
	"github.com/lean-software-production/ensembleworks/gateway-go/session"
)

type Config struct {
	CanvasURL            string // http(s)://host — scheme is rewritten to ws(s)
	GatewayID            string
	Label                string
	CFAccessClientID     string
	CFAccessClientSecret string
	Manager              *session.Manager
}

// wsWriter serializes writes to the shared WS (coder/websocket allows one
// concurrent writer).
type wsWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
	ctx  context.Context
}

func (w *wsWriter) text(b []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.conn.Write(w.ctx, websocket.MessageText, b)
}
func (w *wsWriter) binary(b []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.conn.Write(w.ctx, websocket.MessageBinary, b)
}

// channelSink implements session.Sink for one relay channel.
type channelSink struct {
	id     uint32
	writer *wsWriter
}

func (s *channelSink) SendMsg(inner protocol.Inner) {
	if b, err := protocol.WrapMsg(s.id, inner); err == nil {
		s.writer.text(b)
	}
}
func (s *channelSink) SendOutput(payload []byte) {
	s.writer.binary(protocol.EncodeBinary(s.id, payload))
}
func (s *channelSink) Close() {
	s.writer.text(protocol.RelayClosed(s.id))
}

// channelWorker gives each channel a FIFO queue + goroutine.
type channelWorker struct {
	queue     chan protocol.Control
	sessionID string
}

func dialURL(cfg Config) (string, error) {
	u, err := url.Parse(cfg.CanvasURL)
	if err != nil {
		return "", err
	}
	u.Scheme = map[string]string{"http": "ws", "https": "wss"}[u.Scheme]
	if u.Scheme == "" {
		return "", fmt.Errorf("CANVAS_URL must be http(s)://…, got %q", cfg.CanvasURL)
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/api/gateway/connect"
	q := u.Query()
	q.Set("gatewayId", cfg.GatewayID)
	q.Set("label", cfg.Label)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// Run dials, serves one connection, and reconnects with jittered exponential
// backoff (1s base, 30s cap) until ctx is done. Sessions (tmux) survive
// disconnects; only viewers are detached.
func Run(ctx context.Context, cfg Config) error {
	target, err := dialURL(cfg)
	if err != nil {
		return err
	}
	attempt := 0
	for {
		if err := serveOnce(ctx, cfg, target); err != nil && ctx.Err() == nil {
			log.Printf("[relay] connection lost: %v", err)
		}
		cfg.Manager.DetachAll()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		attempt++
		backoff := time.Duration(1<<min(attempt-1, 5)) * time.Second // 1..32s → capped below
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
		jitter := time.Duration(float64(backoff) * (0.8 + 0.4*rand.Float64()))
		log.Printf("[relay] reconnecting in %s", jitter.Round(time.Millisecond))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(jitter):
		}
	}
}

func serveOnce(ctx context.Context, cfg Config, target string) error {
	opts := &websocket.DialOptions{}
	if cfg.CFAccessClientID != "" {
		opts.HTTPHeader = http.Header{
			"CF-Access-Client-Id":     []string{cfg.CFAccessClientID},
			"CF-Access-Client-Secret": []string{cfg.CFAccessClientSecret},
		}
	}
	conn, _, err := websocket.Dial(ctx, target, opts)
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	conn.SetReadLimit(1 << 20)
	log.Printf("[relay] connected to %s as %s", cfg.CanvasURL, cfg.GatewayID)

	writer := &wsWriter{conn: conn, ctx: ctx}
	workers := make(map[uint32]*channelWorker)
	defer func() {
		for _, w := range workers {
			close(w.queue)
		}
	}()

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if typ == websocket.MessageBinary {
			continue // canvas→connector is all text
		}
		var ctl protocol.Control
		if json.Unmarshal(data, &ctl) != nil {
			continue
		}
		switch ctl.Type {
		case "relay-open":
			w := &channelWorker{queue: make(chan protocol.Control, 64), sessionID: ctl.SessionID}
			workers[ctl.ChannelID] = w
			go runChannel(cfg.Manager, ctl.ChannelID, w, writer)
			w.queue <- ctl // the open action itself is the first queue item
		case "relay-msg", "relay-close":
			if w, ok := workers[ctl.ChannelID]; ok {
				select {
				case w.queue <- ctl:
				default: // shed rather than block the shared read loop
				}
				if ctl.Type == "relay-close" {
					delete(workers, ctl.ChannelID)
				}
			}
		}
	}
}

func runChannel(mgr *session.Manager, channelID uint32, w *channelWorker, writer *wsWriter) {
	for ctl := range w.queue {
		switch ctl.Type {
		case "relay-open":
			sink := &channelSink{id: channelID, writer: writer}
			if err := mgr.Attach(w.sessionID, channelID, ctl.Cols, ctl.Rows, sink); err != nil {
				log.Printf("[relay] attach %s failed: %v", w.sessionID, err)
				writer.text(protocol.RelayClosed(channelID))
				return
			}
		case "relay-msg":
			var inner protocol.Inner
			if json.Unmarshal(ctl.Msg, &inner) != nil {
				continue
			}
			switch inner.Type {
			case "input":
				mgr.Input(w.sessionID, channelID, inner.Data)
			case "resize":
				mgr.Resize(w.sessionID, inner.Cols, inner.Rows)
			}
		case "relay-close":
			mgr.Detach(w.sessionID, channelID)
			return
		}
	}
	mgr.Detach(w.sessionID, channelID)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `gateway-go/`): `go test -race ./...`
Expected: all three packages `ok`.

- [ ] **Step 5: Implement `gateway-go/main.go`**

```go
// termgw — EnsembleWorks remote terminal connector (spike).
// Dials the canvas sync server and serves tmux-backed terminal sessions
// over the relay. See docs/superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/lean-software-production/ensembleworks/gateway-go/relay"
	"github.com/lean-software-production/ensembleworks/gateway-go/session"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	canvasURL := os.Getenv("CANVAS_URL")
	if canvasURL == "" {
		log.Fatal("CANVAS_URL is required (e.g. https://canvas.example.com or http://ash:8788)")
	}
	hostname, _ := os.Hostname()
	gatewayID := envOr("GATEWAY_ID", hostname)
	cfg := relay.Config{
		CanvasURL:            canvasURL,
		GatewayID:            gatewayID,
		Label:                envOr("GATEWAY_LABEL", gatewayID),
		CFAccessClientID:     os.Getenv("CF_ACCESS_CLIENT_ID"),
		CFAccessClientSecret: os.Getenv("CF_ACCESS_CLIENT_SECRET"),
		Manager:              session.NewManager(session.TmuxFactory(envOr("TMUX_CONF", "/usr/local/share/termgw/tmux.conf"))),
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := relay.Run(ctx, cfg); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 6: Build + smoke against the real plane (manual, needs tmux)**

```bash
cd gateway-go && go vet ./... && CGO_ENABLED=0 go build -o /tmp/termgw .
```
Expected: clean build. Optional local smoke: start the sync server (`npm run dev --workspace=server`), run `CANVAS_URL=http://localhost:8788 GATEWAY_LABEL="Local Go" /tmp/termgw`, then `curl -s localhost:8788/api/gateway/list` — expect the gateway listed; a terminal created via the Task 5 dropdown against it must echo keystrokes.

- [ ] **Step 7: Commit**

```bash
git add gateway-go/
git commit -m "feat(gateway-go): relay client with per-channel FIFO demux + termgw main"
```

---

### Task 9: Devcontainer feature packaging

**Files:**
- Create: `gateway-go/build.bash`
- Create: `gateway-go/termgw-feature/devcontainer-feature.json`
- Create: `gateway-go/termgw-feature/install.sh`
- Create: `gateway-go/termgw-feature/termgw-supervisor.sh`
- Create: `gateway-go/devcontainer/devcontainer.json` (worked example)

**Interfaces:**
- Consumes: the `termgw` binary (Task 8); env contract `CANVAS_URL`, `GATEWAY_ID`, `GATEWAY_LABEL`, `TMUX_CONF`, `CF_ACCESS_CLIENT_ID/SECRET`.
- Produces: a local devcontainer feature any repo consumes with one `devcontainer.json` line.

- [ ] **Step 1: Build script — `gateway-go/build.bash`**

```bash
#!/usr/bin/env bash
# Build the static termgw binary into the feature's dist/ so a local
# devcontainer feature can install it without a Go toolchain in the image.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p termgw-feature/dist
CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH:-amd64}" go build -trimpath -o termgw-feature/dist/termgw .
echo "built termgw-feature/dist/termgw ($(du -h termgw-feature/dist/termgw | cut -f1))"
```

`chmod +x gateway-go/build.bash`. Add `gateway-go/termgw-feature/dist/` to `.gitignore` (built artifact, not committed).

- [ ] **Step 2: Feature metadata — `gateway-go/termgw-feature/devcontainer-feature.json`**

```json
{
	"id": "termgw",
	"version": "0.1.0",
	"name": "EnsembleWorks terminal gateway connector",
	"description": "Hosts canvas terminal shapes in this devcontainer via the EnsembleWorks relay.",
	"postStartCommand": "nohup /usr/local/share/termgw/termgw-supervisor.sh >>/tmp/termgw.log 2>&1 & disown || true",
	"containerEnv": {
		"TMUX_CONF": "/usr/local/share/termgw/tmux.conf"
	}
}
```

- [ ] **Step 3: Installer — `gateway-go/termgw-feature/install.sh`**

```bash
#!/usr/bin/env bash
# Devcontainer feature installer: runs at image build as root, with this
# feature's files as the working directory.
set -euo pipefail

if ! command -v tmux >/dev/null; then
	apt-get update && apt-get install -y --no-install-recommends tmux && rm -rf /var/lib/apt/lists/*
fi

install -D -m 0755 ./dist/termgw /usr/local/bin/termgw
install -D -m 0755 ./termgw-supervisor.sh /usr/local/share/termgw/termgw-supervisor.sh
# Optional tmux conf: ship the repo conf when present beside the feature.
if [ -f ./tmux.conf ]; then
	install -D -m 0644 ./tmux.conf /usr/local/share/termgw/tmux.conf
fi
echo "termgw feature installed"
```

`chmod +x gateway-go/termgw-feature/install.sh`. Also copy the repo tmux conf into the feature before builds — add to `build.bash` after the go build:

```bash
cp ../deploy/tmux-ensembleworks.conf termgw-feature/tmux.conf
```

- [ ] **Step 4: Supervisor — `gateway-go/termgw-feature/termgw-supervisor.sh`**

```bash
#!/usr/bin/env bash
# Restart-on-exit supervisor for termgw (spike-grade; systemd is not
# available inside devcontainers). CANVAS_URL etc. come from remoteEnv.
set -u
while true; do
	/usr/local/bin/termgw
	echo "[termgw-supervisor] termgw exited ($?), restarting in 2s" >&2
	sleep 2
done
```

`chmod +x gateway-go/termgw-feature/termgw-supervisor.sh`

- [ ] **Step 5: Worked example — `gateway-go/devcontainer/devcontainer.json`**

```json
{
	"name": "termgw-example",
	"image": "mcr.microsoft.com/devcontainers/base:ubuntu",
	"features": {
		"../termgw-feature": {}
	},
	"remoteEnv": {
		"CANVAS_URL": "${localEnv:CANVAS_URL}",
		"GATEWAY_LABEL": "${localEnv:GATEWAY_LABEL}",
		"CF_ACCESS_CLIENT_ID": "${localEnv:CF_ACCESS_CLIENT_ID}",
		"CF_ACCESS_CLIENT_SECRET": "${localEnv:CF_ACCESS_CLIENT_SECRET}"
	}
}
```

For the workshops repo the one-line adoption is: `"features": { "./termgw-feature": {} }` with the feature dir copied/submoduled in — record the exact mechanics used in the demo findings.

Note: some devcontainer CLI versions only accept local feature paths at or below the `devcontainer.json` folder. If `"../termgw-feature"` is rejected, have `build.bash` copy `termgw-feature/` into `devcontainer/termgw-feature/` and reference `"./termgw-feature"` — record which was needed.

- [ ] **Step 6: Static checks + local `devcontainer up` smoke**

```bash
bash -n gateway-go/termgw-feature/install.sh gateway-go/termgw-feature/termgw-supervisor.sh gateway-go/build.bash
gateway-go/build.bash
```
Expected: no syntax errors; `built termgw-feature/dist/termgw`.
`build.bash` also stages the built feature to `devcontainer/.devcontainer/termgw-feature/` (the devcontainer CLI resolves `./termgw-feature` relative to the config at `devcontainer/.devcontainer/devcontainer.json`). The staged copy is gitignored.
If Docker + the devcontainer CLI are available locally:
```bash
CANVAS_URL=http://host.docker.internal:8788 GATEWAY_LABEL="Local devcontainer" \
  devcontainer up --workspace-folder gateway-go/devcontainer
curl -s localhost:8788/api/gateway/list
```
The config lives at `gateway-go/devcontainer/.devcontainer/devcontainer.json` so `--workspace-folder gateway-go/devcontainer` is the correct path (the CLI discovers `.devcontainer/devcontainer.json` inside the workspace folder).
Expected: the gateway appears in the list within ~5 s of container start.

- [ ] **Step 7: Commit**

```bash
git add gateway-go/build.bash gateway-go/termgw-feature/ gateway-go/devcontainer/ .gitignore
git commit -m "feat(gateway-go): devcontainer feature packaging for the termgw connector"
```

---

### Task 10: Manual demo on a remote box + findings write-back

No code. **Preconditions:** a Docker-capable SSH box, the devcontainer CLI on it, the ash canvas reachable over the tailnet.

- [ ] **Step 1: Run the demo checklist (record everything for the findings):**

1. `gateway-go/build.bash` (builds the binary and stages `termgw-feature/` to `devcontainer/.devcontainer/termgw-feature/`), then copy `gateway-go/` to the remote box (`rsync -a gateway-go/ box:~/termgw-spike/`).
2. On the box: `CANVAS_URL=http://<ash-tailnet>:8788 GATEWAY_LABEL="workshops box" devcontainer up --workspace-folder ~/termgw-spike/devcontainer` (the CLI discovers `~/termgw-spike/devcontainer/.devcontainer/devcontainer.json`; the feature is resolved as `./termgw-feature` from that config's directory).
3. In a browser on the canvas: "New terminal" dropdown shows "workshops box" → create → typing round-trip. Record subjective feel + the WAN echo RTT (rerun `measureEcho` logic manually or time visually).
4. Second browser: identical bytes; resize one viewer → both converge (authoritative resize).
5. Refresh a browser → reattaches with scrollback.
6. `docker exec` into the container, `pkill termgw` → supervisor restarts it, tmux session survives, terminal shape reattaches after its backoff.
7. Kill the whole container and `devcontainer up` again → `tmux new -A` reattach behaviour: session content survives only if the container (and its tmux server) survived — record what actually happens for the findings (container recreation loses tmux; process restart within the container does not).

- [ ] **Step 2: Write findings back into `docs/distributed-terminals-design.md`**

Add a `## Spike findings (2026-07)` section covering: Go ergonomics verdict (decision question 1), loopback + WAN latency numbers (question 2), devcontainer-feature packaging verdict (question 3), and supersede the relay-splicer sketch (base64 JSON `relay-data`, UUID channel ids) with the uint32-prefix binary framing where the findings support it.

- [ ] **Step 3: Commit**

```bash
git add docs/distributed-terminals-design.md
git commit -m "docs: remote-terminal spike findings written back into distributed-terminals design"
```
