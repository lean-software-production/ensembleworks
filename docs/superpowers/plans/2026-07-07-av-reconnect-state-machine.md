# A/V reconnect state machine (spec §1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LiveKit A/V self-heal — on a terminal disconnect, re-join from scratch with a fresh token and jittered backoff (forever), surface `reconnecting`/`retrying` as visible state instead of a dead `error`, and restore mic/cam after re-join — so a reload is never the recovery procedure.

**Architecture:** Refactor the single connect-effect in `useLiveKitRoom.ts` so its `connect()` is re-runnable across a sequence of `Room` instances. A pure `classifyDisconnect(reason)` decides retry-vs-fatal; the retry loop reuses `computeBackoff` from `@ensembleworks/contracts/relay-parity` (same semantics as the terminal connector). Desired mic/cam live in refs so a re-joined `Room` republishes them. The UI keeps peers frozen+dimmed during reconnect rather than clearing them.

**Tech Stack:** React (hooks/effects), `livekit-client` (`Room`, `RoomEvent`, `DisconnectReason`), `@ensembleworks/contracts` (`computeBackoff`), Vitest for the pure unit.

**Source spec:** `docs/superpowers/specs/2026-07-07-av-resilience-connection-observability-design.md` §1.

**Scope note:** This plan is §1 only. §2 (telemetry beacon) and §3 (sync-plane hardening) are separate plans; the spec requires that neither gate this work. Where §1 produces re-join attempt/outcome events, they are logged via `console.debug` now and become telemetry inputs in §2.

---

### Task 1: Extend the status union and expose desired mic/cam via refs

**Files:**
- Modify: `client/src/av/useLiveKitRoom.ts`

- [ ] **Step 1: Widen the status type**

In the `LiveKitState` interface (`useLiveKitRoom.ts:45`):

```ts
status: 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'retrying' | 'error'
```

- [ ] **Step 2: Add refs mirroring desired mic/cam state**

Near the existing refs (`useLiveKitRoom.ts:73-74`), add:

```ts
// Desired publish state, mirrored from the setters so a re-joined Room (which
// starts with nothing published) can restore what the user had live.
const micEnabledRef = useRef(false)
const camEnabledRef = useRef(false)
```

- [ ] **Step 3: Keep the refs in sync in the setters**

In `setMicEnabled` / `setCamEnabled` (`useLiveKitRoom.ts:209-217`), record the desired value:

```ts
const setMicEnabled = (on: boolean) => {
	micEnabledRef.current = on
	room?.localParticipant.setMicrophoneEnabled(on).catch(console.error)
	audioCtxRef.current?.resume()
	setMicState(on)
}
const setCamEnabled = (on: boolean) => {
	camEnabledRef.current = on
	room?.localParticipant.setCameraEnabled(on).catch(console.error)
	setCamState(on)
}
```

- [ ] **Step 4: Typecheck**

Run: `cd client && bun run typecheck`
Expected: PASS (the widened union has no consumers that exhaustively switch — verified in Task 5; `SessionPanel` reads it as a string).

- [ ] **Step 5: Commit**

```bash
git add client/src/av/useLiveKitRoom.ts
git commit -m "feat(av): widen LiveKit status union + desired mic/cam refs"
```

---

### Task 2: Pure `classifyDisconnect` helper (TDD)

