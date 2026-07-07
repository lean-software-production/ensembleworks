# A/V connection telemetry beacon (spec §2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record connection-lifecycle events from both planes (LiveKit + tldraw sync) on every client and ship them to the server, appended to one JSONL per room, so the next degraded session is diagnosable from the server without asking anyone to open devtools.

**Architecture:** A client module (`connectionLog.ts`) buffers events and flushes them with `navigator.sendBeacon` (batched, ~5s debounce, fire-and-forget). The LiveKit reconnect handlers from §1 and the tldraw `useSync` status feed it. Server side, a `telemetry-store` (mirroring `transcript-store`) appends validated events to `<data-dir>/telemetry/<roomId>-connection.jsonl` with size-based rotation, behind a `POST /api/telemetry/connection` feature router that emits one journal line per batch.

**Tech Stack:** Express feature router + `node:fs/promises` (server), `navigator.sendBeacon` + a testable buffer (client), `@tldraw/sync` status, `bun` test (`node:assert`).

**Source spec:** `docs/superpowers/specs/2026-07-07-av-resilience-connection-observability-design.md` §2. Builds on §1 (the reconnect events already exist as `console.debug` lines).

**Scope note:** §2 only. No read API in v1 — operators read the file (spec). §3 (sync-plane hardening) is a separate plan.

---

### Task 1: Server — telemetry store with rotation (TDD)

**Files:**
- Create: `server/src/telemetry-store.ts`
- Test: `server/src/telemetry-store.test.ts`

- [ ] **Step 1: Write the failing test** (mirrors `roadmap-store.test.ts`: temp dir, `node:assert`, `bun`-run)

```ts
// Unit tests for the connection-telemetry JSONL store.
// Run with: bun src/telemetry-store.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTelemetryStore } from './telemetry-store.ts'

async function main() {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'tel-'))
	const store = createTelemetryStore(dir, 200) // tiny rotate cap for the test

	await store.append('team', { userId: 'u1', plane: 'livekit', event: 'disconnected', detail: { reason: 3 } })
	await store.append('team', { userId: 'u1', plane: 'sync', event: 'offline' })

	const file = path.join(dir, 'team-connection.jsonl')
	const lines = (await readFile(file, 'utf8')).trim().split('\n')
	assert.equal(lines.length, 2, 'two events appended')
	const first = JSON.parse(lines[0]!)
	assert.equal(first.roomId, 'team')
	assert.equal(first.plane, 'livekit')
	assert.equal(first.event, 'disconnected')
	assert.equal(typeof first.t, 'number', 'server-stamped timestamp')

	// Cross the 200-byte cap → the live file rotates to .1 and starts fresh.
	for (let i = 0; i < 20; i++) await store.append('team', { userId: 'u1', plane: 'sync', event: 'online' })
	await stat(`${file}.1`) // throws if rotation didn't happen
	const liveSize = (await stat(file)).size
	assert.ok(liveSize < (await stat(`${file}.1`)).size + 1e6, 'live file exists post-rotation')

	console.log('ok: telemetry-store')
}

main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && bun src/telemetry-store.test.ts`
Expected: FAIL — `createTelemetryStore` not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Connection-telemetry store — one append-only JSONL per room
 * (<dir>/<roomId>-connection.jsonl), written by the client beacon via
 * POST /api/telemetry/connection. Greppable, crash-safe (one record per line),
 * and size-capped: when a file crosses the cap it rotates to `.1` (one backup)
 * so a long/chatty session can't grow unbounded. No read API — operators read
 * the file. Mirrors transcript-store.ts.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'

export interface ConnectionEvent {
	t: number // ms epoch, server-stamped on append
	roomId: string
	userId: string
	plane: 'livekit' | 'sync'
	event: string
	detail?: unknown
}

const ROTATE_BYTES = 10 * 1024 * 1024 // 10 MB

export interface TelemetryStore {
	append(
		roomId: string,
		event: Omit<ConnectionEvent, 't' | 'roomId'> & { t?: number }
	): Promise<void>
}

