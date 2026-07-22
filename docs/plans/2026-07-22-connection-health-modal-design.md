# Connection-Health Modal + Single-Tab Enforcement — Design

> **Status:** DESIGN (brainstormed 2026-07-22). Implementation plan follows
> separately (superpowers:writing-plans). This doc is the agreed spec.

**Goal:** Give the canvas a single, honest "is this browser actually connected to
the server, and is this the tab that owns the canvas?" state, and when it isn't,
**block interaction behind a modal** that says exactly what's wrong — instead of
today's confusing split where A/V shows "reconnecting" while the canvas looks
interactive but silently can't type/sync.

**Architecture:** Two independent mechanisms, deliberately not combined:
1. **`useConnectionHealth`** — a probe that independently measures each transport
   (canvas-sync, terminals, LiveKit) and trips per-transport staleness thresholds.
   `useCanvasAvailability` turns it into a single `blocked` state with a `reason`.
2. **`useCanvasLock`** — a `navigator.locks` exclusive lock per (room, user) that
   enforces one active tab per canvas (oldest wins). It gates **mounting**, above
   the app, rather than feeding the availability state (§5).

When `blocked`, a shared **`CanvasBlockerModal` + gray-out/input-block overlay**
renders; it auto-dismisses the instant the blocking condition clears. LiveKit is
**shown but never blocking**. The RTT sparkline is the existing `LatencyPill`.

**Tech stack:** React + TypeScript (client workspace). Reuses existing signals —
tldraw sync `store.status`/`connectionStatus`, `LiveKitState.status`, the
`useSessionPulse` latency trail, and the `/api/health` + `/api/terminal/health`
endpoints. New browser API: `navigator.locks`. No server changes.

**Scope:** The connection modal wires into the **live tldraw-v1 engine
(`client/src/App.tsx`)**; the single-tab gate is engine-agnostic and sits above both.
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
"you can't safely interact right now" problem — though it turned out to want a
different remedy: a gate before mount rather than a modal after it (§5).

## 2. The unified availability state

```
interactive  ⇔  (every BLOCKING transport is healthy)
```

The lock is not a term in this expression — it is a precondition of the app
existing at all. A tab that does not hold the lock never mounts (§5), so every
tab that evaluates availability is by construction the holder.

`useCanvasAvailability(): { blocked: boolean; reason: BlockReason | null; health: ConnectionHealth }`

`type BlockReason = 'connection'`

There is no duplicate-tab reason to arbitrate against: a duplicate tab is never
mounted at all (§5), so only a lock-holding tab ever reaches this state.

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

One component, one reason (`'connection'`); renders only when `blocked`.

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

## 5. `useCanvasLock` — single active tab (oldest wins, no takeover)

Single-tab enforcement is a **mount gate**, not a modal. A duplicate tab is not
a degraded participant that gets blocked after the fact — it never becomes a
participant at all.

- On mount, request an **exclusive** `navigator.locks` lock per (room, user) and
  hold it for the tab's lifetime. Holding the lock ⇒ this tab is the active one.
  Locks auto-release on tab close/crash, so no stale-lock cleanup is needed.
- `useCanvasLock(roomId, userId)` returns a tri-state
  `LockPhase = 'pending' | 'held' | 'blocked'`, decided by a pure
  `lockPhase({supported, granted, otherHolderSeen, graceElapsed})`. `granted` is
  checked **first and unconditionally**: there is no teardown path in this
  design, so a tab that has been granted the lock must never be demoted by a
  late-arriving signal.
- `pending → blocked` resolves via two independent signals, **either sufficient**:
  `navigator.locks.query()` reporting an existing holder for our lock name (the
  normal path), or a **3000ms grace timeout** — a pure backstop so a tab can never
  sit on a blank splash forever if `query()` is absent, slow, or rejecting.
- **`SingleTabGate`** (`client/src/canvas-health/SingleTabGate.tsx`) wraps the
  **whole** render in `client/src/main.tsx`, *above* the engine choice, so it
  covers canvas-v2 as well as tldraw-v1. `pending` renders `null`; `blocked`
  renders `DuplicateTabNotice`; `held` renders children. Because the gate sits
  above `<App/>`, a blocked tab mounts nothing that connects: `useSync` is called
  inside the `App` component and LiveKit's `room.connect()` inside
  `useLiveKitRoom`'s effect — `App.tsx` module scope opens no sockets.
- **Oldest wins, and that is final while the holder lives.** There is no takeover
  button, no `BroadcastChannel`, no release-and-hand-over. The blocked tab's
  request stays **queued**, which is also the recovery path: when the holder
  closes or crashes the browser releases the lock, the queued request is granted,
  and the blocked tab mounts and connects on its own with no reload.
- Notice copy (pinned by `gateCopy.test.ts`): heading "This canvas is open in
  another tab"; body "You can only open the canvas in one tab at a time. This tab
  is currently disabled."; recovery "Close the other tab and this one will connect
  automatically."
