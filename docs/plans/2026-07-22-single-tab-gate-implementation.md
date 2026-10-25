# Single-Tab Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the duplicate-tab *takeover modal* with a hard *gate*: a tab that does not hold
the canvas lock never mounts the app at all, so it never opens a sync socket, a terminal socket, or
a LiveKit connection.

**Architecture:** Today `useCanvasLock` grants a lock, and a loser tab shows an overlay *over an
already-connected app* — it still steals the user's LiveKit identity (issue #55). Takeover exists to
let the loser claim the lock, which forces the *holder* to tear down live transports asynchronously.
Removing takeover makes `hasLock` monotonic for a live tab: acquired at mount or never, released
only by dying. That turns "don't connect unless you hold the lock" from a lifecycle problem into a
mount-time branch. So we lift the decision above `<App/>` in `main.tsx`: a `SingleTabGate` renders
its children only once the lock is held.

**Tech Stack:** React 18, `navigator.locks`, bare-`bun` + `node:assert/strict` colocated tests.

---

## Why this shape (read before starting)

Three consequences justify the churn; keep them true:

1. **No teardown path exists after this change.** Nothing may re-block a tab that has already been
   granted the lock. `lockPhase` enforces this: `granted` wins over every other input.
2. **Both known limitations in `useCanvasLock.ts` are deleted, not carried.** The 3+-tab FIFO
   mis-grant and the bfcache-frozen-holder deferral are *takeover-specific*. Do not re-document them.
3. **The gate covers the v2 engine for free**, because it wraps the whole render in `main.tsx`.

Recovery for a blocked tab is automatic: its lock request stays queued, so when the holder closes,
the browser grants it and the gate flips to the app with no reload and no click.

## The `pending` state is load-bearing

Lock acquisition is async, so *every* tab — including a lone one — starts un-granted. If the gate
treated "not granted" as "blocked" it would flash the refusal screen on every page load and delay
connecting. So the gate is tri-state and renders nothing during `pending`.

Resolving `pending → blocked` uses two independent signals, either sufficient:

- **`navigator.locks.query()`** reports an existing holder for our lock name — the deterministic
  answer, available on the same API surface as `request`.
- **A grace timeout** — the backstop. If `query()` rejects, hangs, or is missing on some engine, a
  tab must never be stuck on a blank splash forever.

## File Structure

| File | Responsibility |
| --- | --- |
| `client/src/canvas-health/useCanvasLock.ts` | **Rewritten.** Queued `navigator.locks` request + `query()` probe + grace timer → `LockPhase`. Pure `lockPhase` and `canvasLockName` live here. No `BroadcastChannel`, no takeover. |
| `client/src/canvas-health/lockPhase.test.ts` | **New.** Pure-reducer tests for `lockPhase`. |
| `client/src/canvas-health/SingleTabGate.tsx` | **New.** Renders children when held, `null` when pending, the notice when blocked. |
| `client/src/canvas-health/connectionHealth.ts` | **Modified.** `BlockReason` loses `'duplicate-tab'`; `availability` and `needsFastClock` lose `hasLock`. |
| `client/src/canvas-health/useCanvasAvailability.ts` | **Modified.** Connection health only; no lock, no `requestTakeover`. |
| `client/src/canvas-health/CanvasBlockerModal.tsx` | **Modified.** Duplicate-tab branch and takeover button deleted. |
| `client/src/main.tsx` | **Modified.** Wraps both engine branches in `<SingleTabGate>`. |
| `client/src/App.tsx` | **Modified.** Drops `onTakeover`/`reason` props. |

---

### Task 1: The `lockPhase` reducer

**Files:**
- Modify: `client/src/canvas-health/useCanvasLock.ts` (add exports; leave the rest for Task 2)
- Test: `client/src/canvas-health/lockPhase.test.ts`

- [ ] **Step 1: Write the failing test**

`client/src/canvas-health/lockPhase.test.ts`:

```ts
/**
 * The gate's tri-state decision. `pending` exists so a lone tab never flashes
 * the refusal screen during the (sub-millisecond, but non-zero) wait for its
 * own lock grant.
 */
import assert from 'node:assert/strict'
import { lockPhase } from './useCanvasLock'

const base = { supported: true, granted: false, otherHolderSeen: false, graceElapsed: false }

// 1. Nothing known yet ⇒ pending. This is the first paint of EVERY tab.
assert.equal(lockPhase(base), 'pending')

// 2. Granted ⇒ held.
assert.equal(lockPhase({ ...base, granted: true }), 'held')

// 3. Someone else holds it ⇒ blocked, without waiting for the grace timer.
assert.equal(lockPhase({ ...base, otherHolderSeen: true }), 'blocked')

// 4. Grace elapsed with no grant ⇒ blocked, even if query() never answered.
//    This is the backstop that stops a tab sitting on a blank splash forever.
assert.equal(lockPhase({ ...base, graceElapsed: true }), 'blocked')

// 5. GRANTED WINS over a query result. query() is async, so its answer can
//    land AFTER our own grant — treating it as authoritative would blank out a
//    tab that legitimately owns the canvas. There is no teardown path after
//    this change, so a granted tab must never be re-blocked.
assert.equal(lockPhase({ ...base, granted: true, otherHolderSeen: true }), 'held')

// 6. GRANTED WINS over the grace timer, for the same reason: a slow grant
//    (holder closed at t=2.9s) must not be overridden by a timer that already
//    fired.
assert.equal(lockPhase({ ...base, granted: true, graceElapsed: true }), 'held')

// 7. FAIL OPEN: no navigator.locks ⇒ held, regardless of everything else.
//    Single-tab enforcement is best-effort and must never be a hard
//    dependency — an engine without the API gets the app, not a refusal.
assert.equal(lockPhase({ ...base, supported: false }), 'held')
assert.equal(lockPhase({ supported: false, granted: false, otherHolderSeen: true, graceElapsed: true }), 'held')

console.log('lockPhase: ok')
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun client/src/canvas-health/lockPhase.test.ts`
Expected: FAIL — `lockPhase` is not exported from `./useCanvasLock`.

- [ ] **Step 3: Add the reducer**

Add to `client/src/canvas-health/useCanvasLock.ts` (keep `canvasLockName` as it is):

```ts
export type LockPhase = 'pending' | 'held' | 'blocked'

/**
 * The gate's decision, pure so it is testable without a browser.
 *
 * `granted` is checked FIRST and unconditionally. After this change there is
 * no teardown path — a tab that has been granted the lock keeps it until it
 * dies — so no later-arriving signal may demote a held tab. Both `query()`
 * (async, can resolve after our own grant) and the grace timer (can fire just
 * before a slow grant) are exactly such signals.
 */
export function lockPhase(input: {
	supported: boolean
	granted: boolean
	otherHolderSeen: boolean
	graceElapsed: boolean
}): LockPhase {
	if (!input.supported) return 'held'
	if (input.granted) return 'held'
	if (input.otherHolderSeen || input.graceElapsed) return 'blocked'
	return 'pending'
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bun client/src/canvas-health/lockPhase.test.ts`
Expected: `lockPhase: ok`

- [ ] **Step 5: Prove the tests have teeth (mutation check)**

For each mutation, apply it, run the test, confirm FAIL, then revert:
1. Move `if (input.granted) return 'held'` *below* the `otherHolderSeen` line → case 5 must fail.
2. Change `otherHolderSeen || graceElapsed` to `otherHolderSeen && graceElapsed` → case 3 or 4 must fail.
3. Change `if (!input.supported) return 'held'` to `return 'blocked'` → case 7 must fail.

Report the verbatim failure output for each. If any mutation survives, add the missing case.

- [ ] **Step 6: Commit**

```bash
git add client/src/canvas-health/useCanvasLock.ts client/src/canvas-health/lockPhase.test.ts
git commit -m "feat(canvas-health): add the tri-state lockPhase reducer"
```

---

### Task 2: Rewrite `useCanvasLock` as a gate, not a takeover

**Files:**
- Modify: `client/src/canvas-health/useCanvasLock.ts`
- Test: `client/src/canvas-health/lockNames.test.ts` (must keep passing unchanged)

- [ ] **Step 1: Replace the file body**

Replace everything in `client/src/canvas-health/useCanvasLock.ts` *except* the `lockPhase` function
and `canvasLockName` (both keep their current bodies) with the following. Note what is **deleted**:
the `BroadcastChannel`, the `onmessage` handler, `requestTakeover`, the re-queue-after-takeover
`acquire()` call, the `CanvasLock` interface, and both "Known limitation" comment blocks.