export function createTelemetryStore(dir: string, rotateBytes = ROTATE_BYTES): TelemetryStore {
	const fileFor = (roomId: string) => path.join(dir, `${roomId}-connection.jsonl`)
	return {
		async append(roomId, event) {
			await mkdir(dir, { recursive: true })
			const file = fileFor(roomId)
			try {
				if ((await stat(file)).size >= rotateBytes) await rename(file, `${file}.1`)
			} catch {
				/* no file yet — nothing to rotate */
			}
			const full: ConnectionEvent = { ...event, roomId, t: event.t ?? Date.now() }
			await appendFile(file, `${JSON.stringify(full)}\n`)
		},
	}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && bun src/telemetry-store.test.ts`
Expected: `ok: telemetry-store`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/telemetry-store.ts server/src/telemetry-store.test.ts
git commit -m "feat(telemetry): connection-event JSONL store with size rotation"
```

---

### Task 2: Server — POST /api/telemetry/connection router + wiring (TDD)

**Files:**
- Create: `server/src/features/telemetry.ts`
- Modify: `server/src/kernel/context.ts` (add `telemetry` to `storage`)
- Modify: `server/src/app.ts` (build the store, register the router)
- Test: `server/src/telemetry-api.test.ts`

- [ ] **Step 1: Write the failing test** (mirrors an existing `*-api.test.ts`: boot `createSyncApp` on a temp dir, `fetch`, then `process.exit(0)` — the app's intervals keep the loop alive otherwise)

```ts
// POST /api/telemetry/connection: validate a batch, append per room.
// Run with: bun src/telemetry-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-api-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((r) => server.listen(0, r))
	const { port } = server.address() as { port: number }
	const url = `http://127.0.0.1:${port}/api/telemetry/connection`

	// A valid batch with one junk event mixed in (junk is skipped, not fatal).
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			events: [
				{ roomId: 'team', userId: 'u1', plane: 'livekit', event: 'reconnecting' },
				{ roomId: 'team', userId: 'u1', plane: 'sync', event: 'offline', detail: { code: 1006 } },
				{ plane: 'nope', event: '' }, // invalid → skipped
			],
		}),
	})
	assert.equal(res.status, 200)
	assert.equal((await res.json()).written, 2, 'two valid events written, junk skipped')

	const file = path.join(dataDir, 'telemetry', 'team-connection.jsonl')
	const lines = (await readFile(file, 'utf8')).trim().split('\n')
	assert.equal(lines.length, 2)
	assert.equal(JSON.parse(lines[1]!).event, 'offline')

	// Empty batch → 400.
	const bad = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ events: [] }),
	})
	assert.equal(bad.status, 400)

	console.log('ok: telemetry-api')
	server.close()
	process.exit(0)
}

main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && bun src/telemetry-api.test.ts`
Expected: FAIL — route 404s (`written` undefined / status 404).

- [ ] **Step 3: Add `telemetry` to the storage context**

In `server/src/kernel/context.ts`, extend the `storage` block:

```ts
	storage: {
		transcripts: ReturnType<typeof createTranscriptStore>
		roadmaps: ReturnType<typeof createRoadmapStore>
		telemetry: ReturnType<typeof createTelemetryStore>
		uploadsDir: string
	}
```

Add the import at the top of `context.ts`:

```ts
import type { createTelemetryStore } from '../telemetry-store.ts'
```

- [ ] **Step 4: Implement the router**

```ts
/**
 * Telemetry feature — POST /api/telemetry/connection. The client beacon posts a
 * batch of connection-lifecycle events (LiveKit + tldraw sync); we validate each,
 * append to the per-room JSONL store, and emit one journal line per batch so
 * `journalctl -u ensembleworks-sync` can cross-reference client-perceived drops
 * against server-side session churn. Write-only: no GET (operators read the file).
 */
import express from 'express'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'

const MAX_BATCH = 100
const MAX_DETAIL_CHARS = 2000

function cleanDetail(detail: unknown): unknown {
	if (detail === undefined || detail === null) return undefined
	try {
		const s = JSON.stringify(detail)
		return s.length > MAX_DETAIL_CHARS ? { truncated: s.slice(0, MAX_DETAIL_CHARS) } : detail
	} catch {
		return undefined
	}
}

