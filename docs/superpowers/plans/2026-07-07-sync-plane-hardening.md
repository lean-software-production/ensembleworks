# Sync-plane hardening (spec §3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the real gaps the 2026-07-06 investigation surfaced in the sync server: a bad room shouldn't crash the whole process, a slow client shouldn't grow an unbounded buffer, connection lifetimes should be visible in the journal, and event-loop starvation should be observable — so the next degraded session leaves server-side evidence and can't take everyone down.

**Architecture:** A testable `attachSyncSocket` wraps the synchronous room load in the WS upgrade handler (try/catch → close that socket, don't throw). Per-connection open/close/error logging goes in the same handler. A pure `classifyBackpressure` threshold function drives a `.unref()`'d ~10s interval that samples every `/sync` socket's `bufferedAmount` (mirrors the terminal relay's `BROWSER_BUFFER_LIMIT`). A `.unref()`'d 1s interval logs event-loop drift.

**Tech Stack:** Express/`ws` (server), `node:fs` unaffected, `bun` test (`node:assert`).

**Source spec:** `docs/superpowers/specs/2026-07-07-av-resilience-connection-observability-design.md` §3. Secondary to §1/§2 by the spec's own framing ("none of them explains the incident") but each is an independent robustness win; the crash-guard is sequenced first.

**Scope note:** §3 only. `prod/ensembleworks-sync.service` gaining a hard `MemoryMax` is an operator/deploy change (noted in the spec) and is out of this code plan.

---

### Task 1: Crash-guard — `attachSyncSocket` (TDD), wired into the upgrade handler

A room whose SQLite fails to open throws from `getOrCreateRoom`; today that throw is uncaught inside the `wss.handleUpgrade` callback and crash-loops the whole sync server on every reconnect (`app.ts:215`). Extract the attach into a testable unit that closes just that socket instead.

**Files:**
- Create: `server/src/sync-attach.ts`
- Test: `server/src/sync-attach.test.ts`
- Modify: `server/src/app.ts` (call the helper)

- [ ] **Step 1: Write the failing test**

```ts
// attachSyncSocket: a room that fails to load closes just that socket, never throws.
// Run with: bun src/sync-attach.test.ts
import assert from 'node:assert/strict'
import { attachSyncSocket } from './sync-attach.ts'

// Happy path: the room attaches the socket, returns true.
{
	let attached: unknown = null
	const roomHost = { getOrCreateRoom: () => ({ handleSocketConnect: (o: unknown) => (attached = o) }) }
	const ws = { close: () => assert.fail('should not close'), terminate: () => assert.fail('no terminate') }
	const ok = attachSyncSocket(roomHost as never, ws as never, 'team', 's1')
	assert.equal(ok, true)
	assert.deepEqual(attached, { sessionId: 's1', socket: ws })
}

// Bad room: getOrCreateRoom throws → close(1011), return false, DO NOT throw.
{
	let closedWith: [number?, string?] | null = null
	const roomHost = {
		getOrCreateRoom: () => {
			throw new Error('sqlite corrupt')
		},
	}
	const ws = { close: (c?: number, r?: string) => (closedWith = [c, r]), terminate: () => {} }
	const ok = attachSyncSocket(roomHost as never, ws as never, 'team', 's1')
	assert.equal(ok, false, 'did not attach')
	assert.equal(closedWith![0], 1011, 'closed with 1011 (internal error)')
}

console.log('ok: sync-attach')
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && bun src/sync-attach.test.ts`
Expected: FAIL — `attachSyncSocket` not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Attach a /sync WebSocket to its room, guarding the synchronous room load.
 *
 * getOrCreateRoom opens the room's SQLite; a corrupt or schema-incompatible file
 * throws here. Without this guard that throw is uncaught inside the WS upgrade
 * callback and takes down the whole sync process — and since clients auto-
 * reconnect, it crash-loops for everyone. Instead: log and close just the one
 * socket (1011 = internal error), leaving every other room untouched.
 */
import type { WebSocket } from 'ws'
import type { RoomHost } from './kernel/rooms.ts'