- Scope is (room, user): real collaborators (different `userId`) never contend;
  only *same person, same canvas, second tab* is gated.
- **Fixes issue #55:** one connected tab per identity ⇒ no A/V
  `DUPLICATE_IDENTITY` kill, no doubled cursors/presence, none of the associated
  flicker. The gate delivers this because the duplicate tab never joins LiveKit
  or sync presence in the first place.
- **Fail-open:** if `navigator.locks` is unavailable the phase is `held` and the
  app mounts exactly as it did before — single-tab enforcement is best-effort,
  never a hard dependency.

## 6. Files

**New (`client/src/canvas-health/`, colocated tests):**
- `connectionHealth.ts` — PURE reducer: given per-transport observations +
  `now` + thresholds, compute `{ perTransport: {...}, blocked, reason }`. **Unit
  tested** (threshold/debounce/recovery/precedence).
- `useConnectionHealth.ts` — the probe timer + fetch wiring around the reducer.
- `useCanvasLock.ts` — the `navigator.locks` lifecycle + the pure `lockPhase`.
- `useCanvasAvailability.ts` — the connection-health facade.
- `CanvasBlockerModal.tsx` — the modal + overlay (connection only).
- `SingleTabGate.tsx` — the mount gate + `DuplicateTabNotice`.
- `constants.ts` — thresholds/env with the "these are guesses" doc comment.

**Modified:**
- `client/src/main.tsx` — wrap the whole render in `SingleTabGate`.
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
  the countdown value derives correctly from the tick clock.
- **Pure `lockPhase`** — unit-tested over the `{supported, granted,
  otherHolderSeen, graceElapsed}` cube, including that `granted` wins over every
  other input.
- **Lock / probe wiring** — thin; validated by the pure tests + a manual smoke.
- **Manual smoke (Mac/Chrome):** kill the network mid-session (canvas modal within
  ~3s, correct transport highlighted, auto-recovers); open a 2nd tab (it shows the
  duplicate-tab notice and connects nothing; closing the first tab lets it take
  over automatically); video-only drop (row shows degraded, canvas stays
  interactive).

## 9. Non-goals / follow-ups

- Not fixing the underlying transports (that's the network) — only the signalling.
- Not the tldraw focus/tool-state "can't type into a shape" bug (separate,
  needs a repro).
- Server-side `/api/health` / `/api/terminal/health` are assumed sufficient; no new
  endpoints.

## 10. As-built deviations (2026-07-22)

Implemented on `feature/connection-health-modal` (`4fbfd26`..`53633f8`). Where the
build diverged from §1–§9 above, this section is authoritative — each item was
found during review, not decided casually.

- **§5 lock name.** The documented `ew-canvas-${room}-${user}` is **buggy** and was
  not shipped. `encodeURIComponent` does not escape `-`, so room `a-b`/user `c` and
  room `a`/user `b-c` both produce `ew-canvas-a-b-c` — a forgeable collision between
  two different (room, user) pairs. The separator is `/`, which *is* escaped inside a
  component. `lockNames.test.ts` pins this.
- **Tech stack "No server changes".** One two-line exception: the telemetry `plane`
  union (`server/src/telemetry-store.ts`, `server/src/features/telemetry.ts`) gained
  a `'lock'` member. Without it the client's lock events passed validation-by-
  rejection and were silently dropped, so the durable trail would have shown nothing
  during exactly the lockout it exists to explain. No new endpoint, no protocol
  change, unknown planes still rejected.
- **§3 LiveKit health.** `status === 'disabled'` counts as healthy, not degraded — a
  room with A/V switched off is not a fault, and would otherwise sit permanently amber.
- **§4 sub-second clock.** The UI clock runs **only while something is wrong**
  (`needsFastClock`, gated on `BLOCKING_TRANSPORTS`; it no longer takes a
  `hasLock` argument, since a mounted tab always holds the lock). Unconditionally
  re-rendering the component that wraps the whole tldraw editor 4×/second for an
  entire session, to animate readouts that only exist while blocked, was not worth it.
- **§4 input swallow.** Swallows everything outside the modal panel except an
  explicit allowlist (Ctrl/Cmd+C, bare Tab). An earlier attempt exempted the whole
  modifier class and thereby let tldraw's `Ctrl+Z`/`Ctrl+Shift+Z`/`Ctrl+A` mutate a
  canvas that could not sync — tldraw binds these on `document.body`, so neither the
  modal's DOM position nor focus prevents it. Browser-chrome shortcuts (reload,
  close, devtools) are unaffected either way: `preventDefault` cannot cancel them.
- **§4 vs. the kick notice.** The blocker is suppressed entirely when `wasKicked` is
  true. Being removed is terminal; a "Retrying in 3…" countdown over it would promise
  a recovery that cannot happen.