export function createTelemetryRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	router.post('/api/telemetry/connection', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const events = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : []
		if (events.length === 0) return void res.status(400).json({ error: 'events[] required' })

		let written = 0
		const rooms = new Set<string>()
		for (const raw of events) {
			const e = (raw ?? {}) as Record<string, unknown>
			const roomId = sanitizeId(String(e.roomId ?? ''))
			const plane = e.plane === 'livekit' || e.plane === 'sync' ? e.plane : null
			const event = typeof e.event === 'string' ? e.event.slice(0, 64) : ''
			const userId = typeof e.userId === 'string' ? e.userId.slice(0, 128) : ''
			if (!roomId || !plane || !event) continue
			const t = typeof e.t === 'number' && Number.isFinite(e.t) ? e.t : undefined
			await ctx.storage.telemetry.append(roomId, { userId, plane, event, detail: cleanDetail(e.detail), t })
			written++
			rooms.add(roomId)
		}
		console.log(`[telemetry] ${written} connection event(s), room(s): ${[...rooms].join(',') || '-'}`)
		res.json({ ok: true, written })
	})

	return router
}
```

- [ ] **Step 5: Wire the store + router in `app.ts`**

Add the import near the other store imports:

```ts
import { createTelemetryStore } from './telemetry-store.ts'
import { createTelemetryRouter } from './features/telemetry.ts'
```

Build the store next to the others (after `const transcripts = …`):

```ts
	const telemetry = createTelemetryStore(path.join(opts.dataDir, 'telemetry'))
```

Add it to the `ctx.storage` object literal alongside `transcripts`, `roadmaps`, `uploadsDir`:

```ts
			telemetry,
```

Register the router alongside the other `app.use(create…Router(ctx))` lines:

```ts
	app.use(createTelemetryRouter(ctx))       // POST /api/telemetry/connection (write-only)
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd server && bun src/telemetry-api.test.ts`
Expected: `ok: telemetry-api`, exit 0.

- [ ] **Step 7: Typecheck + commit**

Run: `bun run typecheck` → PASS.

```bash
git add server/src/features/telemetry.ts server/src/kernel/context.ts server/src/app.ts server/src/telemetry-api.test.ts
git commit -m "feat(telemetry): POST /api/telemetry/connection — validate, append, journal"
```

---

### Task 3: Client — connection-log buffer + beacon (TDD the buffer)

**Files:**
- Create: `client/src/av/connectionLog.ts`
- Test: `client/src/av/connectionLog.test.ts`

The testable core is the buffer/debounce/batch; `navigator.sendBeacon` is injected so the test stays node-runnable (like `resolve.test.ts` keeps browser types out of the runtime).

- [ ] **Step 1: Write the failing test**

```ts
/**
 * connectionLog buffer: batches events, flushes once per debounce, never throws.
 * Run: bun src/av/connectionLog.test.ts
 */
import assert from 'node:assert/strict'
import { createConnectionLog } from './connectionLog.ts'

// Manual scheduler so we control when the debounce fires.
let scheduled: (() => void) | null = null
const log = createConnectionLog({
	send: (events) => sent.push(events),
	now: () => 1000,
	schedule: (fn) => {
		scheduled = fn
		return 1
	},
	cancel: () => {
		scheduled = null
	},
})
const sent: unknown[][] = []

log.log({ roomId: 'team', userId: 'u1', plane: 'livekit', event: 'reconnecting' })
log.log({ roomId: 'team', userId: 'u1', plane: 'sync', event: 'offline' })
assert.equal(sent.length, 0, 'nothing sent before the debounce fires')
assert.ok(scheduled, 'a flush was scheduled')

scheduled!() // fire the debounce
assert.equal(sent.length, 1, 'one batched send')
assert.equal((sent[0] as unknown[]).length, 2, 'both events in the batch')
assert.equal((sent[0] as { ts: number }[])[0]!.ts, 1000, 'stamped from now()')

// A send that throws must not propagate (fire-and-forget).
const boom = createConnectionLog({ send: () => { throw new Error('beacon failed') }, schedule: (fn) => (fn(), 0), cancel: () => {} })
boom.log({ roomId: 'team', userId: 'u1', plane: 'sync', event: 'online' }) // must not throw