The only cleanly unit-testable slice: reason → retry-vs-fatal. The SDK event wiring and React effect are verified live in Task 6 (per the spec's Verification section).

**Files:**
- Create: `client/src/av/reconnect.ts`
- Test: `client/src/av/reconnect.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { DisconnectReason } from 'livekit-client'
import { classifyDisconnect } from './reconnect'

describe('classifyDisconnect', () => {
	it('is fatal for identity/permission ends the user cannot retry past', () => {
		expect(classifyDisconnect(DisconnectReason.DUPLICATE_IDENTITY)).toBe('fatal')
		expect(classifyDisconnect(DisconnectReason.PARTICIPANT_REMOVED)).toBe('fatal')
		expect(classifyDisconnect(DisconnectReason.ROOM_DELETED)).toBe('fatal')
	})

	it('retries every transient/network end', () => {
		expect(classifyDisconnect(DisconnectReason.SERVER_SHUTDOWN)).toBe('retry')
		expect(classifyDisconnect(DisconnectReason.SIGNAL_CLOSE)).toBe('retry')
		// undefined = LiveKit gave no reason (e.g. raw socket drop) → retry
		expect(classifyDisconnect(undefined)).toBe('retry')
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && bunx vitest run src/av/reconnect.test.ts`
Expected: FAIL — `classifyDisconnect` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
import { DisconnectReason } from 'livekit-client'

/**
 * Whether a LiveKit `Disconnected` end should trigger a from-scratch re-join.
 * Fatal ends are the ones where re-joining would fight the server: a duplicate
 * identity (another tab took the slot), an explicit kick (`/api/av/kick` →
 * PARTICIPANT_REMOVED), or the room being deleted. Everything else — network
 * loss, signal timeout, server restart, token rejection, or no reason at all —
 * is transient and retried.
 */
export function classifyDisconnect(reason: DisconnectReason | undefined): 'retry' | 'fatal' {
	switch (reason) {
		case DisconnectReason.DUPLICATE_IDENTITY:
		case DisconnectReason.PARTICIPANT_REMOVED:
		case DisconnectReason.ROOM_DELETED:
			return 'fatal'
		default:
			return 'retry'
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && bunx vitest run src/av/reconnect.test.ts`
Expected: PASS (6 assertions). If a `DisconnectReason` member name differs in this livekit-client version, fix the import/member names — do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add client/src/av/reconnect.ts client/src/av/reconnect.test.ts
git commit -m "feat(av): classifyDisconnect — retry-vs-fatal for LiveKit ends"
```

---

### Task 3: Re-runnable session with reconnect/reconnected wiring

Refactor the effect so a single `startSession()` builds one `Room`, wires all handlers, connects, and republishes — callable repeatedly. This task adds the SDK's own reconnect visibility (`reconnecting` → `connected`) without the from-scratch loop yet (Task 4).

**Files:**
- Modify: `client/src/av/useLiveKitRoom.ts`

- [ ] **Step 1: Extract room teardown**

Inside the effect, alongside `detachAudio`, add a helper that fully retires a `Room` (used before each re-join and on unmount):

```ts
const teardownRoom = (r: Room | null) => {
	if (!r) return
	r.removeAllListeners()
	for (const id of [...pipelinesRef.current.keys()]) detachAudio(id)
	r.disconnect()
}
```

- [ ] **Step 2: Add the reconnecting/reconnected handlers inside `connect()`**

In the handler block (`useLiveKitRoom.ts:147-174`), before the `Disconnected` line, add:

```ts
r.on(RoomEvent.Reconnecting, () => { if (!cancelled) setStatus('reconnecting') })
r.on(RoomEvent.SignalReconnecting, () => { if (!cancelled) setStatus('reconnecting') })
r.on(RoomEvent.Reconnected, () => {
	if (cancelled) return
	setStatus('connected')
	rebuildPeers(r) // subscriptions may have churned while away
})
```

- [ ] **Step 3: Republish mic/cam after a successful connect**

After `setStatus('connected')` in `connect()` (`useLiveKitRoom.ts:187-189`), restore desired publish state:

```ts
setStatus('connected')
rebuildPeers(r)
setScreenShareRoom(r)
// Restore what the user had live — a re-joined Room starts empty.
if (micEnabledRef.current) r.localParticipant.setMicrophoneEnabled(true).catch(console.error)
if (camEnabledRef.current) r.localParticipant.setCameraEnabled(true).catch(console.error)
```

- [ ] **Step 4: Route unmount cleanup through `teardownRoom`**

Replace the manual disconnect in the effect cleanup (`useLiveKitRoom.ts:198-206`) so it uses `teardownRoom(lkRoom)` (keeping the `setScreenShareRoom(null)` and `audioCtxRef` close). Verify the `pointerdown` listener removal stays.

- [ ] **Step 5: Typecheck + manual smoke**

Run: `cd client && bun run typecheck` → PASS.
Then with the stack up, load the canvas, join A/V, confirm normal connect still works (self-bubble on cam, audio on mic) — no behavior change yet for the happy path.

- [ ] **Step 6: Commit**

```bash
git add client/src/av/useLiveKitRoom.ts
git commit -m "feat(av): surface SDK reconnecting/reconnected + republish on connect"
```

---

### Task 4: From-scratch re-join loop on terminal Disconnected

**Files:**
- Modify: `client/src/av/useLiveKitRoom.ts`

- [ ] **Step 1: Add an attempt counter + re-join scheduler in the effect**

At the top of the effect body (near `let cancelled = false`), add:

```ts
let attempt = 0
let rejoinTimer: ReturnType<typeof setTimeout> | null = null
```

Import the backoff helper at the top of the file:

```ts
import { computeBackoff } from '@ensembleworks/contracts/relay-parity'
```

- [ ] **Step 2: Replace the terminal Disconnected handler**

Swap the old `r.on(RoomEvent.Disconnected, () => setStatus('error'))` (`useLiveKitRoom.ts:174`) for classification + scheduling:

```ts
r.on(RoomEvent.Disconnected, (reason) => {
	if (cancelled) return
	if (classifyDisconnect(reason) === 'fatal') {
		setStatus('error')
		return
	}
	setStatus('retrying')
	teardownRoom(r)
	attempt += 1
	const delay = computeBackoff(attempt)
	console.debug(`[av] disconnected (${reason}); re-join #${attempt} in ${delay}ms`)
	rejoinTimer = setTimeout(() => { if (!cancelled) connect() }, delay)
})
```

Add `import { classifyDisconnect } from './reconnect'`.

- [ ] **Step 3: Reset the attempt counter on a healthy connect**

In `connect()`, right after `setStatus('connected')`, add `attempt = 0` so a stable re-join restarts the backoff ladder (a later flap begins at ~1s again).

- [ ] **Step 4: Clear the pending timer on unmount**

In the effect cleanup, before `teardownRoom(lkRoom)`, add:

```ts
if (rejoinTimer) clearTimeout(rejoinTimer)
```

- [ ] **Step 5: Guard `connect()`'s own catch against the loop**

The initial-connect `catch` (`useLiveKitRoom.ts:177-181`) currently sets `error` on any connect failure. Change it to schedule a re-join too (a token fetch / connect failure mid-session must not become a dead end):

```ts
} catch (err) {
	if (cancelled) return
	console.error('LiveKit connect failed', err)
	teardownRoom(r)
	setStatus('retrying')
	attempt += 1
	const delay = computeBackoff(attempt)
	rejoinTimer = setTimeout(() => { if (!cancelled) connect() }, delay)
	return
}
```

(Keep `setStatus('disabled')` early-return for `!info.enabled` — a disabled room is not an error and must not retry.)

- [ ] **Step 6: Typecheck**

Run: `cd client && bun run typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/av/useLiveKitRoom.ts
git commit -m "feat(av): re-join from scratch with jittered backoff on disconnect"
```

---

### Task 5: UI — dim the rail + reconnecting indicator; reserve `error` for dead ends

**Files:**
- Modify: `client/src/av/SessionPanel.tsx`
- Modify: `client/src/av/AvOverlay.tsx` (rail dimming)

- [ ] **Step 1: Treat reconnecting/retrying as "available but degraded" in SessionPanel**

`SessionPanel.tsx:40` currently: `avAvailable = status !== 'disabled' && status !== 'error'`. That already keeps controls live for the new states (good). Confirm the status line (`SessionPanel.tsx:161-163`) renders a friendly label:

```tsx
{props.status !== 'connected' && (
	<div className="av-status-note">
		Audio/video: {props.status === 'disabled'
			? 'unavailable'
			: props.status === 'reconnecting' || props.status === 'retrying'
				? 'reconnecting…'
				: props.status}
	</div>
)}
```

- [ ] **Step 2: Dim the faces rail during reconnect (do NOT clear peers)**

In `AvOverlay.tsx` where the rail renders (`AvOverlay.tsx:170-172`), pass a dimmed flag derived from status:

```tsx
const degraded = lk.status === 'reconnecting' || lk.status === 'retrying'
```

and apply it to the rail container (e.g. `style={{ opacity: degraded ? 0.45 : 1, transition: 'opacity .3s' }}` or a `data-degraded` class). Frozen dimmed faces communicate "link degraded", not "everyone left" — peers are intentionally kept.

- [ ] **Step 3: Typecheck + manual visual check**

Run: `cd client && bun run typecheck` → PASS. Load the canvas; confirm normal (connected) state shows the rail at full opacity and no status note.

- [ ] **Step 4: Commit**

```bash
git add client/src/av/SessionPanel.tsx client/src/av/AvOverlay.tsx
git commit -m "feat(av): show reconnecting state — dim rail, keep peers, friendly label"
```

---

### Task 6: Live verification (per spec §Verification)

Not code — the integration test for the SDK-wired parts. Record results in the commit/PR notes.

- [ ] **Step 1: Server-restart re-join.** Stack up, two browsers joined with mic/cam on. `bin/dev restart livekit`. Expect: both clients show `reconnecting` then `retrying`, then self-heal to `connected` with mic/cam **restored** (audio/video live again without reload). Faces dim during the gap, never vanish.

- [ ] **Step 2: Throttle path.** Chrome devtools → Network → Offline for ~3s then back to online. Expect `reconnecting` (SDK recovery, media preserved) → `connected`; only a longer/hard drop escalates to `retrying`.

- [ ] **Step 3: Kick path.** With a second identity joined, `POST /api/av/kick` for it. Expect that client lands in `error` (fatal), **not** a re-join fight — it must stop retrying.

- [ ] **Step 4: Overnight/backoff sanity.** Leave a tab with livekit down; confirm `console.debug` shows re-join attempts with delays climbing ~1s→30s and capping, and that bringing livekit back re-joins on the next attempt.

---

## Self-review notes

- **Spec coverage:** status union (§1) ✓ T1; Reconnecting/SignalReconnecting/Reconnected ✓ T3; Disconnected classify + non-retryable set ✓ T2/T4; re-join with fresh token (connect() re-fetches `/api/av/token`) ✓ T4; backoff 1s→30s forever ✓ T4 (reused `computeBackoff`); republish mic/cam ✓ T3; UI dim/keep-peers/error-for-dead-ends ✓ T5; verification matrix ✓ T6.
- **Fresh token:** `connect()` already fetches `/api/av/token` each call, so every re-join gets a new token — the 12h-TTL staleness the spec calls out is a non-issue by construction.
- **Cancellation:** every async continuation and the timer are guarded by `cancelled` / `clearTimeout`, matching the existing initial-connect guard.
- **Out of scope (later plans):** telemetry beacon (§2) consumes the `console.debug` re-join events; sync-plane hardening (§3). Neither gates this.
