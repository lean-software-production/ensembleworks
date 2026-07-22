# Connection-Health Modal + Single-Tab Enforcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/plans/2026-07-22-connection-health-modal-design.md` (read it first;
this plan implements it verbatim and does not re-litigate any decision in it).

**Goal:** Give the tldraw-v1 canvas one honest "am I connected, and is this the tab
that owns the canvas?" state, and block interaction behind a modal that names exactly
what is wrong when it isn't.

**Architecture:** A pure reducer (`connectionHealth.ts`) holds *all* the logic —
per-transport unhealthy-since stamps, threshold tripping, block precedence, chip
states. Three thin hooks feed it: `useConnectionHealth` (2s probe timer + two
same-origin `fetch`es + the tldraw store status), `useCanvasLock` (a `navigator.locks`
exclusive lock per room+user, oldest wins, `BroadcastChannel` for takeover), and
`useCanvasAvailability` (combines them). `CanvasBlockerModal` renders the dim +
input-swallowing overlay when blocked. No server changes.

**Tech Stack:** React 19 + TypeScript (the `client` workspace), Vite env vars,
`navigator.locks`, `BroadcastChannel`. Tests are bare-`bun` + `node:assert/strict`
colocated `*.test.ts` files (picked up by `scripts/run-tests.ts`'s
`**/src/**/*.test.ts` glob) — **no test may import `tldraw`, `react-dom`, or
`livekit-client` at runtime**, because the tldraw module graph hangs bun on exit
(see `client/src/av/bridge.ts`'s header). Type-only imports are fine.

---

## Context an engineer landing here needs

**Where things already are** (verified, 2026-07-22):

| thing | where |
|---|---|
| tldraw sync store + `store.status` / `store.connectionStatus` | `client/src/App.tsx:74` (`useSync`), derived at `client/src/App.tsx:165` |
| an existing full-screen blocking overlay to copy the styling of | `client/src/App.tsx` — the `wasKicked` block near the end of the JSX |
| LiveKit status, at App level (outside tldraw context) | `useAvSnapshot()` from `client/src/av/bridge.ts:126` → `snap.status` |
| your own latency + trail | `snap.latencies[rawId]` / `snap.latencyHistory[rawId]`, `rawId = rawUserId(identity.id)` (pattern: `client/src/chrome/PanelTile.tsx:108-109`) |
| the sparkline component | `LatencyPill` in `client/src/av/gauges.tsx:129` — props `{ latency: LatencySample \| null; history: number[] }` |
| the recurring-timer seam (use it, not bare `setInterval`) | `scheduler.every(ms, fn)` from `client/src/kernel/scheduler.ts` |
| health endpoints (both same-origin; Caddy routes `/api/terminal/*`) | `server/src/app.ts:305` → `{ok:true,...}`; `server/src/terminal-gateway.ts:192` → `{ok:true,...}` |
| identity / room | `getIdentity()`, `getRoomId()` from `client/src/identity.ts` |
| the env-read-at-the-edge pattern to copy | `client/src/engine.ts` — pure function + a wrapper that reads `import.meta.env` *inside a function*, never at module top level (bare bun evals the module) |

**CI gates you must satisfy:** `bun run typecheck`, `bun run test`, and
`scripts/ux-contract-presence.test.ts`. That last one fires because **Task 8 touches
`client/src/canvas-v2/CanvasV2App.tsx`**, an interaction-bearing path. This change has
no interaction surface in v2 (it adds a comment), so the PR body MUST contain the
literal opt-out line — Task 8 spells it out.

## File Structure

**New — `client/src/canvas-health/`:**

| file | responsibility |
|---|---|
| `constants.ts` | threshold values + `VITE_*` parsing. Pure `readThresholds(env)` + a `getThresholds()` wrapper that touches `import.meta.env`. |
| `constants.test.ts` | parsing/fallback/clamping |
| `connectionHealth.ts` | **all** the logic, pure: `stepHealth`, `trippedTransports`, `transportChip`, `availability`, `countdownSeconds` |
| `connectionHealth.test.ts` | the bulk of the coverage |
| `useConnectionHealth.ts` | probe timer + the two fetches; owns no decisions |
| `useCanvasLock.ts` | `navigator.locks` lifecycle + `BroadcastChannel` takeover |
| `useCanvasAvailability.ts` | 6-line combiner |
| `CanvasBlockerModal.tsx` | overlay + both modal bodies |

**Modified:** `client/src/App.tsx` (mount + render), `client/src/canvas-v2/CanvasV2App.tsx` (TODO marker).

---

### Task 1: Thresholds and env overrides

**Files:**
- Create: `client/src/canvas-health/constants.ts`
- Test: `client/src/canvas-health/constants.test.ts`

- [ ] **Step 1: Write the failing test**

`client/src/canvas-health/constants.test.ts`:

```ts
/**
 * Run: bun client/src/canvas-health/constants.test.ts
 *
 * readThresholds is pure (takes an env record) so it is testable under bare
 * bun — the same split as client/src/engine.ts.
 */
import assert from 'node:assert/strict'
import { DEFAULT_THRESHOLDS, readThresholds } from './constants'

// 1. Empty env → the documented defaults.
assert.deepEqual(readThresholds({}), DEFAULT_THRESHOLDS, 'empty env yields defaults')
assert.equal(DEFAULT_THRESHOLDS.canvasMs, 3000)
assert.equal(DEFAULT_THRESHOLDS.terminalMs, 8000)
assert.equal(DEFAULT_THRESHOLDS.probeIntervalMs, 2000)
assert.equal(DEFAULT_THRESHOLDS.probeTimeoutMs, 4000)

// 2. Each var overrides exactly its own field.
assert.equal(readThresholds({ VITE_CONN_HEALTH_CANVAS_MS: '500' }).canvasMs, 500)
assert.equal(readThresholds({ VITE_CONN_HEALTH_CANVAS_MS: '500' }).terminalMs, 8000, 'other fields untouched')
assert.equal(readThresholds({ VITE_CONN_HEALTH_TERMINAL_MS: '12000' }).terminalMs, 12000)
assert.equal(readThresholds({ VITE_CONN_HEALTH_PROBE_MS: '1000' }).probeIntervalMs, 1000)
assert.equal(readThresholds({ VITE_CONN_HEALTH_TIMEOUT_MS: '9000' }).probeTimeoutMs, 9000)

// 3. Garbage, negative, zero and non-finite values fall back — a typo'd env
//    var must never produce a 0ms probe interval (a busy-loop) or NaN
//    arithmetic that makes every comparison false (i.e. never trips).
for (const bad of ['', 'abc', '-1', '0', 'NaN', 'Infinity', '3s']) {
	assert.equal(readThresholds({ VITE_CONN_HEALTH_CANVAS_MS: bad }).canvasMs, 3000, `"${bad}" falls back`)
}

// 4. Fractional input is floored to whole ms (timers take integers).
assert.equal(readThresholds({ VITE_CONN_HEALTH_PROBE_MS: '1500.7' }).probeIntervalMs, 1500)

console.log('constants.test.ts: all assertions passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun client/src/canvas-health/constants.test.ts`
Expected: FAIL — `Cannot find module './constants'`.

- [ ] **Step 3: Write the implementation**

`client/src/canvas-health/constants.ts`:

```ts
/**
 * Connection-health thresholds.
 *
 * THESE DEFAULTS ARE EDUCATED GUESSES WITH NO FIELD DATA BEHIND THEM YET
 * (design doc §3). They exist to be refined once we have watched real
 * sessions. Lower = faster warning, more false alarms from transient blips;
 * higher = fewer false alarms, longer staring at a subtly-broken canvas.
 * Every one is overridable at build time via a VITE_* env var so a dogfood
 * build can be retuned without a code change.
 *
 * readThresholds is PURE (takes the env record) so it is unit-testable under
 * bare bun; only getThresholds() touches import.meta.env, and it does so
 * inside a function — never at module top level (see client/src/engine.ts for
 * the same split and why).
 */
export interface Thresholds {
	/** Canvas-sync unhealthy for >= this long ⇒ tripped ⇒ blocked. */
	canvasMs: number
	/** Terminals unhealthy for >= this long ⇒ tripped ⇒ blocked. */
	terminalMs: number
	/** Probe cadence: one evaluation of every transport per tick. */
	probeIntervalMs: number
	/** A probe still outstanding after this long counts as a miss. */
	probeTimeoutMs: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
	// Most dangerous plane (edits silently stop syncing) → warn fastest.
	// ~2 failed 2s ticks distinguishes a real drop from one dropped ping.
	canvasMs: 3000,
	// Terminal drops are routine, self-healing, and already show their own
	// per-tile "reconnecting" state → escalate later.
	terminalMs: 8000,
	probeIntervalMs: 2000,
	probeTimeoutMs: 4000,
}

// LiveKit deliberately has NO threshold: it is displayed but never blocking
// (design §3). Do not add one here without changing that decision.

type EnvRecord = Record<string, string | boolean | undefined>

/** Parse a positive whole number of ms, falling back on anything else. */
function positiveMs(raw: string | boolean | undefined, fallback: number): number {
	if (typeof raw !== 'string') return fallback
	const n = Number(raw)
	if (!Number.isFinite(n) || n <= 0) return fallback
	return Math.floor(n)
}

export function readThresholds(env: EnvRecord): Thresholds {
	return {
		canvasMs: positiveMs(env.VITE_CONN_HEALTH_CANVAS_MS, DEFAULT_THRESHOLDS.canvasMs),
		terminalMs: positiveMs(env.VITE_CONN_HEALTH_TERMINAL_MS, DEFAULT_THRESHOLDS.terminalMs),
		probeIntervalMs: positiveMs(env.VITE_CONN_HEALTH_PROBE_MS, DEFAULT_THRESHOLDS.probeIntervalMs),
		probeTimeoutMs: positiveMs(env.VITE_CONN_HEALTH_TIMEOUT_MS, DEFAULT_THRESHOLDS.probeTimeoutMs),
	}
}

/** The live thresholds for this build. Call from a hook, not at module scope. */
export function getThresholds(): Thresholds {
	return readThresholds(import.meta.env as unknown as EnvRecord)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun client/src/canvas-health/constants.test.ts`
Expected: PASS — prints `constants.test.ts: all assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add client/src/canvas-health/constants.ts client/src/canvas-health/constants.test.ts
git commit -m "feat(canvas-health): connection-health thresholds with VITE_ overrides"
```

---

### Task 2: The pure reducer

This is where all the logic lives. Everything downstream is wiring.

**Files:**
- Create: `client/src/canvas-health/connectionHealth.ts`
- Test: `client/src/canvas-health/connectionHealth.test.ts`

- [ ] **Step 1: Write the failing test**

`client/src/canvas-health/connectionHealth.test.ts`:

```ts
/**
 * Run: bun client/src/canvas-health/connectionHealth.test.ts
 *
 * The reducer is the whole feature's logic: threshold tripping, debounce,
 * recovery, block precedence, chip rendering state, countdown. All pure, all
 * driven by an injected `now` — no timers, no fetch, no DOM.
 */
import assert from 'node:assert/strict'
import { DEFAULT_THRESHOLDS } from './constants'
import {
	availability,
	countdownSeconds,
	initialHealth,
	stepHealth,
	syncStoreHealthy,
	transportChip,
	trippedTransports,
	type HealthState,
	type Observations,
} from './connectionHealth'

const T = DEFAULT_THRESHOLDS // canvas 3000, terminals 8000

const ok: Observations = {
	canvas: { healthy: true, rtt: 20 },
	terminals: { healthy: true, rtt: 15 },
	livekit: { healthy: true, rtt: null },
}
function obs(over: Partial<Observations>): Observations {
	return { ...ok, ...over }
}

// ---------------------------------------------------------------- store status
// 1. syncStoreHealthy encodes design §3's canvas-sync store rule.
assert.equal(syncStoreHealthy({ status: 'loading', connectionStatus: null }), true, 'loading is not yet unhealthy')
assert.equal(syncStoreHealthy({ status: 'synced-remote', connectionStatus: 'online' }), true)
assert.equal(syncStoreHealthy({ status: 'synced-remote', connectionStatus: 'offline' }), false)
assert.equal(syncStoreHealthy({ status: 'error', connectionStatus: 'online' }), false, 'error is unhealthy regardless')

// ------------------------------------------------------------------- stamping
// 2. A healthy tick leaves unhealthySince null and records the rtt.
const h1 = stepHealth(initialHealth(), ok, 1000)
assert.equal(h1.canvas.unhealthySince, null)
assert.equal(h1.canvas.rtt, 20)

// 3. Going unhealthy stamps `now` once and does NOT re-stamp on later ticks —
//    otherwise a continuously-broken transport would never reach its threshold.
const h2 = stepHealth(h1, obs({ canvas: { healthy: false, rtt: null } }), 2000)
assert.equal(h2.canvas.unhealthySince, 2000)
const h3 = stepHealth(h2, obs({ canvas: { healthy: false, rtt: null } }), 4000)
assert.equal(h3.canvas.unhealthySince, 2000, 'stamp is sticky while unhealthy')

// 4. A failed probe keeps the LAST KNOWN rtt rather than blanking it — the
//    pill should show the last real measurement, not jump to "—".
assert.equal(h3.canvas.rtt, 20, 'last known rtt survives a failed probe')

// ------------------------------------------------------------------- tripping
// 5. Unhealthy for < threshold is NOT tripped (the debounce: a sub-second flap
//    must never flash the modal).
assert.deepEqual(trippedTransports(h2, 4999, T), [], '2999ms < 3000ms threshold: not tripped')
// 6. >= threshold IS tripped.
assert.deepEqual(trippedTransports(h2, 5000, T), ['canvas'], 'exactly at threshold trips')
assert.deepEqual(trippedTransports(h2, 9000, T), ['canvas'])

// 7. Recovery clears the stamp immediately — one healthy tick un-trips.
const h4 = stepHealth(h3, ok, 6000)
assert.equal(h4.canvas.unhealthySince, null)
assert.deepEqual(trippedTransports(h4, 60_000, T), [], 'recovery un-trips instantly')

// 8. A flap (unhealthy → healthy → unhealthy) restarts the clock.
const f1 = stepHealth(initialHealth(), obs({ canvas: { healthy: false, rtt: null } }), 1000)
const f2 = stepHealth(f1, ok, 2000)
const f3 = stepHealth(f2, obs({ canvas: { healthy: false, rtt: null } }), 2500)
assert.equal(f3.canvas.unhealthySince, 2500, 'clock restarts after recovery')
assert.deepEqual(trippedTransports(f3, 4000, T), [], 'flap does not accumulate toward the threshold')

// 9. Terminals use their own, longer threshold.
const t1 = stepHealth(initialHealth(), obs({ terminals: { healthy: false, rtt: null } }), 0)
assert.deepEqual(trippedTransports(t1, 7999, T), [], 'terminals not tripped before 8000ms')
assert.deepEqual(trippedTransports(t1, 8000, T), ['terminals'])

// 10. Both tripped ⇒ both named, canvas first (stable order for the UI).
const b1 = stepHealth(initialHealth(), obs({
	canvas: { healthy: false, rtt: null },
	terminals: { healthy: false, rtt: null },
}), 0)
assert.deepEqual(trippedTransports(b1, 10_000, T), ['canvas', 'terminals'])

// 11. LiveKit NEVER trips, however long it is down.
const lk = stepHealth(initialHealth(), obs({ livekit: { healthy: false, rtt: null } }), 0)
assert.deepEqual(trippedTransports(lk, 10 * 60_000, T), [], 'livekit is display-only')

// --------------------------------------------------------------- availability
// 12. Healthy + lock held ⇒ not blocked.
assert.deepEqual(
	availability({ health: h4, now: 6000, thresholds: T, hasLock: true }),
	{ blocked: false, reason: null, tripped: [] }
)

// 13. Tripped blocking transport + lock held ⇒ blocked on 'connection'.
assert.deepEqual(
	availability({ health: b1, now: 10_000, thresholds: T, hasLock: true }),
	{ blocked: true, reason: 'connection', tripped: ['canvas', 'terminals'] }
)

// 14. No lock ⇒ 'duplicate-tab', even when everything is healthy.
assert.deepEqual(
	availability({ health: h4, now: 6000, thresholds: T, hasLock: false }),
	{ blocked: true, reason: 'duplicate-tab', tripped: [] }
)

// 15. PRECEDENCE: duplicate-tab wins over connection — no point counting down
//     a reconnect in a tab that should not be active (design §2).
assert.equal(
	availability({ health: b1, now: 10_000, thresholds: T, hasLock: false }).reason,
	'duplicate-tab'
)

// 16. LiveKit down alone never blocks.
assert.equal(availability({ health: lk, now: 10 * 60_000, thresholds: T, hasLock: true }).blocked, false)

// ---------------------------------------------------------------------- chips
// 17. Chip states: connected / degrading (with elapsed) / down.
const chipHealthy = transportChip(h4.canvas, 6000, T.canvasMs)
assert.deepEqual(chipHealthy, { kind: 'connected', unhealthyMs: 0 })
const chipDegrading = transportChip(b1.canvas, 1000, T.canvasMs)
assert.deepEqual(chipDegrading, { kind: 'degrading', unhealthyMs: 1000 })
const chipDown = transportChip(b1.canvas, 5000, T.canvasMs)
assert.deepEqual(chipDown, { kind: 'down', unhealthyMs: 5000 })
// 18. A transport with no threshold (livekit) degrades but never goes down.
assert.deepEqual(transportChip(lk.livekit, 10 * 60_000, null), { kind: 'degrading', unhealthyMs: 600_000 })

// ------------------------------------------------------------------ countdown
// 19. "Retrying in N…" counts whole seconds to the next probe tick, floor 1
//     (never show "Retrying in 0"), and never negative if a tick runs late.
assert.equal(countdownSeconds(1000, 3000), 2)
assert.equal(countdownSeconds(2500, 3000), 1)
assert.equal(countdownSeconds(3000, 3000), 1, 'at the tick boundary, show 1 not 0')
assert.equal(countdownSeconds(4000, 3000), 1, 'a late tick never shows a negative')

console.log('connectionHealth.test.ts: all assertions passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun client/src/canvas-health/connectionHealth.test.ts`
Expected: FAIL — `Cannot find module './connectionHealth'`.

- [ ] **Step 3: Write the implementation**

`client/src/canvas-health/connectionHealth.ts`:

```ts
/**
 * The connection-health reducer — PURE, the whole feature's logic.
 *
 * Given per-transport observations and an injected `now`, it maintains an
 * `unhealthySince` stamp per transport, decides which transports have been
 * unhealthy long enough to trip their threshold, and folds that together with
 * the canvas lock into the single `blocked` + `reason` state the UI renders.
 *
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §2–§4.
 * Everything downstream (useConnectionHealth, useCanvasLock, the modal) is
 * wiring around this file; keep decisions here so they stay testable.
 */
import type { Thresholds } from './constants'

export type TransportId = 'canvas' | 'terminals' | 'livekit'

/** Order matters: it is the UI's row order and the tripped-list order. */
export const TRANSPORTS: readonly TransportId[] = ['canvas', 'terminals', 'livekit']

/**
 * The transports that can BLOCK. LiveKit is deliberately absent: it is
 * measured and displayed but never blocking (design §3).
 */
export const BLOCKING_TRANSPORTS: readonly TransportId[] = ['canvas', 'terminals']

export interface TransportHealth {
	healthy: boolean
	/** When this transport first went unhealthy; null while healthy. */
	unhealthySince: number | null
	/** Last successfully measured round-trip; survives failed probes. */
	rtt: number | null
}

export type HealthState = Record<TransportId, TransportHealth>

export interface Observation {
	healthy: boolean
	/** Measured this tick; null when the probe failed or does not measure. */
	rtt: number | null
}

export type Observations = Record<TransportId, Observation>

export type BlockReason = 'duplicate-tab' | 'connection'

export function initialHealth(): HealthState {
	const blank = (): TransportHealth => ({ healthy: true, unhealthySince: null, rtt: null })
	return { canvas: blank(), terminals: blank(), livekit: blank() }
}

/**
 * The canvas-sync store half of the canvas transport's health (design §3).
 * `synced-remote` is the only status whose connectionStatus is meaningful;
 * `loading` is "not yet", not "broken", so it counts as healthy.
 */
export function syncStoreHealthy(store: { status: string; connectionStatus: string | null }): boolean {
	if (store.status === 'error') return false
	if (store.status === 'synced-remote') return store.connectionStatus === 'online'
	return true
}

/** Fold one tick of observations into the state. Stamps are sticky while unhealthy. */
export function stepHealth(prev: HealthState, obs: Observations, now: number): HealthState {
	const next = {} as HealthState
	for (const id of TRANSPORTS) {
		const was = prev[id]
		const o = obs[id]
		next[id] = {
			healthy: o.healthy,
			// Sticky: only stamp on the healthy→unhealthy edge, so a continuously
			// broken transport actually accumulates time toward its threshold.
			unhealthySince: o.healthy ? null : (was.unhealthySince ?? now),
			// Keep the last real measurement rather than blanking on a miss.
			rtt: o.rtt ?? was.rtt,
		}
	}
	return next
}

function thresholdFor(id: TransportId, t: Thresholds): number | null {
	if (id === 'canvas') return t.canvasMs
	if (id === 'terminals') return t.terminalMs
	return null // livekit: display-only, no threshold, never trips
}

/** Blocking transports that have been unhealthy for >= their threshold. */
export function trippedTransports(health: HealthState, now: number, t: Thresholds): TransportId[] {
	const tripped: TransportId[] = []
	for (const id of BLOCKING_TRANSPORTS) {
		const ms = thresholdFor(id, t)
		const since = health[id].unhealthySince
		if (ms == null || since == null) continue
		if (now - since >= ms) tripped.push(id)
	}
	return tripped
}

export interface Availability {
	blocked: boolean
	reason: BlockReason | null
	tripped: TransportId[]
}

/**
 * The single availability state. Precedence: duplicate-tab beats connection —
 * there is no point counting down a reconnect in a tab that should not be
 * active, so a duplicate tab never shows the connection modal (design §2).
 */
export function availability(input: {
	health: HealthState
	now: number
	thresholds: Thresholds
	hasLock: boolean
}): Availability {
	const tripped = trippedTransports(input.health, input.now, input.thresholds)
	if (!input.hasLock) return { blocked: true, reason: 'duplicate-tab', tripped: [] }
	if (tripped.length > 0) return { blocked: true, reason: 'connection', tripped }
	return { blocked: false, reason: null, tripped: [] }
}

export interface ChipState {
	kind: 'connected' | 'degrading' | 'down'
	unhealthyMs: number
}

/**
 * What one transport's row chip shows. `thresholdMs === null` (LiveKit) means
 * it can degrade but never reads as "down" — it is never blocking, so calling
 * it down would overstate the problem.
 */
export function transportChip(health: TransportHealth, now: number, thresholdMs: number | null): ChipState {
	if (health.unhealthySince == null) return { kind: 'connected', unhealthyMs: 0 }
	const unhealthyMs = Math.max(0, now - health.unhealthySince)
	if (thresholdMs != null && unhealthyMs >= thresholdMs) return { kind: 'down', unhealthyMs }
	return { kind: 'degrading', unhealthyMs }
}

/** The chip threshold for a transport, for callers rendering the row list. */
export function chipThreshold(id: TransportId, t: Thresholds): number | null {
	return thresholdFor(id, t)
}

/**
 * "Retrying in N…" — whole seconds until the next probe tick (each tick IS a
 * retry). Floored at 1 so it never reads "Retrying in 0" and never goes
 * negative when a tick runs late.
 */
export function countdownSeconds(now: number, nextProbeAt: number): number {
	return Math.max(1, Math.ceil((nextProbeAt - now) / 1000))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun client/src/canvas-health/connectionHealth.test.ts`
Expected: PASS — prints `connectionHealth.test.ts: all assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add client/src/canvas-health/connectionHealth.ts client/src/canvas-health/connectionHealth.test.ts
git commit -m "feat(canvas-health): pure connection-health reducer (thresholds, precedence, chips)"
```

---

### Task 3: The probe hook

**Files:**
- Create: `client/src/canvas-health/useConnectionHealth.ts`
- Test: `client/src/canvas-health/probe.test.ts`

The hook itself is untestable under bare bun (it is React + fetch), so the one
piece with a decision in it — turning two probe results plus the store status
into `Observations` — is extracted as a pure function and tested. The React
shell around it is deliberately decision-free.

- [ ] **Step 1: Write the failing test**

`client/src/canvas-health/probe.test.ts`:

```ts
/**
 * Run: bun client/src/canvas-health/probe.test.ts
 *
 * Covers the one decision inside the probe hook — folding two endpoint probe
 * results plus the tldraw store status into the reducer's Observations. The
 * React/timer shell around it holds no decisions and is covered by the manual
 * smoke in the design doc §8.
 */
import assert from 'node:assert/strict'
import { toObservations } from './useConnectionHealth'

const store = { status: 'synced-remote', connectionStatus: 'online' }

// 1. Everything up.
assert.deepEqual(
	toObservations({
		store,
		canvasProbe: { ok: true, rtt: 25 },
		terminalProbe: { ok: true, rtt: 30 },
		livekitStatus: 'connected',
	}),
	{
		canvas: { healthy: true, rtt: 25 },
		terminals: { healthy: true, rtt: 30 },
		livekit: { healthy: true, rtt: null },
	}
)

// 2. The store flips instantly on a clean WS close even while the ping still
//    succeeds — fast detection is the whole point of using both signals.
assert.equal(
	toObservations({
		store: { status: 'synced-remote', connectionStatus: 'offline' },
		canvasProbe: { ok: true, rtt: 25 },
		terminalProbe: { ok: true, rtt: 30 },
		livekitStatus: 'connected',
	}).canvas.healthy,
	false
)

// 3. The ping catches a wedged-but-"open" socket the store still calls online.
assert.equal(
	toObservations({
		store,
		canvasProbe: { ok: false, rtt: null },
		terminalProbe: { ok: true, rtt: 30 },
		livekitStatus: 'connected',
	}).canvas.healthy,
	false
)

// 4. Terminals are endpoint-only, and a terminal failure does not touch canvas.
const t = toObservations({
	store,
	canvasProbe: { ok: true, rtt: 25 },
	terminalProbe: { ok: false, rtt: null },
	livekitStatus: 'connected',
})
assert.equal(t.terminals.healthy, false)
assert.equal(t.canvas.healthy, true)

// 5. LiveKit: only 'connected' is healthy; 'disabled' counts as healthy too —
//    a room with A/V switched off must not sit permanently degraded.
for (const s of ['connecting', 'reconnecting', 'retrying', 'error']) {
	assert.equal(
		toObservations({ store, canvasProbe: { ok: true, rtt: 1 }, terminalProbe: { ok: true, rtt: 1 }, livekitStatus: s }).livekit.healthy,
		false,
		`livekit "${s}" is degraded`
	)
}
for (const s of ['connected', 'disabled']) {
	assert.equal(
		toObservations({ store, canvasProbe: { ok: true, rtt: 1 }, terminalProbe: { ok: true, rtt: 1 }, livekitStatus: s }).livekit.healthy,
		true,
		`livekit "${s}" is healthy`
	)
}

console.log('probe.test.ts: all assertions passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun client/src/canvas-health/probe.test.ts`
Expected: FAIL — `Cannot find module './useConnectionHealth'`.

- [ ] **Step 3: Write the implementation**

`client/src/canvas-health/useConnectionHealth.ts`:

```ts
/**
 * The probe: one timer that evaluates every transport each tick.
 *
 * Canvas health is BOTH signals — the tldraw store status (flips instantly on
 * a clean WS close, so detection is fast) AND a GET /api/health ping (catches
 * a wedged-but-"open" socket, and supplies the RTT). Terminals are endpoint-
 * based so they work with zero terminal shapes open. LiveKit is read from the
 * A/V bridge and is display-only.
 *
 * All decisions live in toObservations + the reducer; this file is wiring.
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §3.
 */
import { useEffect, useRef, useState } from 'react'
import { scheduler } from '../kernel/scheduler'
import { getThresholds, type Thresholds } from './constants'
import { initialHealth, stepHealth, syncStoreHealthy, type HealthState, type Observations } from './connectionHealth'

export interface ProbeResult {
	ok: boolean
	rtt: number | null
}

export interface StoreStatus {
	status: string
	connectionStatus: string | null
}

/** Fold this tick's raw readings into reducer observations. Pure. */
export function toObservations(input: {
	store: StoreStatus
	canvasProbe: ProbeResult
	terminalProbe: ProbeResult
	livekitStatus: string
}): Observations {
	return {
		canvas: {
			healthy: syncStoreHealthy(input.store) && input.canvasProbe.ok,
			rtt: input.canvasProbe.rtt,
		},
		terminals: {
			healthy: input.terminalProbe.ok,
			rtt: input.terminalProbe.rtt,
		},
		livekit: {
			// 'disabled' is a room with A/V off, not a fault — treating it as
			// degraded would leave that row permanently amber for no reason.
			healthy: input.livekitStatus === 'connected' || input.livekitStatus === 'disabled',
			rtt: null,
		},
	}
}

/** GET a health endpoint with a hard timeout, measuring the round-trip. */
async function probe(url: string, timeoutMs: number): Promise<ProbeResult> {
	const started = Date.now()
	const abort = new AbortController()
	const timer = setTimeout(() => abort.abort(), timeoutMs)
	try {
		const res = await fetch(url, { signal: abort.signal, cache: 'no-store' })
		if (!res.ok) return { ok: false, rtt: null }
		const body = (await res.json()) as { ok?: boolean }
		if (body?.ok !== true) return { ok: false, rtt: null }
		return { ok: true, rtt: Date.now() - started }
	} catch {
		// Timeout, network error, or non-JSON body — all count as a miss.
		return { ok: false, rtt: null }
	} finally {
		clearTimeout(timer)
	}
}

export interface ConnectionHealth {
	health: HealthState
	thresholds: Thresholds
	/** Timestamp of the next scheduled probe tick, for the countdown. */
	nextProbeAt: number
}

export function useConnectionHealth(input: { store: StoreStatus; livekitStatus: string }): ConnectionHealth {
	const [thresholds] = useState(getThresholds)
	const [health, setHealth] = useState(initialHealth)
	const [nextProbeAt, setNextProbeAt] = useState(() => Date.now() + thresholds.probeIntervalMs)

	// The timer callback must see the latest store/livekit status without
	// re-subscribing the interval on every status change (which would reset
	// the cadence and, worse, restart the debounce clock).
	const latest = useRef(input)
	latest.current = input

	useEffect(() => {
		let cancelled = false
		const tick = async () => {
			const [canvasProbe, terminalProbe] = await Promise.all([
				probe('/api/health', thresholds.probeTimeoutMs),
				probe('/api/terminal/health', thresholds.probeTimeoutMs),
			])
			if (cancelled) return
			const obs = toObservations({
				store: latest.current.store,
				canvasProbe,
				terminalProbe,
				livekitStatus: latest.current.livekitStatus,
			})
			const now = Date.now()
			setHealth((prev) => stepHealth(prev, obs, now))
			setNextProbeAt(now + thresholds.probeIntervalMs)
		}
		void tick() // probe immediately; don't wait a full interval for the first reading
		const cancel = scheduler.every(thresholds.probeIntervalMs, () => void tick())
		return () => {
			cancelled = true
			cancel()
		}
	}, [thresholds])

	return { health, thresholds, nextProbeAt }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun client/src/canvas-health/probe.test.ts`
Expected: PASS — prints `probe.test.ts: all assertions passed`.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run --filter '@ensembleworks/client' typecheck
git add client/src/canvas-health/useConnectionHealth.ts client/src/canvas-health/probe.test.ts
git commit -m "feat(canvas-health): probe hook (store status + /api/health + /api/terminal/health)"
```

---

### Task 4: The canvas lock (single active tab, oldest wins)

**Files:**
- Create: `client/src/canvas-health/useCanvasLock.ts`
- Test: `client/src/canvas-health/lockNames.test.ts`

- [ ] **Step 1: Write the failing test**

`client/src/canvas-health/lockNames.test.ts`:

```ts
/**
 * Run: bun client/src/canvas-health/lockNames.test.ts
 *
 * The lock hook is browser-API lifecycle (navigator.locks + BroadcastChannel)
 * and is validated by the manual smoke (design §8). What IS worth pinning is
 * the channel/lock NAMING: the scope is (room, user), so two real
 * collaborators must never contend, and a room id containing a separator must
 * not collide with a different room.
 */
import assert from 'node:assert/strict'
import { canvasLockName } from './useCanvasLock'

// 1. Same room + same user ⇒ same name (that is what makes tab 2 contend).
assert.equal(canvasLockName('team', 'alice'), canvasLockName('team', 'alice'))

// 2. Different user, same room ⇒ different names: real collaborators never
//    block each other. This is THE property the whole feature rests on.
assert.notEqual(canvasLockName('team', 'alice'), canvasLockName('team', 'bob'))

// 3. Different room, same user ⇒ different names.
assert.notEqual(canvasLockName('team', 'alice'), canvasLockName('design', 'alice'))

// 4. Ids are encoded, so a separator inside a room id cannot forge another
//    (room, user) pair.
assert.notEqual(canvasLockName('a-b', 'c'), canvasLockName('a', 'b-c'))

// 5. The documented prefix, so it is recognisable in devtools.
assert.ok(canvasLockName('team', 'alice').startsWith('ew-canvas-'))

console.log('lockNames.test.ts: all assertions passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun client/src/canvas-health/lockNames.test.ts`
Expected: FAIL — `Cannot find module './useCanvasLock'`.

- [ ] **Step 3: Write the implementation**

`client/src/canvas-health/useCanvasLock.ts`:

```ts
/**
 * Single active tab per (room, user) — OLDEST WINS.
 *
 * The tab holding an exclusive navigator.locks lock is the active one. A
 * second tab cannot acquire it, learns it is the duplicate, and blocks. This
 * deliberately REVERSES the A/V "newest steals the slot" behaviour, which is
 * the bug behind issue #55 (DUPLICATE_IDENTITY kills, doubled cursors).
 *
 * Web Locks does not notify a holder that someone wants its lock, so takeover
 * rides a BroadcastChannel: the newcomer's "Use it here" posts {type:
 * 'takeover'}; the holder releases and blocks itself; the freed lock is then
 * acquired by whoever is waiting.
 *
 * Crash-safety is the lock's job — a dead tab's lock is auto-released by the
 * browser, so there is no stale-lock cleanup here.
 *
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §5.
 */
import { useEffect, useRef, useState } from 'react'

/** Scope is (room, user); components are encoded so ids can't forge a pair. */
export function canvasLockName(roomId: string, userId: string): string {
	return `ew-canvas-${encodeURIComponent(roomId)}-${encodeURIComponent(userId)}`
}

export interface CanvasLock {
	/** True when this tab owns the canvas (or when locks are unsupported). */
	hasLock: boolean
	/** Ask the current holder to hand over. No-op when we already hold it. */
	requestTakeover: () => void
}

interface LockManagerLike {
	request(
		name: string,
		options: { mode: 'exclusive'; signal?: AbortSignal },
		cb: (lock: unknown) => Promise<void>
	): Promise<void>
}

function getLockManager(): LockManagerLike | null {
	const locks = (navigator as unknown as { locks?: LockManagerLike }).locks
	return locks ?? null
}

export function useCanvasLock(roomId: string, userId: string): CanvasLock {
	// Fallback: no navigator.locks (or no BroadcastChannel) ⇒ single-tab
	// enforcement is best-effort and simply never blocks. It must never be a
	// hard dependency (design §5).
	const supported = typeof BroadcastChannel !== 'undefined' && getLockManager() != null
	const [hasLock, setHasLock] = useState(supported ? false : true)
	const channelRef = useRef<BroadcastChannel | null>(null)

	useEffect(() => {
		if (!supported) return
		const name = canvasLockName(roomId, userId)
		const locks = getLockManager()
		if (!locks) return

		const channel = new BroadcastChannel(name)
		channelRef.current = channel
		let disposed = false
		// Aborting this signal is how we drop the lock on unmount/takeover:
		// resolving the holder callback's promise is the only way to release.
		let release: (() => void) | null = null

		const acquire = () => {
			if (disposed) return
			void locks
				.request(name, { mode: 'exclusive' }, () => {
					if (disposed) return Promise.resolve()
					setHasLock(true)
					// Hold until explicitly released (unmount, or a takeover).
					return new Promise<void>((resolve) => {
						release = () => {
							release = null
							setHasLock(false)
							resolve()
						}
					})
				})
				.catch(() => {
					// A rejected request (e.g. the page is being torn down) simply
					// leaves this tab blocked; the modal explains why.
				})
		}

		channel.onmessage = (ev: MessageEvent) => {
			const data = ev.data as { type?: string } | null
			if (data?.type !== 'takeover') return
			if (!release) return // we don't hold it; nothing to give up
			// Hand over: release, block ourselves, and DON'T re-queue — oldest
			// wins means the tab that just took over keeps it until it asks.
			release()
		}

		acquire()

		return () => {
			disposed = true
			release?.()
			channel.close()
			channelRef.current = null
		}
	}, [supported, roomId, userId])

	const requestTakeover = () => {
		if (hasLock) return
		channelRef.current?.postMessage({ type: 'takeover' })
		// The holder's release frees the lock; our still-queued request then
		// resolves and flips hasLock. Nothing else to do here.
	}

	return { hasLock, requestTakeover }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun client/src/canvas-health/lockNames.test.ts`
Expected: PASS — prints `lockNames.test.ts: all assertions passed`.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run --filter '@ensembleworks/client' typecheck
git add client/src/canvas-health/useCanvasLock.ts client/src/canvas-health/lockNames.test.ts
git commit -m "feat(canvas-health): navigator.locks single-tab enforcement (oldest wins)"
```

---

### Task 5: The combiner hook

**Files:**
- Create: `client/src/canvas-health/useCanvasAvailability.ts`

No new test: this hook contains no decision that isn't already covered by
`connectionHealth.test.ts` assertions 12–16 (`availability` precedence).

- [ ] **Step 1: Write the implementation**

`client/src/canvas-health/useCanvasAvailability.ts`:

```ts
/**
 * The single "can I interact with this canvas right now?" state.
 *
 *   interactive ⇔ (every BLOCKING transport is healthy) ∧ (this tab holds the lock)
 *
 * Combines the probe and the lock through the pure `availability` reducer —
 * this file adds no decisions of its own.
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §2.
 */
import { useEffect, useState } from 'react'
import { scheduler } from '../kernel/scheduler'
import type { Availability, HealthState } from './connectionHealth'
import { availability } from './connectionHealth'
import type { Thresholds } from './constants'
import { useCanvasLock } from './useCanvasLock'
import { useConnectionHealth, type StoreStatus } from './useConnectionHealth'

/** How often the "degrading (Ns)" / "Retrying in N…" readouts re-render. */
const CLOCK_TICK_MS = 250

export interface CanvasAvailability extends Availability {
	health: HealthState
	thresholds: Thresholds
	nextProbeAt: number
	/** `Date.now()` as of the last UI clock tick — pass to the pure renderers. */
	now: number
	requestTakeover: () => void
}

export function useCanvasAvailability(input: {
	roomId: string
	userId: string
	store: StoreStatus
	livekitStatus: string
}): CanvasAvailability {
	const { health, thresholds, nextProbeAt } = useConnectionHealth({
		store: input.store,
		livekitStatus: input.livekitStatus,
	})
	const { hasLock, requestTakeover } = useCanvasLock(input.roomId, input.userId)

	// A transport trips on ELAPSED time, not on an event, so the state must be
	// re-evaluated between probe ticks — otherwise a threshold longer than the
	// probe interval would only trip on the next probe, and the countdown/
	// "degrading (Ns)" readouts would freeze.
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => scheduler.every(CLOCK_TICK_MS, () => setNow(Date.now())), [])

	return {
		...availability({ health, now, thresholds, hasLock }),
		health,
		thresholds,
		nextProbeAt,
		now,
		requestTakeover,
	}
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter '@ensembleworks/client' typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/canvas-health/useCanvasAvailability.ts
git commit -m "feat(canvas-health): useCanvasAvailability combiner"
```

---

### Task 6: The blocker modal + overlay

**Files:**
- Create: `client/src/canvas-health/CanvasBlockerModal.tsx`
- Test: `client/src/canvas-health/modalCopy.test.ts`

- [ ] **Step 1: Write the failing test**

`client/src/canvas-health/modalCopy.test.ts`:

```ts
/**
 * Run: bun client/src/canvas-health/modalCopy.test.ts
 *
 * The modal's rendering is trivial JSX; its one decision is the copy — which
 * transports the headline names. Extracted as a pure function so it is
 * testable without react-dom (and without dragging tldraw into a bare-bun
 * process, which hangs on exit — see client/src/av/bridge.ts's header).
 */
import assert from 'node:assert/strict'
import { blockedSummary, transportLabel } from './CanvasBlockerModal'

assert.equal(transportLabel('canvas'), 'Canvas')
assert.equal(transportLabel('terminals'), 'Terminals')
assert.equal(transportLabel('livekit'), 'Video')

assert.equal(blockedSummary([]), 'Checking your connection…')
assert.equal(blockedSummary(['canvas']), 'Canvas sync is not reaching the server.')
assert.equal(blockedSummary(['terminals']), 'Terminals are not reaching the server.')
assert.equal(blockedSummary(['canvas', 'terminals']), 'Canvas sync and terminals are not reaching the server.')

console.log('modalCopy.test.ts: all assertions passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun client/src/canvas-health/modalCopy.test.ts`
Expected: FAIL — `Cannot find module './CanvasBlockerModal'`.

- [ ] **Step 3: Write the implementation**

`client/src/canvas-health/CanvasBlockerModal.tsx`:

```tsx
/**
 * The blocker: one overlay, two reasons. Renders only when blocked, and
 * auto-dismisses the instant the blocking condition clears (it is a pure
 * function of useCanvasAvailability — there is no dismiss button by design).
 *
 * The overlay both DIMS the canvas and SWALLOWS input: a capture-phase
 * keydown/pointerdown stop, so a stray key cannot fire a tldraw shortcut into
 * a canvas that can't sync it.
 *
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §4.
 */
import { useEffect, useRef } from 'react'
import { LatencyPill } from '../av/gauges'
import type { LatencySample } from '../av/useSessionPulse'
import {
	chipThreshold,
	countdownSeconds,
	transportChip,
	TRANSPORTS,
	type BlockReason,
	type HealthState,
	type TransportId,
} from './connectionHealth'
import type { Thresholds } from './constants'

export function transportLabel(id: TransportId): string {
	if (id === 'canvas') return 'Canvas'
	if (id === 'terminals') return 'Terminals'
	return 'Video'
}

/** The connection headline's second line: which transports are actually down. */
export function blockedSummary(tripped: readonly TransportId[]): string {
	if (tripped.length === 0) return 'Checking your connection…'
	const names = tripped.map((id) => (id === 'canvas' ? 'Canvas sync' : 'terminals'))
	if (names.length === 1) {
		const one = names[0]
		return one === 'Canvas sync'
			? 'Canvas sync is not reaching the server.'
			: 'Terminals are not reaching the server.'
	}
	return `${names[0]} and ${names.slice(1).join(', ')} are not reaching the server.`
}

const CHIP_STYLE: Record<'connected' | 'degrading' | 'down', { text: string; color: string }> = {
	connected: { text: '✓ connected', color: '#15803d' },
	degrading: { text: '⏳ degrading', color: '#b45309' },
	down: { text: '✗ down', color: '#b91c1c' },
}

function TransportRow(props: {
	id: TransportId
	health: HealthState
	now: number
	thresholds: Thresholds
	tripped: readonly TransportId[]
}) {
	const chip = transportChip(props.health[props.id], props.now, chipThreshold(props.id, props.thresholds))
	const style = CHIP_STYLE[chip.kind]
	const isTripped = props.tripped.includes(props.id)
	const secs = Math.round(chip.unhealthyMs / 1000)
	return (
		<div
			style={{
				display: 'flex',
				justifyContent: 'space-between',
				gap: 16,
				padding: '4px 8px',
				borderRadius: 3,
				background: isTripped ? 'rgba(185,28,28,0.08)' : 'transparent',
				fontWeight: isTripped ? 600 : 400,
			}}
		>
			<span>{transportLabel(props.id)}</span>
			<span style={{ color: style.color }}>
				{style.text}
				{chip.kind === 'degrading' ? ` (${secs}s)` : ''}
			</span>
		</div>
	)
}

export function CanvasBlockerModal(props: {
	reason: BlockReason
	tripped: readonly TransportId[]
	health: HealthState
	thresholds: Thresholds
	now: number
	nextProbeAt: number
	latency: LatencySample | null
	latencyHistory: number[]
	onTakeover: () => void
}) {
	const overlayRef = useRef<HTMLDivElement>(null)

	// Swallow input at the window's capture phase for as long as we are
	// mounted. Listening on the overlay element alone is not enough: keyboard
	// events go to document.activeElement, which may still be a tldraw node.
	useEffect(() => {
		const swallow = (ev: Event) => {
			if (overlayRef.current?.contains(ev.target as Node)) return // let the modal's own buttons work
			ev.stopPropagation()
			ev.preventDefault()
		}
		const opts = { capture: true } as const
		window.addEventListener('keydown', swallow, opts)
		window.addEventListener('pointerdown', swallow, opts)
		return () => {
			window.removeEventListener('keydown', swallow, opts)
			window.removeEventListener('pointerdown', swallow, opts)
		}
	}, [])

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				display: 'grid',
				placeItems: 'center',
				background: 'rgba(15,23,42,0.35)',
				backdropFilter: 'saturate(0.4)',
				zIndex: 10001, // above the wasKicked overlay's 10000
			}}
		>
			<div
				ref={overlayRef}
				style={{
					background: '#fafaf7',
					border: '1px solid rgba(15,23,42,0.22)',
					borderRadius: 4,
					padding: 24,
					minWidth: 320,
					boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
					fontFamily: 'system-ui, sans-serif',
					fontSize: 13,
				}}
			>
				{props.reason === 'duplicate-tab' ? (
					<>
						<strong style={{ fontSize: 15 }}>This canvas is open in another tab</strong>
						<div style={{ marginTop: 8 }}>
							Only one tab per person can drive the canvas — a second one would double your
							cursor and knock your microphone off the call. That other tab is active right now.
						</div>
						<button
							type="button"
							onClick={props.onTakeover}
							style={{ marginTop: 16, padding: '6px 12px', borderRadius: 3, cursor: 'pointer' }}
						>
							Use it here
						</button>
					</>
				) : (
					<>
						<strong style={{ fontSize: 15 }}>Lost connection to the server</strong>
						<div style={{ marginTop: 8 }}>{blockedSummary(props.tripped)}</div>
						<div style={{ marginTop: 16, display: 'grid', gap: 2 }}>
							{TRANSPORTS.map((id) => (
								<TransportRow
									key={id}
									id={id}
									health={props.health}
									now={props.now}
									thresholds={props.thresholds}
									tripped={props.tripped}
								/>
							))}
						</div>
						<div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
							<span>Latency</span>
							<LatencyPill latency={props.latency} history={props.latencyHistory} />
						</div>
						<div style={{ marginTop: 12, color: 'rgba(15,23,42,0.6)' }}>
							Retrying in {countdownSeconds(props.now, props.nextProbeAt)}…
						</div>
					</>
				)}
			</div>
		</div>
	)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun client/src/canvas-health/modalCopy.test.ts`
Expected: PASS — prints `modalCopy.test.ts: all assertions passed`.

> If this fails with a JSX/parse error, the test is importing a `.tsx` under
> bare bun and bun is transpiling it — that is supported. It must NOT fail with
> a hang; if it hangs, something in the import graph pulled in `tldraw`. Check
> that `../av/gauges` does not import `tldraw` and, if it does, move
> `transportLabel`/`blockedSummary` into `connectionHealth.ts` and re-point the
> test there.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run --filter '@ensembleworks/client' typecheck
git add client/src/canvas-health/CanvasBlockerModal.tsx client/src/canvas-health/modalCopy.test.ts
git commit -m "feat(canvas-health): blocker modal + input-swallowing overlay"
```

---

### Task 7: Wire into the live tldraw-v1 engine

**Files:**
- Modify: `client/src/App.tsx` (the `syncStatus` derivation around line 165, and the JSX return)

- [ ] **Step 1: Add the imports**

At the top of `client/src/App.tsx`, alongside the existing imports:

```ts
import { rawUserId } from '@ensembleworks/contracts'
import { useAvSnapshot } from './av/bridge'
import { CanvasBlockerModal } from './canvas-health/CanvasBlockerModal'
import { useCanvasAvailability } from './canvas-health/useCanvasAvailability'
```

(`rawUserId` may already be imported — check before adding a duplicate.)

- [ ] **Step 2: Mount the hook**

Immediately after the existing `syncStatus` derivation (`client/src/App.tsx:165`),
add:

```ts
	// The unified availability state: is this browser actually connected, and
	// is this the tab that owns the canvas? Blocks interaction behind a modal
	// when not (docs/plans/2026-07-22-connection-health-modal-design.md).
	// LiveKit status comes through the A/V bridge because useLiveKitRoom lives
	// inside tldraw context (AvOverlay), not here.
	const avSnap = useAvSnapshot()
	const rawId = rawUserId(identity.id)
	const availability = useCanvasAvailability({
		roomId,
		userId: identity.id,
		store: {
			status: store.status,
			connectionStatus: store.status === 'synced-remote' ? store.connectionStatus : null,
		},
		livekitStatus: avSnap?.status ?? 'disabled',
	})
```

- [ ] **Step 3: Render the modal**

In the returned JSX, add a sibling immediately **before** the existing
`{wasKicked && (...)}` block:

```tsx
			{availability.blocked && availability.reason && (
				<CanvasBlockerModal
					reason={availability.reason}
					tripped={availability.tripped}
					health={availability.health}
					thresholds={availability.thresholds}
					now={availability.now}
					nextProbeAt={availability.nextProbeAt}
					latency={avSnap?.latencies[rawId] ?? null}
					latencyHistory={avSnap?.latencyHistory[rawId] ?? []}
					onTakeover={availability.requestTakeover}
				/>
			)}
```

- [ ] **Step 4: Typecheck and run the full suite**

```bash
bun run --filter '@ensembleworks/client' typecheck
bun run test
```

Expected: typecheck clean; the test run ends with `all N suites passed`.

- [ ] **Step 5: Manual smoke (design §8) — do not skip**

```bash
bin/dev up
bin/dev status --json 2>/dev/null
```

Open the room in Chrome, then verify all three:

1. **Network drop** — DevTools → Network → Offline. The modal appears within
   ~3s, the Canvas row is highlighted and reads `✗ down`, the countdown ticks.
   Go back online: it auto-dismisses with no click.
2. **Second tab** — open the same room URL in a second tab. The *new* tab shows
   "This canvas is open in another tab". Click **Use it here**: the new tab
   unblocks and the *original* tab flips to the duplicate modal.
3. **Video-only drop** — stop the LiveKit container
   (`bin/dev restart livekit`, or block its host in DevTools). The Video row
   goes `⏳ degrading` but the canvas stays fully interactive — **no modal**.

- [ ] **Step 6: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat(client): block canvas interaction on connection loss or duplicate tab"
```

---

### Task 8: canvas-v2 parity marker

**Files:**
- Modify: `client/src/canvas-v2/CanvasV2App.tsx`

- [ ] **Step 1: Add the marker**

Find the sync-setup site in `client/src/canvas-v2/CanvasV2App.tsx` (where
`SyncClientPeer` / the ws transport is created) and add directly above it:

```ts
	// TODO(canvas-v2 connection-health): v2 does not use tldraw's useSync, so
	// the connection-health probe cannot read store.status here. Before v2
	// becomes the live engine, expose this peer's connection state (open /
	// closed / reconnecting) in the shape useConnectionHealth expects for the
	// canvas transport, then mount useCanvasAvailability + CanvasBlockerModal
	// the way App.tsx does.
	// See docs/plans/2026-07-22-connection-health-modal-design.md §7.
```

- [ ] **Step 2: Verify the presence gate is satisfiable**

Run: `bun scripts/ux-contract-presence.test.ts`

This diff touches `client/src/canvas-v2/`, an interaction-bearing prefix, so the
gate demands either a contracts-module change or an opt-out marker in the PR body.
A comment-only change has no interaction surface, so the opt-out is correct. The
PR body MUST contain, verbatim:

```
ux-contract: none — comment-only marker in canvas-v2; the feature ships in
client/src/canvas-health/ and client/src/App.tsx, neither of which is a canvas
tool, renderer, or input surface.
```

Locally the gate may skip (no `origin/main` base / no PR-body env var) — that is
expected and is not a pass. The check that matters runs in CI once the PR exists.

- [ ] **Step 3: Full verification**

```bash
bun run typecheck
bun run test
bun run build
```

Expected: all three clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/canvas-v2/CanvasV2App.tsx
git commit -m "docs(canvas-v2): mark the connection-health parity work at the sync-setup site"
```

---

## Spec coverage

| design § | covered by |
|---|---|
| §2 unified state + precedence | Task 2 (`availability`, assertions 12–16), Task 5 |
| §3 probe, per-transport rules, debounce | Task 2 (assertions 1–11), Task 3 |
| §3 thresholds + `VITE_*` overrides | Task 1 |
| §4 modal, overlay, transport rows, LatencyPill, countdown | Task 6 |
| §5 lock, oldest-wins, takeover, fallback | Task 4 |
| §6 files | Tasks 1–8 (exact paths as specified) |
| §7 canvas-v2 parity marker | Task 8 |
| §8 testing (reducer unit tests + manual smoke) | Tasks 1–6 tests, Task 7 step 5 |
| §9 non-goals | nothing here touches the transports or the tldraw focus bug |

## Known deviations from the spec

1. **Directory name.** The spec says `client/src/canvas-health/`; this plan uses
   exactly that. No deviation — noted only because the design's prose elsewhere
   says "canvas-v2 shares the A/V hook", which is unchanged.
2. **`livekitStatus: 'disabled'` counts as healthy.** The spec says only
   `'connected'` is healthy. A room with A/V switched off would otherwise sit
   permanently amber for no reason, and LiveKit is display-only, so this is
   cosmetic and blocks nothing. Flagged here rather than silently absorbed.
3. **A 250ms UI clock in `useCanvasAvailability`.** Not in the spec, but
   required: tripping is a function of elapsed time, so with only the 2s probe
   tick a 3s canvas threshold would trip up to 2s late and the countdown and
   "degrading (Ns)" readouts would visibly freeze between probes.