console.log('ok: connectionLog')
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && bun src/av/connectionLog.test.ts`
Expected: FAIL — `createConnectionLog` not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Client connection-telemetry log. Buffers connection-lifecycle events from both
 * planes and flushes them to POST /api/telemetry/connection with sendBeacon —
 * batched (~5s debounce), fire-and-forget: the beacon must NEVER make a bad
 * connection worse, so a failed send is dropped, never retried, never thrown.
 * Also mirrored to console.debug for live devtools reading. See spec §2.
 */
export interface ClientConnEvent {
	ts: number
	roomId: string
	userId: string
	plane: 'livekit' | 'sync'
	event: string
	detail?: unknown
}

interface ConnectionLogOpts {
	send: (events: ClientConnEvent[]) => void
	now?: () => number
	debounceMs?: number
	schedule?: (fn: () => void, ms: number) => unknown
	cancel?: (handle: unknown) => void
}

export function createConnectionLog(opts: ConnectionLogOpts) {
	const now = opts.now ?? Date.now
	const debounceMs = opts.debounceMs ?? 5000
	const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
	const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
	const buf: ClientConnEvent[] = []
	let timer: unknown = null

	function flush() {
		if (timer !== null) {
			cancel(timer)
			timer = null
		}
		if (buf.length === 0) return
		const batch = buf.splice(0, buf.length)
		try {
			opts.send(batch)
		} catch {
			/* fire-and-forget: never let telemetry surface an error */
		}
	}

	function log(e: Omit<ClientConnEvent, 'ts'> & { ts?: number }) {
		buf.push({ ...e, ts: e.ts ?? now() })
		if (timer === null) timer = schedule(flush, debounceMs)
	}

	return { log, flush }
}

// --- Module singleton wired to the real beacon --------------------------------

let ctxRoomId = ''
let ctxUserId = ''

export function configureConnectionLog(ctx: { roomId: string; userId: string }) {
	ctxRoomId = ctx.roomId
	ctxUserId = ctx.userId
}

const singleton = createConnectionLog({
	send: (events) => {
		try {
			// application/json so express.json() parses the beacon body server-side.
			const blob = new Blob([JSON.stringify({ events })], { type: 'application/json' })
			navigator.sendBeacon('/api/telemetry/connection', blob)
		} catch {
			/* drop */
		}
	},
})

export function logConnectionEvent(plane: 'livekit' | 'sync', event: string, detail?: unknown) {
	if (!ctxRoomId) return
	console.debug(`[conn] ${plane} ${event}`, detail ?? '')
	singleton.log({ roomId: ctxRoomId, userId: ctxUserId, plane, event, detail })
}

export function flushConnectionLog() {
	singleton.flush()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && bun src/av/connectionLog.test.ts`
Expected: `ok: connectionLog`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/av/connectionLog.ts client/src/av/connectionLog.test.ts
git commit -m "feat(telemetry): client connection-log buffer + sendBeacon (fire-and-forget)"
```

---

### Task 4: Client — feed LiveKit events into the log

**Files:**
- Modify: `client/src/av/useLiveKitRoom.ts`

- [ ] **Step 1: Import the logger**

```ts
import { logConnectionEvent } from './connectionLog.ts'
```

- [ ] **Step 2: Emit from the reconnect handlers** (the ones added in §1)

Add `logConnectionEvent('livekit', …)` calls alongside the existing `setStatus`:
- `Reconnecting` / `SignalReconnecting` handlers → `logConnectionEvent('livekit', 'reconnecting')`
- `Reconnected` handler → `logConnectionEvent('livekit', 'reconnected')`
- `Disconnected` handler → `logConnectionEvent('livekit', 'disconnected', { reason, fatal: classifyDisconnect(reason) === 'fatal' })`
- inside `scheduleRejoin`, after computing `delay` → `logConnectionEvent('livekit', 'rejoin', { attempt, delay })`
- successful connect (after `setStatus('connected')`) → `logConnectionEvent('livekit', 'connected')`

- [ ] **Step 3: Add a ConnectionQualityChanged handler (telemetry-only)**

In the handler block, add:

```ts
				room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
					logConnectionEvent('livekit', 'quality', { identity: participant.identity, quality })
				})
