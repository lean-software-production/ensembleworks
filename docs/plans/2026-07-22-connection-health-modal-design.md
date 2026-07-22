# Connection-Health Modal + Single-Tab Enforcement — Design

> **Status:** DESIGN (brainstormed 2026-07-22). Implementation plan follows
> separately (superpowers:writing-plans). This doc is the agreed spec.

**Goal:** Give the canvas a single, honest "is this browser actually connected to
the server, and is this the tab that owns the canvas?" state, and when it isn't,
**block interaction behind a modal** that says exactly what's wrong — instead of
today's confusing split where A/V shows "reconnecting" while the canvas looks
interactive but silently can't type/sync.

**Architecture:** One `useCanvasAvailability` hook combines two inputs into a
single `blocked` state with a `reason`:
1. **`useConnectionHealth`** — a probe that independently measures each transport
   (canvas-sync, terminals, LiveKit) and trips per-transport staleness thresholds.
2. **`useCanvasLock`** — a `navigator.locks` exclusive lock per (room, user) that
   enforces one active tab per canvas (oldest wins).

When `blocked`, a shared **`CanvasBlockerModal` + gray-out/input-block overlay**
renders; it auto-dismisses the instant the blocking condition clears. LiveKit is
**shown but never blocking**. The RTT sparkline is the existing `LatencyPill`.

**Tech stack:** React + TypeScript (client workspace). Reuses existing signals —
tldraw sync `store.status`/`connectionStatus`, `LiveKitState.status`, the
`useSessionPulse` latency trail, and the `/api/health` + `/api/terminal/health`
endpoints. New browser API: `navigator.locks`. No server changes.

**Scope:** Wire into the **live tldraw-v1 engine (`client/src/App.tsx`)**.
canvas-v2 shares the A/V hook but has its own sync layer (`SyncClientPeer`) and
must wire the probe separately — tracked as a parity follow-up (see §7).

---

## 1. Motivation

The canvas runs **three independent transports**, all tunnelled over the same
client → Cloudflare edge → origin path but with separate sockets and separate (or
missing) UI signals:

| plane | transport | today's failure signal |
|---|---|---|
| Canvas sync | tldraw `useSync` WebSocket | none visible; edits silently stop syncing |
| Terminals | per-shape WebSocket | per-tile "Connection lost — reconnecting" only |
| A/V | LiveKit WebRTC | the A/V panel's "reconnecting" |