```ts
/**
 * Single active tab per (room, user) — OLDEST WINS, no takeover.
 *
 * The tab holding an exclusive navigator.locks lock is the active one. A
 * second tab cannot acquire it, learns it is the duplicate, and is never
 * mounted at all (see SingleTabGate) — so it opens no sync socket, no
 * terminal socket, and no LiveKit connection. That last one is the point:
 * LiveKit identities are unique per room, so a second tab that connects
 * DISPLACES the first one's audio. This is issue #55.
 *
 * There is deliberately no way for a duplicate tab to claim the lock. A
 * takeover would mean a live, connected holder losing its lock asynchronously
 * — which would require every transport to grow a teardown-and-rejoin path,
 * racing the newcomer's join. Without it, `granted` is monotonic for a live
 * tab: acquired at mount or never, released only by unmount or death.
 *
 * Recovery is automatic and needs no UI: a blocked tab's request stays QUEUED,
 * so when the holder closes, the browser grants the lock and the gate flips to
 * the app — no reload, no click. Crash-safety is the lock's job (a dead tab's
 * lock is auto-released), so there is no stale-lock cleanup here.
 *
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §5.
 */
import { useEffect, useState } from 'react'
import { logConnectionEvent } from '../av/connectionLog'
import { scheduler } from '../kernel/scheduler'

/**
 * How long a tab waits for a verdict before assuming it is the duplicate.
 *
 * Only a BACKSTOP. The normal path is `query()` below, which answers in about
 * a millisecond. This exists so that an engine where `query()` rejects, hangs,
 * or is absent degrades to "blocked after a beat" rather than "blank splash
 * forever". Generous on purpose: a false `blocked` costs a user their canvas
 * until the real grant lands, so it must not fire ahead of a slow-but-real
 * grant.
 */
const GRACE_MS = 3000

interface LockManagerLike {
	request(
		name: string,
		options: { mode: 'exclusive'; signal?: AbortSignal },
		cb: (lock: unknown) => Promise<void>
	): Promise<void>
	query?(): Promise<{ held?: { name?: string }[] }>
}

function getLockManager(): LockManagerLike | null {
	const locks = (navigator as unknown as { locks?: LockManagerLike }).locks
	return locks ?? null
}

export function useCanvasLock(roomId: string, userId: string): LockPhase {
	// Fail open: no navigator.locks ⇒ enforcement is skipped entirely and the
	// app mounts as it always did. It must never be a hard dependency.
	const supported = getLockManager() != null
	const [granted, setGranted] = useState(false)
	const [otherHolderSeen, setOtherHolderSeen] = useState(false)
	const [graceElapsed, setGraceElapsed] = useState(false)

	useEffect(() => {
		if (!supported) return
		const name = canvasLockName(roomId, userId)
		const locks = getLockManager()
		if (!locks) return

		let disposed = false
		// Aborted on unmount so a request still sitting in the browser's queue
		// (never granted) is cancelled instead of lingering. Per spec, aborting
		// an ALREADY-granted request is a no-op — it only cancels the wait — so
		// this cannot fight `release?.()` over a lock we currently hold.
		const abort = new AbortController()
		// Resolving this is the only way to release the lock: it is the return
		// value of the promise the request() callback holds open. Unmount is now
		// the only caller.
		let release: (() => void) | null = null

		void locks
			.request(name, { mode: 'exclusive', signal: abort.signal }, () => {
				// A request queued before unmount can still be granted after
				// disposal (StrictMode's mount/cleanup/remount races this); bail
				// without ever holding the lock so the remount's request can take
				// it immediately.
				if (disposed) return Promise.resolve()
				setGranted(true)
				logConnectionEvent('lock', 'granted')
				return new Promise<void>((resolve) => {
					release = () => {
						release = null
						logConnectionEvent('lock', 'released')
						resolve()
					}
				})
			})
			.catch(() => {
				// AbortError from the unmount-time abort() is expected. Anything
				// else leaves this tab un-granted, which the grace timer below
				// turns into `blocked` — the safe direction, and the notice
				// explains it. Nothing to log here either way.
			})

		// The fast path to a verdict: does someone ALREADY hold our lock name?
		// Issued after request() so we are queued first — if the holder vanishes
		// between the two, our grant fires and `lockPhase` ignores this answer.
		void locks
			.query?.()
			.then((state) => {
				if (disposed) return
				if ((state.held ?? []).some((entry) => entry.name === name)) setOtherHolderSeen(true)
			})
			.catch(() => {
				// Leave it to the grace timer.
			})

		// The scheduler is the repo's only cadence seam and offers `every`, not
		// `after` — so cancel on the first fire to get a one-shot.
		const cancelGrace = scheduler.every(GRACE_MS, () => {
			cancelGrace()
			if (!disposed) setGraceElapsed(true)
		})

		return () => {
			disposed = true
			cancelGrace()
			abort.abort()
			release?.()
		}
	}, [supported, roomId, userId])

	return lockPhase({ supported, granted, otherHolderSeen, graceElapsed })
}
```