```

(`ConnectionQualityChanged` is exported on `RoomEvent`; it affects no React state — it exists purely to feed the downlink-saturation analysis.)

- [ ] **Step 4: Typecheck + smoke**

Run: `cd client && bun run typecheck` → PASS. With the stack up, load the canvas and confirm `[conn] livekit connected` appears in devtools console on join.

- [ ] **Step 5: Commit**

```bash
git add client/src/av/useLiveKitRoom.ts
git commit -m "feat(telemetry): log LiveKit reconnect + quality events"
```

---

### Task 5: Client — feed tldraw sync status + configure/flush

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Configure the log once, near where roomId/identity are known**

```ts
import { configureConnectionLog, flushConnectionLog, logConnectionEvent } from './av/connectionLog.ts'
```

In the component body (after `useSync` / where `roomId` and `identity` are in scope), add an effect:

```ts
	useEffect(() => {
		configureConnectionLog({ roomId, userId: identity.id })
		// Flush on the way out so the last events (often the interesting ones) land.
		const onHide = () => flushConnectionLog()
		window.addEventListener('pagehide', onHide)
		return () => window.removeEventListener('pagehide', onHide)
	}, [])
```

- [ ] **Step 2: Log sync status transitions**

`useSync` returns a `store` whose `.status` (`'loading' | 'synced-remote' | 'error' | …`) and, when `synced-remote`, `.connectionStatus` (`'online' | 'offline'`) mark the moments presence is wiped. Add an effect that logs transitions (guard against duplicate logs by tracking the last value):

```ts
	const syncStatus = store.status === 'synced-remote' ? store.connectionStatus : store.status
	const lastSync = useRef<string | null>(null)
	useEffect(() => {
		if (syncStatus === lastSync.current) return
		lastSync.current = syncStatus
		logConnectionEvent('sync', String(syncStatus))
	}, [syncStatus])
```

(Adjust the exact field reads to the `TLStoreWithStatus` union `@tldraw/sync` exposes — narrow on `store.status === 'synced-remote'` before reading `connectionStatus`.)

- [ ] **Step 3: Typecheck + smoke**

Run: `cd client && bun run typecheck` → PASS. Load the canvas; confirm `[conn] sync online` appears once connected.

- [ ] **Step 4: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat(telemetry): log tldraw sync status transitions + flush on pagehide"
```

---

### Task 6: Live verification (per spec §Verification)

- [ ] **Step 1: Both planes land.** Stack up, join the canvas. In devtools, throttle to Offline for ~3s then Online. Confirm `[conn]` lines appear for both `livekit` (reconnecting/reconnected/rejoin) and `sync` (offline/online).

- [ ] **Step 2: JSONL + journal.** After ~5s (debounce) or a page navigation, confirm `<data-dir>/telemetry/team-connection.jsonl` has the events with sensible cross-plane ordering, and that `bin/dev logs sync` shows a `[telemetry] N connection event(s)` line per batch.

- [ ] **Step 3: Beacon failures are silent.** Stop the sync server briefly and generate events; confirm the client logs nothing alarming (no thrown errors, no console noise beyond the `[conn]` debug lines) — the beacon drops on failure.

---

## Self-review notes

- **Spec coverage:** both-plane events (§2) — LiveKit reconnect/quality ✓ T4, sync transitions ✓ T5; event shape `{ts,roomId,userId,plane,event,detail}` ✓ T3; sendBeacon batched ~5s fire-and-forget ✓ T3; console.debug mirror ✓ T3; server append to `<data-dir>/telemetry/<roomId>-connection.jsonl` via the transcript-store pattern ✓ T1; journal line per batch ✓ T2; size rotation (~10MB) ✓ T1; no read API ✓ (write-only router).
- **sendBeacon content-type:** the Blob is typed `application/json` so `express.json()` parses it (a default `text/plain` beacon would arrive unparsed). Called out in T3.
- **Test-runner fit:** all tests run under `bun` with `node:assert` (no vitest); the API test boots `createSyncApp` and calls `process.exit(0)` (the app's intervals keep the loop alive — the tools-api lesson).
- **Non-blocking:** telemetry is fire-and-forget and never surfaces errors to the user; a failed/absent server just means no record — never a worse connection.
- **Feeds §1:** the LiveKit events logged here are exactly the reconnect events §1 already emits to `console.debug`; §2 ships them. §3 (sync hardening) is independent and next.