### Known limitations carried, not fixed

- **No focus trap** in the modal. A keyboard user can Tab out into dimmed background
  content. Adding one would require re-swallowing Tab, which conflicts with the
  allowlist above; the connection variant has no focusable children anyway.
- **No escape hatch against a live holder.** This is the regression the redesign
  introduces, and it is deliberate. With no takeover, the *only* recovery from a
  blocked tab is "close the other tab" — a user who has lost track of which window
  holds the canvas has to go find it. A holder that crashes or is closed still
  auto-recovers with no action: the browser releases the lock and the blocked tab's
  still-queued request is granted. A **bfcache-frozen holder** still squats the
  lock and the blocked tab waits — but takeover never fixed that case either (its
  `BroadcastChannel` message was simply deferred until the holder resumed), so
  nothing was lost there.
- **One-frame stale `now`** at the healthy→unhealthy transition when the fast clock
  was off. Harmless only because `transportChip`/`countdownSeconds` clamp — those
  clamps are load-bearing, not defensive decoration.

### Smoke results (2026-07-22, Chrome against `bin/dev up`, port offset +100)

§8's scenarios were run live. **It found two defects that the 218 automated suites
could not.** Both are recorded here because they are the argument for never treating
this feature's green test run as sufficient on its own.

Passed:
- **Connection loss** — modal inside the threshold, naming both tripped transports,
  Video still ✓ (LiveKit confirmed non-blocking in practice, not just in the reducer).
- **Recovery** — auto-dismissed with no interaction.
- **Duplicate tab** — the *newcomer* blocks (oldest-wins confirmed live), "Use it
  here" hands over, and the original tab flips to blocked symmetrically. *(This
  scenario was run against the superseded takeover build; the gate that replaced
  it has its own smoke still to run — see the CHANGE NOTE below.)*
- **Lock telemetry** — `granted` → `takeover-received` → `released` observed in the
  console, so §10's telemetry widening works end to end.

**Defect 1 — the input swallow was inert (fixed, `2df74d9`).** The a11y focus-on-mount
puts `document.activeElement` inside the panel, so `insidePanel` was permanently true,
so the blanket exemption swallowed nothing. Verified both directions: with natural
focus, `Ctrl+Z` reached `document.body` (where tldraw binds); after blurring, it was
swallowed. Two individually-correct changes — the accessibility focus move and the
modifier allowlist — composed into a defect that every unit test missed, because the
tests only ever exercised `insidePanel: false`, a state that never occurs in practice.
`insidePanel` is now narrow: it admits only `Enter`/`Space` for the dialog's own button.

**Defect 2 — §5's issue-#55 claim is NOT delivered (open).** §5 asserts that one
active tab per identity means "no A/V `DUPLICATE_IDENTITY` kill, no doubled
cursors/presence". The smoke shows otherwise: the roster showed two entries for the
same user, the panel read "Audio/video: error", and the first tab's console logged
`livekit connected → disconnected` the moment the second tab joined. The lock gates
**canvas interaction only** — a blocked tab still mounts `AvOverlay` and still joins
LiveKit and sync presence. Closing this for real requires the blocked tab to also not
join those, which is a scope increase beyond this branch.

**Defect 2 — RESOLVED (2026-07-22, by the gate).** The scope increase was taken.
`SingleTabGate` sits above `<App/>` in `main.tsx`, so a duplicate tab mounts
neither `AvOverlay` nor `useSync`: it does not join LiveKit and does not join sync
presence, and therefore cannot trigger `DUPLICATE_IDENTITY` or double the roster.
§5's issue-#55 bullet is delivered, not aspirational.

Still uncovered by any automated test: the lock lifecycle, the React shells, and the
modal's rendering.

### CHANGE NOTE (2026-07-22) — takeover replaced by a gate

The duplicate-tab **takeover** described in the original §5 (§10's smoke ran
against it) has been removed and replaced by the hard mount gate now documented
in §5. Commits `4a2c978`, `dcdb905`, `365aa4b`, `801885e`, `4e8b722`, `898faff`,
`27ecbed`.

**Why.** Takeover only works if losing the lock is survivable, and it isn't
cheaply: every transport would have had to grow a teardown-and-rejoin path —
disconnect LiveKit, close the sync socket, drop presence, tear down every terminal
socket — and each teardown races the newcomer's join for the same identity, which
is precisely the `DUPLICATE_IDENTITY` failure the feature exists to remove. Worse,
it puts the released tab into a state no other code path produces: mounted, alive,
and required not to touch anything. A gate has no such path. Lock ownership becomes
**monotonic for the lifetime of a live tab** — `granted` is checked first and never
revoked — and the tab that doesn't own it never connects anything, so there is
nothing to tear down. The cost is the lost escape hatch against a live holder,
recorded under "Known limitations carried, not fixed".

A live smoke of the gate is outstanding; nothing in this note reports one.