- [ ] **Step 2: Verify nothing else referenced the deleted API**

Run: `grep -rn "requestTakeover\|takeover\|BroadcastChannel" client/src/canvas-health/`
Expected: no matches other than the doc comment's prose explanation of why takeover is absent.
(`client/src/App.tsx` still references `requestTakeover` — that is Task 7's job, and typecheck will
fail until then. That is expected; do not fix it here.)

- [ ] **Step 3: Run the lock tests**

Run: `bun client/src/canvas-health/lockPhase.test.ts && bun client/src/canvas-health/lockNames.test.ts`
Expected: both `ok`. `canvasLockName` and its `/`-separator test are unchanged by this task.

- [ ] **Step 4: Commit**

```bash
git add client/src/canvas-health/useCanvasLock.ts
git commit -m "refactor(canvas-health)!: gate on the lock instead of offering takeover"
```

---

### Task 3: Strip the lock out of the pure reducer

**Files:**
- Modify: `client/src/canvas-health/connectionHealth.ts`
- Test: `client/src/canvas-health/connectionHealth.test.ts`

The lock no longer reaches `availability` at all — a tab without the lock is not rendering this
subtree. So `BlockReason` collapses to one value and `hasLock` disappears from two signatures.

- [ ] **Step 1: Update the tests first**

In `client/src/canvas-health/connectionHealth.test.ts`:
- Delete cases 14, 15 and the `duplicate-tab` case at line ~133 (all three are lock behaviour).
- Remove `hasLock: true` from the remaining `availability({...})` calls.
- Remove the `hasLock` argument from every `needsFastClock(...)` call.
- Update the trailing comment block that mentions "duplicate-tab modal is up regardless of transport
  health" — that scenario no longer exists.
- Add this case, which pins the surviving contract:

```ts
// A tripped blocking transport is now the ONLY way to be blocked.
assert.deepEqual(availability({ health: b1, now: 10_000, thresholds: T }), {
	blocked: true,
	reason: 'connection',
	tripped: ['canvas'],
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun client/src/canvas-health/connectionHealth.test.ts`
Expected: FAIL — TypeScript/runtime mismatch on the now-extra `hasLock` property, or an assertion
failure. Record the verbatim output.

- [ ] **Step 3: Apply the source changes**

In `client/src/canvas-health/connectionHealth.ts`:

```ts
export type BlockReason = 'connection'
```

```ts
/**
 * The single availability state. A duplicate tab never reaches this code:
 * SingleTabGate refuses to mount the app at all without the lock (design §5),
 * so connection health is the only thing that can block here.
 */
export function availability(input: {
	health: HealthState
	now: number
	thresholds: Thresholds
}): Availability {
	const tripped = trippedTransports(input.health, input.now, input.thresholds)
	if (tripped.length > 0) return { blocked: true, reason: 'connection', tripped }
	return { blocked: false, reason: null, tripped: [] }
}
```

And drop the lock clause from `needsFastClock` (keep the rest of its doc comment, including the
`BLOCKING_TRANSPORTS`-not-`TRANSPORTS` rationale):

```ts
export function needsFastClock(health: HealthState): boolean {
	return BLOCKING_TRANSPORTS.some((id) => health[id].unhealthySince != null)
}
```

Also update this file's module header: it says the reducer folds observations "together with the
canvas lock". It no longer does.

- [ ] **Step 4: Run and watch it pass**

Run: `bun client/src/canvas-health/connectionHealth.test.ts`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add client/src/canvas-health/connectionHealth.ts client/src/canvas-health/connectionHealth.test.ts
git commit -m "refactor(canvas-health): availability is connection-only now"
```

---

### Task 4: `useCanvasAvailability` loses the lock

**Files:**
- Modify: `client/src/canvas-health/useCanvasAvailability.ts`

- [ ] **Step 1: Apply the changes**

- Delete the `import { useCanvasLock } from './useCanvasLock'` line and the `useCanvasLock(...)` call.
- Delete `requestTakeover` from `CanvasAvailability` and from the returned object.
- Delete `roomId` and `userId` from the input interface — nothing uses them any more.
- `needsFastClock(health)` and `availability({ health, now, thresholds })` lose their lock argument.
- Update the module header: the invariant is now just

```
 *   interactive ⇔ every BLOCKING transport is healthy
 *
 * Single-tab enforcement is NOT here: it happens above this hook, in
 * SingleTabGate, which does not mount the app at all without the lock.