Real incidents (see the laingville triage notes and issues #54, #55): a user's
network dropped, A/V showed "reconnecting", the canvas *looked* interactive, a
terminal accepted edit-mode but swallowed keystrokes. Three signals, no unified
truth, maximum confusion.

This feature makes the truth explicit and gates interaction on it, and folds in
single-tab enforcement (issue #55) because a second tab is the *same* class of
"you can't safely interact right now" problem and reuses the same modal.

## 2. The unified availability state

```
interactive  ⇔  (every BLOCKING transport is healthy)  ∧  (this tab holds the canvas lock)
```

`useCanvasAvailability(): { blocked: boolean; reason: BlockReason | null; health: ConnectionHealth }`

`type BlockReason = 'duplicate-tab' | 'connection'`

Precedence when both apply: **`duplicate-tab` wins** — there is no point counting
down a reconnect in a tab that should not be active. A duplicate tab shows the
takeover modal; only the lock-holding tab ever shows the connection modal.

## 3. `useConnectionHealth` — the probe

A single timer (`PROBE_INTERVAL_MS`, default **2000ms**) evaluates each transport
every tick and maintains, per transport, an `unhealthySince: number | null` and a
last-known `rtt`.

Health per transport per tick:
- **canvas-sync** — healthy iff `store.status !== 'error'` **and**
  (`store.status !== 'synced-remote'` *or* `store.connectionStatus === 'online'`),
  AND a `GET /api/health` probe returned `ok` within `PROBE_TIMEOUT_MS`. The store
  status flips **instantly** on a clean WS close (fast detection); the ping catches
  a wedged-but-"open" socket and supplies the RTT.
- **terminals** — healthy iff `GET /api/terminal/health` returned `ok` within
  timeout. (Endpoint-based, so it works even with zero terminal shapes open —
  simpler and more complete than aggregating per-shape state.)
- **LiveKit** — `status === 'connected'` is healthy; anything else is degraded.
  **Measured and displayed, but has no threshold and never sets `blocked`.**

Tripping (debounced): the instant a transport goes unhealthy, stamp
`unhealthySince = now`. A transport is **tripped** when
`now - unhealthySince >= threshold`. Recovery clears the stamp immediately. The
debounce applies even to instant signals, so a sub-second flap never flashes the
modal.

`blocked` (connection) ⇔ **any blocking transport is tripped**
(canvas-sync or terminals). The modal names the tripped transport(s).

### Thresholds — EDUCATED GUESSES, TUNE FROM REAL SESSIONS

Exposed as constants with `VITE_*` env overrides. **The defaults below are
deliberate guesses with no field data behind them yet; they exist to be refined
once we watch real sessions.** Lower = faster warning, more false alarms from
transient blips; higher = fewer false alarms, longer staring at a subtly-broken
canvas.

| constant | env override | default | rationale (a guess) |
|---|---|---|---|
| `CANVAS_SYNC_THRESHOLD_MS` | `VITE_CONN_HEALTH_CANVAS_MS` | **3000** | most dangerous (edits silently stop syncing) → warn fastest; ~2 failed 2s ticks distinguishes a real drop from one dropped ping |
| `TERMINAL_THRESHOLD_MS` | `VITE_CONN_HEALTH_TERMINAL_MS` | **8000** | terminal drops are routine + self-healing and already show their own reconnecting state → escalate later |
| `PROBE_INTERVAL_MS` | `VITE_CONN_HEALTH_PROBE_MS` | **2000** | probe cadence |
| `PROBE_TIMEOUT_MS` | `VITE_CONN_HEALTH_TIMEOUT_MS` | **4000** | a probe outstanding past this counts as a miss |

LiveKit has **no** threshold (display-only) by decision.

## 4. The modal + overlay

One component, two reasons; renders only when `blocked`.

**Shared chrome:** a full-canvas overlay that (a) dims the canvas (~`opacity: 0.4`,
non-interactive backdrop) and (b) blocks pointer + keyboard from reaching the
canvas (a capture-phase `keydown`/`pointerdown` swallow on the overlay, so stray
keys can't hit tldraw shortcuts while blocked).

**`reason === 'connection'`:**
- Headline: "Lost connection to the server".
- **Transport list** — one row per transport (Canvas · Terminals · Video) with a
  state chip: ✓ connected / ⏳ degrading (Ns) / ✗ down, **highlighting the tripped
  one(s)**. LiveKit always appears here but only ever shows ✓/⏳.
- **Latency:** the reused `LatencyPill` (your own RTT + `useSessionPulse` history)
  as the historic-latency measure.
- **Countdown:** "Retrying in N…" where N counts down to the next probe tick (each
  tick *is* a retry). Auto-closes the moment all blocking transports recover.

**`reason === 'duplicate-tab'`:**
- Headline: "This canvas is open in another tab".
- Body: brief explanation + a **"Use it here"** button (§5).

## 5. `useCanvasLock` — single active tab (oldest wins)

- On mount, request an **exclusive** `navigator.locks` lock named
  `ew-canvas-${roomId}-${userId}` and hold it for the tab's lifetime. Holding the
  lock ⇒ this tab is the active one. Locks auto-release on tab close/crash, so no
  stale-lock cleanup is needed.
- A second tab's `request` cannot acquire (held) ⇒ it learns it's the duplicate
  (via `ifAvailable`), sets `reason: 'duplicate-tab'`, and shows the takeover modal.
- **Oldest wins:** the newcomer is passive/blocked and does nothing to the holder
  on its own. Coordination rides a `BroadcastChannel('ew-canvas-${roomId}-${userId}')`
  (Web Locks does not notify a holder when it loses a lock, so the channel is the
  signal). Clicking **"Use it here"** posts `{type:'takeover'}`; the current holder
  receives it, **releases its lock** and flips itself to `blocked: 'duplicate-tab'`;
  the freed lock is then acquired by the newcomer, which clears its modal and
  becomes active. Crash-safety is the lock's job: if the holder tab dies without
  releasing, the OS auto-releases and a blocked tab can acquire. This deliberately
  **reverses** today's A/V "newest steals the slot" behaviour, which is the bug.
- Scope is (room, user): real collaborators (different `userId`) never contend;
  only *same person, same canvas, second tab* is blocked.
- **Fixes issue #55's user-facing harm:** one active tab per identity ⇒ no A/V
  `DUPLICATE_IDENTITY` kill, no doubled cursors/presence, none of the associated
  flicker.
- **Fallback:** if `navigator.locks` is unavailable, the hook no-ops (never
  blocks) — single-tab enforcement is best-effort, never a hard dependency.

## 6. Files

**New (`client/src/canvas-health/`, colocated tests):**
- `connectionHealth.ts` — PURE reducer: given per-transport observations +
  `now` + thresholds, compute `{ perTransport: {...}, blocked, reason }`. **Unit
  tested** (threshold/debounce/recovery/precedence).
- `useConnectionHealth.ts` — the probe timer + fetch wiring around the reducer.
- `useCanvasLock.ts` — the `navigator.locks` lifecycle + takeover.
- `useCanvasAvailability.ts` — combines the two.
- `CanvasBlockerModal.tsx` — the modal + overlay (both reasons).
- `constants.ts` — thresholds/env with the "these are guesses" doc comment.

**Modified:**
- `client/src/App.tsx` — mount `useCanvasAvailability`; render `CanvasBlockerModal`
  over the canvas.
- `client/src/canvas-v2/CanvasV2App.tsx` — a `// TODO(canvas-v2 connection-health)`
  marker at the sync-setup site pointing here (§7).

## 7. canvas-v2 parity (the reminder)

canvas-v2 does **not** use tldraw `useSync`; it has its own `SyncClientPeer`
(`@ensembleworks/canvas-sync`) with its own connection state, and the same A/V
hook. When v2 becomes the live engine it must:
- expose `SyncClientPeer`'s connection state (open/closed/reconnecting) in the same
  shape `useConnectionHealth` expects for the canvas-sync transport;
- mount `useCanvasAvailability` + `CanvasBlockerModal` in `CanvasV2App` the way
  `App.tsx` does.

Tracked by (a) this section and (b) the `// TODO(canvas-v2 connection-health)`
marker in `CanvasV2App.tsx`.

## 8. Testing

- **Pure reducer (`connectionHealth.ts`)** — the bulk of the logic, unit-tested
  with injected `now`/observations (repo `bun` + `node:assert` style): a transport
  trips only after `>= threshold` of continuous unhealth; recovery un-trips
  immediately; a sub-threshold flap never trips; LiveKit never sets `blocked`;
  `duplicate-tab` precedence over `connection`; the countdown value derives
  correctly from the tick clock.
- **Lock / probe wiring** — thin; validated by the reducer tests + a manual smoke.
- **Manual smoke (Mac/Chrome):** kill the network mid-session (canvas modal within
  ~3s, correct transport highlighted, auto-recovers); open a 2nd tab (duplicate
  modal, "Use it here" hands over, old tab blocks); video-only drop (row shows
  degraded, canvas stays interactive).

## 9. Non-goals / follow-ups

- Not fixing the underlying transports (that's the network) — only the signalling.
- Not the tldraw focus/tool-state "can't type into a shape" bug (separate,
  needs a repro).
- Server-side `/api/health` / `/api/terminal/health` are assumed sufficient; no new
  endpoints.