export function attachSyncSocket(
	roomHost: Pick<RoomHost, 'getOrCreateRoom'>,
	ws: Pick<WebSocket, 'close' | 'terminate'>,
	roomId: string,
	sessionId: string
): boolean {
	try {
		roomHost.getOrCreateRoom(roomId).handleSocketConnect({ sessionId, socket: ws as WebSocket })
		return true
	} catch (err) {
		console.error(`[sync] room ${roomId} failed to attach — closing socket:`, err)
		try {
			ws.close(1011, 'room load failed')
		} catch {
			ws.terminate()
		}
		return false
	}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && bun src/sync-attach.test.ts`
Expected: `ok: sync-attach`, exit 0.

- [ ] **Step 5: Wire into the upgrade handler**

In `server/src/app.ts`, replace the unguarded attach:

```ts
			roomHost.getOrCreateRoom(roomId).handleSocketConnect({ sessionId, socket: ws })
```

with:

```ts
			attachSyncSocket(roomHost, ws, roomId, sessionId)
```

Add the import: `import { attachSyncSocket } from './sync-attach.ts'`.

- [ ] **Step 6: Typecheck + commit**

Run: `bun run typecheck` → PASS.

```bash
git add server/src/sync-attach.ts server/src/sync-attach.test.ts server/src/app.ts
git commit -m "fix(sync): guard room load in WS upgrade — a bad room can't crash the server"
```

---

### Task 2: Per-connection `/sync` logging (open / close / error)

The incident analysis had to infer connection lifetimes from sync-core warning side-effects. Make them explicit.

**Files:**
- Modify: `server/src/app.ts` (inside the `wss.handleUpgrade` callback)

- [ ] **Step 1: Log open, close (with code), and error**

In the `wss.handleUpgrade(req, socket, head, (ws) => { … })` callback, add an open log right after the session bookkeeping, a close log inside the existing `ws.once('close', …)`, and an error handler:

```ts
			console.log(`[sync] open room=${roomId} user=${userId} session=${sessionId}`)
			ws.on('error', (err) =>
				console.warn(`[sync] error room=${roomId} user=${userId} session=${sessionId}: ${err?.message ?? err}`)
			)
```

And extend the existing `ws.once('close', …)` handler to log first (it already receives no args — add the code param):

```ts
			ws.once('close', (code: number) => {
				console.log(`[sync] close room=${roomId} user=${userId} session=${sessionId} code=${code}`)
				userSessions.delete(sessionId)
				// …existing registry cleanup unchanged…
			})
```

- [ ] **Step 2: Typecheck + smoke**

Run: `bun run typecheck` → PASS. With the stack up, reload the canvas and confirm `bin/dev logs sync` shows `[sync] open …` then (on navigate) `[sync] close … code=1001`.

- [ ] **Step 3: Commit**

```bash
git add server/src/app.ts
git commit -m "feat(sync): per-connection open/close/error logging with user+session"
```

---

### Task 3: Backpressure guard — `classifyBackpressure` (TDD) + sampling interval

**Files:**
- Create: `server/src/sync-backpressure.ts`
- Test: `server/src/sync-backpressure.test.ts`
- Modify: `server/src/app.ts` (WeakMap of socket meta + the sampling interval)

- [ ] **Step 1: Write the failing test**

```ts
// classifyBackpressure thresholds: warn at 1MB, close at 4MB.
// Run with: bun src/sync-backpressure.test.ts
import assert from 'node:assert/strict'
import { SYNC_BUFFER_CLOSE, SYNC_BUFFER_WARN, classifyBackpressure } from './sync-backpressure.ts'

assert.equal(classifyBackpressure(0), 'ok')
assert.equal(classifyBackpressure(SYNC_BUFFER_WARN - 1), 'ok')
assert.equal(classifyBackpressure(SYNC_BUFFER_WARN), 'warn')
assert.equal(classifyBackpressure(SYNC_BUFFER_CLOSE - 1), 'warn')
assert.equal(classifyBackpressure(SYNC_BUFFER_CLOSE), 'close')

console.log('ok: sync-backpressure')
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && bun src/sync-backpressure.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Backpressure thresholds for a /sync WebSocket's send buffer. A client that
 * can't drain its socket grows bufferedAmount without bound; unchecked, the
 * sync process eventually OOMs for EVERYONE (prod has no per-service MemoryMax).
 * Mirrors the terminal relay's BROWSER_BUFFER_LIMIT (gateway-registry.ts): warn
 * so it's visible, then close so a fresh reconnect gets a clean snapshot.
 */
export const SYNC_BUFFER_WARN = 1 * 1024 * 1024 // 1 MB
export const SYNC_BUFFER_CLOSE = 4 * 1024 * 1024 // 4 MB

export function classifyBackpressure(bufferedAmount: number): 'ok' | 'warn' | 'close' {
	if (bufferedAmount >= SYNC_BUFFER_CLOSE) return 'close'
	if (bufferedAmount >= SYNC_BUFFER_WARN) return 'warn'
	return 'ok'
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && bun src/sync-backpressure.test.ts`
Expected: `ok: sync-backpressure`, exit 0.

- [ ] **Step 5: Track socket meta + sample on an interval**

In `app.ts`, near the `wss` declaration, add a meta map for logging context:

```ts
	const syncMeta = new WeakMap<WebSocket, { roomId: string; userId: string; sessionId: string }>()
```

Populate it in the upgrade callback (where `ws` is created):

```ts
			syncMeta.set(ws, { roomId, userId, sessionId })
```

After the upgrade handler is wired, add the sampler (before `return { … }`):

```ts
	// Backpressure: a client that can't drain its socket would grow bufferedAmount
	// unbounded and eventually OOM the shared sync process. Sample every ~10s;
	// warn when it crosses 1MB, close at 4MB (a fresh reconnect gets a clean
	// snapshot). unref() so this monitor never keeps the process alive in tests.
	const backpressure = setInterval(() => {
		for (const ws of wss.clients) {
			if (ws.readyState !== ws.OPEN) continue
			const verdict = classifyBackpressure(ws.bufferedAmount)
			if (verdict === 'ok') continue
			const m = syncMeta.get(ws)
			const tag = m ? `room=${m.roomId} user=${m.userId} session=${m.sessionId}` : 'room=?'
			const mb = (ws.bufferedAmount / (1024 * 1024)).toFixed(1)
			if (verdict === 'warn') {
				console.warn(`[sync] backpressure ${mb}MB buffered ${tag}`)
			} else {
				console.warn(`[sync] backpressure ${mb}MB — closing ${tag}`)
				ws.close(1013, 'backpressure')
			}
		}
	}, 10_000)
	backpressure.unref()
```

Add imports: `import { classifyBackpressure } from './sync-backpressure.ts'` and `import type { WebSocket } from 'ws'` (if not already imported).

- [ ] **Step 6: Typecheck + commit**

Run: `bun run typecheck` → PASS.

```bash
git add server/src/sync-backpressure.ts server/src/sync-backpressure.test.ts server/src/app.ts
git commit -m "feat(sync): backpressure guard — warn at 1MB, close /sync socket at 4MB"
```

---

### Task 4: Event-loop lag monitor

**Files:**
- Modify: `server/src/app.ts`

- [ ] **Step 1: Add a 1s drift monitor**

Alongside the backpressure interval (before `return { … }`):

```ts
	// Event-loop lag: a 1s tick that logs when the observed gap exceeds the
	// scheduled 1s by more than 1s — direct evidence for/against event-loop
	// starvation (the incident's leading theory). unref() so it can't hold the
	// process open.
	let lastTick = Date.now()
	const lagMonitor = setInterval(() => {
		const now = Date.now()
		const drift = now - lastTick - 1000
		lastTick = now
		if (drift > 1000) console.warn(`[sync] event-loop lag ${drift}ms`)
	}, 1000)
	lagMonitor.unref()
```

- [ ] **Step 2: Typecheck + commit**

Run: `bun run typecheck` → PASS.

```bash
git add server/src/app.ts
git commit -m "feat(sync): event-loop lag monitor (logs drift > 1s)"
```

---

### Task 5: Live verification + full suite

- [ ] **Step 1: Logging.** Stack up, reload the canvas; `bin/dev logs sync` shows `[sync] open room=team user=… session=…` and, on navigate, `[sync] close … code=…`.

- [ ] **Step 2: Crash-guard sanity.** Confirm normal rooms still attach and sync (canvas loads, edits round-trip). The failure path (corrupt SQLite) is covered by the unit test; do not corrupt a live room.

- [ ] **Step 3: Monitors don't break tests.** Run the full server suite: `bun run --filter '@ensembleworks/server' test` (or the repo `bun run test`) — the `.unref()`'d monitors must not hang it, and no new failures.

- [ ] **Step 4: Regression sweep.** Repo-wide `bun run typecheck` clean; the three new unit tests (`sync-attach`, `sync-backpressure`, plus telemetry from §2) pass.

---

## Self-review notes

- **Spec coverage:** crash-guard around `getOrCreateRoom` (§3) ✓ T1; per-connection `/sync` logging with userId+sessionId ✓ T2; backpressure sample→warn 1MB→close 4MB mirroring `BROWSER_BUFFER_LIMIT` ✓ T3; event-loop lag monitor ✓ T4. `MemoryMax` is an operator change, out of scope (noted).
- **Testability:** the two genuinely unit-testable pieces — the crash-guard behaviour (`attachSyncSocket`) and the thresholds (`classifyBackpressure`) — are TDD'd; the logging and interval wiring are integration, verified by observation (T5). No fake "test" that just re-asserts a console.log.
- **No test hang:** both new intervals are `.unref()`'d; the API tests already `process.exit(0)` for the gateway heartbeat, so this adds no new teardown burden.
- **Ties to §2:** the backpressure thresholds (1MB/4MB) can now be validated against the §2 telemetry from a real degraded session, rather than staying a guess.