```

- [ ] **Step 2: Typecheck the client**

Run: `cd client && bun run typecheck`
Expected: errors ONLY in `client/src/App.tsx` (the `roomId`/`userId`/`onTakeover` props it still
passes). Those are Task 7's. If any other file errors, stop and report.

- [ ] **Step 3: Commit**

```bash
git add client/src/canvas-health/useCanvasAvailability.ts
git commit -m "refactor(canvas-health): drop the lock from useCanvasAvailability"
```

---

### Task 5: Delete the modal's duplicate-tab branch

**Files:**
- Modify: `client/src/canvas-health/CanvasBlockerModal.tsx`
- Test: `client/src/canvas-health/modalCopy.test.ts`, `client/src/canvas-health/inputSwallow.test.ts`

The modal now has exactly one job: the connection blocker. The input swallow **stays** — it protects
a mounted-but-unsynced canvas, which is still a real state.

- [ ] **Step 1: Update the copy test**

In `client/src/canvas-health/modalCopy.test.ts`, delete any assertion about the duplicate-tab
heading, body or button. Keep every `blockedSummary` / `transportLabel` case.

- [ ] **Step 2: Apply the source changes**

In `client/src/canvas-health/CanvasBlockerModal.tsx`:
- Delete the `reason` prop from the props interface and its `BlockReason` import.
- Delete `takeoverButtonRef` and the `onTakeover` prop.
- Delete the whole `props.reason === 'duplicate-tab' ? (...) : (...)` ternary, keeping only what was
  the `:` branch — the heading, `blockedSummary`, the transport rows, the latency pill and the
  countdown — as the panel's direct children.
- The focus effect targets `panelRef.current` unconditionally now, and its dependency array becomes
  `[]`:

```tsx
	// Move focus into the dialog on mount so a screen reader announces it via
	// role="dialog" + aria-labelledby, and give it back on unmount — this modal
	// has no close button, so unmount only ever happens because the blocking
	// condition cleared on its own.
	useEffect(() => {
		const previouslyFocused = document.activeElement as HTMLElement | null
		panelRef.current?.focus()
		return () => {
			previouslyFocused?.focus?.()
		}
	}, [])
```

- Update the module header: it currently says "one overlay, two reasons" and describes the
  `duplicate-tab` action. It is now one overlay, one reason.

**Do not touch `shouldSwallowKey`.** Its `Enter`/`Space` allowance under `insidePanel` looks like
dead code now that the button is gone, but the panel itself is still focusable (`tabIndex={-1}`) and
the allowlist's shape is what the regression test in `inputSwallow.test.ts` pins. Removing it is a
separate decision, not a mechanical consequence of this one.

- [ ] **Step 3: Run both tests**

Run: `bun client/src/canvas-health/modalCopy.test.ts && bun client/src/canvas-health/inputSwallow.test.ts`
Expected: both `ok`. `inputSwallow.test.ts` must pass **unchanged** — if it needed editing, something
in the swallow logic moved that should not have.

- [ ] **Step 4: Commit**

```bash
git add client/src/canvas-health/CanvasBlockerModal.tsx client/src/canvas-health/modalCopy.test.ts
git commit -m "refactor(canvas-health): the blocker modal is connection-only"
```

---

### Task 6: The gate component

**Files:**
- Create: `client/src/canvas-health/SingleTabGate.tsx`

- [ ] **Step 1: Write the component**

`client/src/canvas-health/SingleTabGate.tsx`:

```tsx
/**
 * The single-tab gate: children mount only when this tab owns the canvas.
 *
 * This is a GATE, not an overlay. A duplicate tab never renders the app, so it
 * never opens a sync socket, a terminal socket, or a LiveKit connection —
 * which is what stops a second tab from displacing the first one's LiveKit
 * identity (issue #55). An overlay could not achieve that: everything
 * underneath it would already be connected.
 *
 * `pending` renders nothing rather than a spinner. Lock acquisition is
 * sub-millisecond in the ordinary case, so a spinner would be a flash of
 * chrome on every single page load; the blank beat is invisible. It is a
 * distinct state from `blocked` precisely so the refusal screen never flashes
 * on a lone tab.
 *
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §5.
 */
import type { ReactNode } from 'react'
import { wm } from '../theme'
import { useCanvasLock } from './useCanvasLock'

export function DuplicateTabNotice() {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="single-tab-heading"
			style={{
				position: 'fixed',
				inset: 0,
				display: 'grid',
				placeItems: 'center',
				background: wm.bg,
				fontFamily: wm.sans,
				fontSize: 13,
				color: wm.ink,
			}}
		>
			<div
				style={{
					border: `1px solid ${wm.ruleStrong}`,
					borderRadius: 4,
					padding: 24,
					minWidth: 320,
					maxWidth: 420,
					boxShadow: wm.shadowPaper,
				}}
			>
				<strong id="single-tab-heading" style={{ fontSize: 15 }}>
					This canvas is open in another tab
				</strong>
				<div style={{ marginTop: 8 }}>
					You can only open the canvas in one tab at a time. This tab is currently disabled.
				</div>
				{/* No button, by design: there is no takeover. Saying what actually
				    happens matters more than an action here, because the recovery is
				    automatic — the queued lock request is granted the moment the
				    other tab closes, and this tab becomes the canvas in place. */}
				<div style={{ marginTop: 12, color: wm.inkMuted }}>
					Close the other tab and this one will connect automatically.
				</div>
			</div>
		</div>
	)
}

export function SingleTabGate(props: { roomId: string; userId: string; children: ReactNode }) {
	const phase = useCanvasLock(props.roomId, props.userId)
	if (phase === 'pending') return null
	if (phase === 'blocked') return <DuplicateTabNotice />
	return <>{props.children}</>
}
```

- [ ] **Step 2: Typecheck**

Run: `cd client && bun run typecheck`
Expected: the same `App.tsx`-only errors as Task 4, and nothing new from this file.

- [ ] **Step 3: Commit**

```bash
git add client/src/canvas-health/SingleTabGate.tsx
git commit -m "feat(canvas-health): add SingleTabGate"
```

---

### Task 7: Wire the gate above both engines

**Files:**
- Modify: `client/src/main.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Wrap the render in `main.tsx`**

Add the imports and wrap **both** branches — the gate goes outside the engine choice so the v2 engine
gets the same protection:

```tsx
import { getIdentity, getRoomId } from './identity'
import { SingleTabGate } from './canvas-health/SingleTabGate'
```

```tsx
const engine = selectEngineFromEnvironment(getRoomId())
const identity = getIdentity()

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<SingleTabGate roomId={getRoomId()} userId={identity.id}>
			{engine === 'v2' ? (
				<Suspense fallback={null}>
					<CanvasV2App />
				</Suspense>
			) : (
				<App />
			)}
		</SingleTabGate>
	</React.StrictMode>
)
```

**Two constraints on this file, both load-bearing:**

1. **ZERO EXPOSURE holds.** `CanvasV2App` stays behind `React.lazy` and the single `engine === 'v2'`
   branch. The gate is a parent, not a new branch — a `team`-room render is still `<App/>` and still
   never issues the v2 `import()`. Add a sentence to the existing module header noting the gate wraps
   both branches and does not affect this.
2. **Keep the `CanvasV2App`/`selectEngine` identifiers literally present** — `scripts/exposure-audit.ts`
   greps this file for the pairing. Run it in Step 3 to confirm.

`getIdentity()` is safe to call here: `App.tsx` already calls it at module scope, which runs at
import time — i.e. before this render — so the name prompt (if any) has already happened and this
call just reads localStorage.

- [ ] **Step 2: Drop the dead props in `App.tsx`**

In the `useCanvasAvailability({...})` call, delete the `roomId` and `userId` properties. In the
`<CanvasBlockerModal .../>` element, delete the `reason={...}` and `onTakeover={...}` props.

Update the comment above the availability call — it says "is this the tab that owns the canvas?",
which is no longer this hook's question. Replace that clause with a pointer to `SingleTabGate`.

The `wasKicked` precedence comment mentions the `"Use it here"` button; update it to refer only to the
countdown, and keep the suppression itself — it is still correct for the connection modal.

- [ ] **Step 3: Full verification**

Run each and report verbatim:

```bash
bun run typecheck
bun scripts/exposure-audit.test.ts
bun test client/
bun run build
```

Expected: typecheck exit 0; the exposure audit passes; client tests pass; build succeeds.

Note: `scripts/ux-contract-presence.test.ts` fails locally by design without `UX_CONTRACT_PR_BODY`
set — that is expected and not a regression.

- [ ] **Step 4: Commit**

```bash
git add client/src/main.tsx client/src/App.tsx
git commit -m "feat(canvas-health): gate the whole app on the single-tab lock"
```

---

### Task 8: Docs, then a live smoke

**Files:**
- Modify: `docs/plans/2026-07-22-connection-health-modal-design.md`

- [ ] **Step 1: Update the design doc**

- **§2:** remove the `duplicate-tab`-beats-`connection` precedence rule; `BlockReason` is now
  `'connection'` only.
- **§4:** remove the `reason === 'duplicate-tab'` modal description.
- **§5:** rewrite. It currently describes `ifAvailable` probing and BroadcastChannel takeover. The
  new content: oldest-wins with **no takeover**; a duplicate tab is never mounted; tri-state
  `pending | held | blocked` with `query()` plus a grace backstop; automatic recovery via the queued
  request; fail-open when the API is missing.
- **§10 "As-built deviations":** delete the entries that no longer exist (the `ifAvailable`
  deviation, the re-queue, the takeover-specific notes). Under "Known limitations carried, not
  fixed", **remove** the 3+-tab FIFO mis-grant and the bfcache-frozen-holder entries — both were
  takeover-specific — and **add** the one real regression: there is no escape hatch against a live
  holder, so the recovery path is "close the other tab".
- Update the issue-#55 status: the A/V displacement is now genuinely fixed, because a duplicate tab
  never connects to LiveKit at all. Say so plainly and remove the note added in `c1ad8e1` that
  marked it aspirational.

- [ ] **Step 2: Commit the docs**

```bash
git add docs/plans/2026-07-22-connection-health-modal-design.md
git commit -m "docs(plans): design §5 is a gate, not a takeover"
```

- [ ] **Step 3: Live smoke — MANDATORY, not optional**

The previous round of this feature shipped 218 passing suites containing a defect that made the
input swallow completely inert; only a live run found it. Mount-gating is the same class of change.
Run all six against a live stack (`bin/dev up`, then the edge URL it narrates):

1. **Lone tab connects.** Open one tab. The app mounts, the canvas syncs, LiveKit connects. Watch
   closely for a flash of the refusal screen during load — there must be none.
2. **Second tab is refused.** Open a second tab on the same room. It shows the notice, and
   DevTools → Network shows **no** `/sync/` WebSocket, no terminal WebSocket, and no LiveKit
   connection from that tab.
3. **First tab is undisturbed** — this is the issue-#55 check, and the one that failed before.
   With tab 2 open and refused, confirm tab 1's LiveKit connection is still live and its mic still
   works. It must not have been displaced.
4. **Automatic recovery.** Close tab 1. Tab 2 must mount the app **by itself**, with no reload and
   no click.
5. **Fail-open.** In DevTools, run `delete navigator.locks` before load (or stub it undefined) and
   confirm the app still mounts.
6. **Connection modal still works.** With one tab, stop the sync server (`bin/dev restart` mid-flight
   or kill the service) and confirm the connection blocker still appears over the mounted app with
   its countdown, and clears on reconnect.

Record the actual observed result for each — not the expected one. If any fails, stop and report
rather than working around it.

- [ ] **Step 4: Record the smoke results**

Append the verbatim results to the design doc's smoke section and commit.

---

## Spec coverage

| Decision from the discussion | Task |
| --- | --- |
| Remove the takeover option entirely | 2, 5 |
| A refused tab connects to no backend | 6, 7 |
| Tri-state so a lone tab never flashes the refusal | 1, 6 |
| Fail open without `navigator.locks` | 1, 2 |
| Delete both takeover-specific known limitations | 2, 8 |
| Recovery = close the other tab, auto-promote | 2, 6 |
| Issue #55 genuinely closed | 8 (verified by smoke 3) |

## Known deviations from the discussion

- The grace timer is a second mechanism alongside `query()`, where the discussion implied one. It is
  a pure backstop against a permanently blank splash; both feed the same pure reducer.
- `shouldSwallowKey` keeps its `Enter`/`Space` allowance even though the takeover button is gone
  (see Task 5's note).
