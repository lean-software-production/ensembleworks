# File Viewer Force-Follow (Baton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the file viewer's opt-in present/follow model with a single-baton model: one controller, everyone else force-mirrored, frozen last view when nobody controls.

**Architecture:** The baton IS the existing `presentStore` presence token (LWW by ts) — no server-side authority. Client work removes the opt-out paths and adds grab-on-edit-start, incumbent-yields-on-steal, and a frozen mirror state. Server work changes the relay log from wipe-on-stop + 10-min TTL to retain-until-replaced with LRU eviction under memory pressure.

**Tech Stack:** React + tldraw (v1 legacy engine), rrweb Replayer, Express, Bun assert-script tests (`bun path/to/x.test.ts`).

**Spec:** `docs/superpowers/specs/2026-07-29-file-viewer-force-follow-design.md`

## Global Constraints

- v1 tldraw engine only (`client/src/file-viewer/`); do NOT touch `client/src/canvas-v2/` — v2 parity is out of scope.
- Baton stays presence meta (`fileViewerPresent` token, LWW by largest `ts`); no new server endpoints, no server-side baton authority.
- Camera never moves: mirroring is shape-scoped only.
- No opt-out of following may remain anywhere.
- Frozen state degrade chain: relay backlog → rrweb frozen mirror; no backlog → plain non-interactive iframe at initial position.
- Existing per-log caps stay: maxEvents 5000, maxBytes 5MB, maxTotalBytes 50MB.
- Tests are assert scripts run directly: `bun <path>` (see existing `// Run:` headers).
- PR body (#71) must record: `ux-contract: none — legacy v1 tldraw file-viewer UI; not a canvas-editor/canvas-react/canvas-v2 contract surface`.
- Commit after every task; work on branch `feat/file-viewer-rrweb-present`.

---

### Task 1: Relay retention — retain-until-replaced + LRU eviction

**Files:**
- Modify: `server/src/present-relay.ts`
- Modify: `server/src/features/file-viewer.ts:220-230` (present-stop route)
- Test: `server/src/present-relay.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `PresentRelay` interface WITHOUT `stop()`. `createPresentRelay(caps?)` loses `idleTtlMs`; signature becomes `createPresentRelay(caps?: { maxEvents?: number; maxBytes?: number; maxTotalBytes?: number; now?: () => number })`. `append`/`backlog` signatures unchanged. Task 3's frozen mirror relies on `backlog()` returning the last presentation after the presenter is gone.

Behaviour changes:
1. `stop()` removed from the interface and implementation — a finished presentation's log is the frozen last view; it must survive.
2. The idle-TTL sweep is removed entirely (retention is replace-or-restart).
3. Under `maxTotalBytes` pressure, `append` first evicts OTHER logs, least-recently-appended first, until the new batch fits; only if the ACTIVE log alone still exceeds a cap does it truncate. Frozen logs must never starve a live presentation.

- [ ] **Step 1: Update tests to the new contract**

In `server/src/present-relay.test.ts`: delete the existing `stop`-related assertions and the idle-TTL sweep assertions (the ones advancing a fake `now` past `idleTtlMs`). Add:

```ts
// Retention: a log survives with no stop() call and no TTL — backlog after
// arbitrary idle time still returns the last presentation.
{
	let t = 1000
	const relay = createPresentRelay({ now: () => t })
	relay.append('r', 's', 'p1', [{ seq: 0, event: { a: 1 } }])
	t += 24 * 60 * 60 * 1000 // a day later
	const b = relay.backlog('r', 's')
	assert.equal(b.presentId, 'p1', 'log retained indefinitely (replace-or-restart)')
	assert.equal(b.entries.length, 1)
}

// Replacement: a new presentId on the same shape supersedes the old log.
{
	const relay = createPresentRelay()
	relay.append('r', 's', 'p1', [{ seq: 0, event: { a: 1 } }])
	relay.append('r', 's', 'p2', [{ seq: 0, event: { b: 2 } }])
	const b = relay.backlog('r', 's')
	assert.equal(b.presentId, 'p2', 'new presentation replaced the old log')
	assert.equal(b.entries.length, 1)
}

// LRU eviction: total-bytes pressure evicts the least-recently-appended
// OTHER log instead of truncating the live one.
{
	let t = 1000
	// Each entry stringifies to ~60 bytes; cap total at ~2 batches.
	const big = () => [{ seq: 0, event: { pad: 'x'.repeat(400) } }]
	const relay = createPresentRelay({ maxTotalBytes: 1000, now: () => t })
	relay.append('r', 'shapeA', 'pA', big())
	t += 1
	relay.append('r', 'shapeB', 'pB', big())
	t += 1
	// Third log pushes past maxTotalBytes → shapeA (oldest) evicted, shapeC accepted.
	const res = relay.append('r', 'shapeC', 'pC', big())
	assert.equal(res.truncated, false, 'live append accepted under pressure')
	assert.equal(relay.backlog('r', 'shapeA').presentId, null, 'oldest log evicted')
	assert.equal(relay.backlog('r', 'shapeB').presentId, 'pB', 'newer log kept')
	assert.equal(relay.backlog('r', 'shapeC').presentId, 'pC', 'new log stored')
}

// Per-log caps still truncate the active log itself.
{
	const relay = createPresentRelay({ maxBytes: 100 })
	const res = relay.append('r', 's', 'p1', [{ seq: 0, event: { pad: 'x'.repeat(400) } }])
	assert.equal(res.truncated, true, 'own-log cap still truncates')
}
```

Keep every existing assertion that still matches the new contract (append/backlog round-trip, presentId supersede, per-log maxEvents/maxBytes truncation, truncated-log rejects further appends).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && bun src/present-relay.test.ts`
Expected: FAIL — TS error on removed `idleTtlMs` option or assertion failure on retention/eviction (old code sweeps/deletes).

- [ ] **Step 3: Implement the new relay**

Rewrite `server/src/present-relay.ts` internals:

```ts
export interface PresentRelay {
	append(
		roomId: string,
		shapeId: string,
		presentId: string,
		entries: RelayEntry[]
	): { accepted: boolean; truncated: boolean }
	backlog(roomId: string, shapeId: string): { presentId: string | null; truncated: boolean; entries: RelayEntry[] }
}

export function createPresentRelay(caps?: {
	maxEvents?: number
	maxBytes?: number
	maxTotalBytes?: number
	now?: () => number
}): PresentRelay {
	const maxEvents = caps?.maxEvents ?? 5000
	const maxBytes = caps?.maxBytes ?? 5 * 1024 * 1024
	const maxTotalBytes = caps?.maxTotalBytes ?? 50 * 1024 * 1024
	const now = caps?.now ?? Date.now
	const logs = new Map<string, Log>()
	const key = (roomId: string, shapeId: string) => `${roomId} ${shapeId}`
	let totalBytes = 0

	// Frozen logs (finished presentations kept as the last view) may not starve
	// a live one: under total-bytes pressure, evict least-recently-appended
	// OTHER logs until the incoming batch fits.
	function evictForRoom(selfKey: string, needed: number) {
		while (totalBytes + needed > maxTotalBytes) {
			let oldestKey: string | null = null
			let oldestAt = Infinity
			for (const [k, log] of logs) {
				if (k === selfKey) continue
				if (log.lastAppendAt < oldestAt) {
					oldestAt = log.lastAppendAt
					oldestKey = k
				}
			}
			if (!oldestKey) return
			totalBytes -= logs.get(oldestKey)!.bytes
			logs.delete(oldestKey)
		}
	}

	return {
		append(roomId, shapeId, presentId, entries) {
			const k = key(roomId, shapeId)
			let log = logs.get(k)
			if (!log || log.presentId !== presentId) {
				if (log) totalBytes -= log.bytes
				log = { presentId, truncated: false, entries: [], bytes: 0, lastAppendAt: now() }
				logs.set(k, log)
			}
			log.lastAppendAt = now()
			if (log.truncated) return { accepted: false, truncated: true }
			const addedBytes = JSON.stringify(entries).length
			evictForRoom(k, addedBytes)
			if (
				log.entries.length + entries.length > maxEvents ||
				log.bytes + addedBytes > maxBytes ||
				totalBytes + addedBytes > maxTotalBytes
			) {
				log.truncated = true
				return { accepted: false, truncated: true }
			}
			log.entries.push(...entries)
			log.bytes += addedBytes
			totalBytes += addedBytes
			return { accepted: true, truncated: false }
		},
		backlog(roomId, shapeId) {
			const log = logs.get(key(roomId, shapeId))
			if (!log) return { presentId: null, truncated: false, entries: [] }
			return { presentId: log.presentId, truncated: log.truncated, entries: log.entries }
		},
	}
}
```

Update the module header comment: the log is now the durable "last presented view" per shape — retained until a new presentation replaces it or the server restarts; LRU-evicted only under total-memory pressure.

In `server/src/features/file-viewer.ts`, the present-stop route no longer deletes anything (old clients still POST it):

```ts
// present-stop no longer deletes the log — a finished presentation IS the
// frozen last view (spec: 2026-07-29-file-viewer-force-follow-design.md).
// Kept as a 200 no-op so older clients' broadcasters don't error on stop.
router.post('/api/canvas/file-viewer/present-stop', (req, res) => {
	res.json({ ok: true })
})
```

Remove the now-unused `relay.stop` reference and the body validation of that route (no longer needed for a no-op).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && bun src/present-relay.test.ts`
Expected: PASS (`ok: present-relay` style output, no assertion errors).

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`
Expected: clean.

```bash
git add server/src/present-relay.ts server/src/present-relay.test.ts server/src/features/file-viewer.ts
git commit -m "feat(file-viewer): relay retains last presentation until replaced (frozen last view)"
```

---

### Task 2: followLogic carries ts (steal detection for the incumbent)

**Files:**
- Modify: `client/src/file-viewer/followLogic.ts`
- Test: `client/src/file-viewer/followLogic.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `PresenterInfo` gains `ts: number` (the winning token's timestamp; missing/non-numeric presence ts stays 0). Task 3 compares `peer.ts` against the local token's `ts` to make the incumbent yield.

- [ ] **Step 1: Write the failing test**

Append to `client/src/file-viewer/followLogic.test.ts`:

```ts
// ts exposure: the winner's token timestamp is surfaced so an incumbent
// presenter can detect a steal (peer ts newer than their own token's).
{
	const winner = presenterFor(
		[
			peer('a', { fileViewerPresent: { shapeId: 's1', fraction: 0.1, ts: 100 } }),
			peer('b', { fileViewerPresent: { shapeId: 's1', fraction: 0.9, ts: 200 } }),
		],
		's1'
	)
	assert.equal(winner?.userId, 'b')
	assert.equal(winner?.ts, 200, 'PresenterInfo carries the winning ts')
}
{
	const winner = presenterFor(
		[peer('a', { fileViewerPresent: { shapeId: 's1', fraction: 0.1 } })],
		's1'
	)
	assert.equal(winner?.ts, 0, 'missing ts normalises to 0')
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && bun src/file-viewer/followLogic.test.ts`
Expected: FAIL — `winner?.ts` is `undefined` (property doesn't exist yet); typecheck may also flag it.

- [ ] **Step 3: Implement**

In `client/src/file-viewer/followLogic.ts`: add `ts: number` to `PresenterInfo`; in `presenterFor`, set `ts` on the `best` object from the already-computed `const ts` local.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && bun src/file-viewer/followLogic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/file-viewer/followLogic.ts client/src/file-viewer/followLogic.test.ts
git commit -m "feat(file-viewer): expose winning token ts from presenterFor"
```

---

### Task 3: Baton UX in the shape — grab on edit, yield on steal, no opt-out, frozen mirror

**Files:**
- Modify: `client/src/file-viewer/FileViewerShapeUtil.tsx`
- Modify: `client/src/file-viewer/RrwebMirror.tsx` (frozen variant)
- Modify: `client/src/App.tsx:25-26,156-160` (drop followingStore from presence meta)
- Delete: `client/src/file-viewer/followingStore.ts`
- Test: `client/src/file-viewer/followLogic.test.ts` stays green; behaviour here is hook/JSX-heavy — verified by typecheck + the Task 4 browser smoke. No new unit test file (no DOM-free seam worth extracting; the LWW/ts logic already lives in followLogic).

**Interfaces:**
- Consumes: `PresenterInfo.ts` from Task 2; relay retention from Task 1 (frozen backlog).
- Produces: final UI. `RrwebMirror` gains optional prop `frozen?: boolean` (default false): when true it seeds from backlog only and hides the cursor/name pill.

Implementation detail, `FileViewerShapeUtil.tsx` (`FileViewerShapeComponent`):

1. **Delete opt-out:** remove `optOutId` state, the `FollowingChip` component and its render, and the `useEffect` that resets `optOutId`. `activePresenter` becomes:

```ts
const activePresenter: PresenterInfo | null = !isPresentingThis && peerPresenter ? peerPresenter : null
```

2. **Grab on edit-start:** editing this shape = taking the baton.

```ts
// Editing IS controlling (force-follow spec): starting to edit grabs the
// baton, so interaction intent and presentation are the same thing.
useEffect(() => {
	if (isEditing && !isPresentingThis) {
		presentStore.set({ shapeId: shape.id, fraction: lastFractionRef.current, ts: Date.now() })
	}
	// eslint-disable-next-line react-hooks/exhaustive-deps
}, [isEditing])
```

3. **Yield on steal:** an incumbent whose token is out-stamped drops it (and leaves editing so the mirror swaps in cleanly):

```ts
// Someone else took control (their token out-stamps ours): yield — clear our
// token and exit editing so our iframe hides behind their mirror.
const myTs = presenting?.shapeId === shape.id ? presenting.ts : null
useEffect(() => {
	if (myTs !== null && peerPresenter && peerPresenter.ts > myTs) {
		presentStore.set(null)
		if (editor.getEditingShapeId() === shape.id) editor.setEditingShape(null)
	}
	// eslint-disable-next-line react-hooks/exhaustive-deps
}, [myTs, peerPresenter?.ts, peerPresenter?.userId])
```

4. **Header button:** replace the Present toggle with take-control:

```tsx
<HeaderButton
	label={isPresentingThis ? 'You have control' : 'Take control'}
	title={
		isPresentingThis
			? 'You are controlling this viewer — everyone sees your view'
			: 'Take control — everyone follows your view'
	}
	active={isPresentingThis}
	disabled={isPresentingThis}
	onClick={() => {
		if (!isPresentingThis) {
			presentStore.set({ shapeId: shape.id, fraction: lastFractionRef.current, ts: Date.now() })
		}
	}}
/>
```

There is no toggle-off path: the baton releases only via presence expiry (disconnect) or steal. Also update the header's controller attribution: while a peer controls, render `<span>…{peerPresenter.userName} has control</span>` where FollowingChip used to sit (plain text, no stop button).

5. **Frozen state:** when NOBODY holds a token, mount the mirror frozen instead of the interactive document:

```ts
const anyController = isPresentingThis || peerPresenter !== null
// Frozen last view: no controller → the mirror replays the backlog and sits
// still. mirrorFallback (no backlog / old server) reveals the plain iframe.
const showFrozen = !anyController && !mirrorFallback && !isEditing
```

Render: `RrwebMirror` mounts when `(activePresenter && !mirrorFallback)` (live, as today) OR `showFrozen` (pass `frozen`, `presenterName=""`, `presenterColor={PRESENTER_FALLBACK_COLOR}`). While `showFrozen`, the header's right-side hint (the `!isEditing` "double-click to interact" span) reads `last presented view — take control to interact` instead (the presenter's name is gone with their presence, so the hint is nameless). The iframe's `display: none` condition becomes `(activePresenter && !mirrorFallback) || showFrozen ? 'none' : undefined`. The iframe keeps `pointerEvents: isEditing ? 'all' : 'none'` — a non-controller can't scroll it even when visible via fallback. Reset `mirrorFallback` to `false` whenever `anyController` flips or `rev` changes (a refresh may repopulate), reusing the existing reset-effect pattern.

6. **Audience dots:** everyone in the room is a follower by definition now. In the `fvAudienceKey` selector: drop the `followingStore` read and the `'idle'`/`'following'` distinction — state is `'presenting'` for the controller, `'watching'` for everyone else; keep rendering the row whenever a controller exists (frozen state shows no dots). In `AudienceRow`, solid dot for `'watching'`, ringed for `'presenting'`; delete the dimmed style and the "not following" title branch.

7. **Delete followingStore:** remove the import + the publish `useEffect`; delete `client/src/file-viewer/followingStore.ts`; in `client/src/App.tsx` remove the `followingStore` import and the `fileViewerFollowing` field from presence meta (keep `fileViewerPresent`). Grep for any other `fileViewerFollowing` readers (the audience selector was the only one) and remove them.

`RrwebMirror.tsx` changes:

```ts
// New prop:
frozen?: boolean
```

- When `frozen`, skip `styleCursor()` and instead hide the replayer cursor: after construction add `hostRef.current?.querySelector('.replayer-mouse')?.classList.add('ew-mirror-frozen')` — add `.ew-mirror-frozen { display: none !important; }` to `rrwebMirror.css`.
- Frozen mode still seeds from the HTTP backlog and still subscribes to the follow store (a new live presentation arriving while frozen simply plays — the parent will remount as live anyway when presence catches up).
- Fallback timer behaviour is unchanged: an empty/missing backlog fires `onFallback` after 2 s and the parent reveals the plain iframe.

- [ ] **Step 1: Implement all seven changes above**

- [ ] **Step 2: Typecheck + run client unit tests**

Run: `bun run typecheck && cd client && bun src/file-viewer/followLogic.test.ts && bun src/file-viewer/presentBroadcast.test.ts && bun src/file-viewer/rrwebFollow.test.ts`
Expected: all pass; no `followingStore` references anywhere (`grep -rn followingStore client/src` returns nothing).

- [ ] **Step 3: Commit**

```bash
git add -A client/src
git commit -m "feat(file-viewer): force-follow baton — grab on edit, yield on steal, frozen last view, no opt-out"
```

---

### Task 4: Whole-feature verification + PR update

**Files:**
- Modify: PR #71 body (gh CLI)

- [ ] **Step 1: Full check**

Run: `bun install && bun run typecheck && bun run build`
Expected: clean build.

Run all touched test scripts once more:
`cd server && bun src/present-relay.test.ts && bun src/files-render.test.ts && cd ../client && bun src/file-viewer/followLogic.test.ts && bun src/file-viewer/presentBroadcast.test.ts && bun src/file-viewer/rrwebFollow.test.ts`
Expected: all pass.

- [ ] **Step 2: Browser smoke (two contexts)**

Against the local dev stack (`bin/dev up`, Vite on :5173 / Caddy :8080), with two browser contexts in the same room on a file-viewer shape:

1. A double-clicks into the shape → A's header shows "You have control"; B's shape shows A's mirror with "A has control" text and NO stop affordance.
2. B clicks "Take control" → A's iframe flips to B's mirror; A's editing ends.
3. B closes their tab → within presence expiry, A sees the frozen last view (mirror, no cursor); a third context C joining fresh also sees the frozen view.
4. A double-clicks → frozen view swaps to A's live control.

Record what was observed (or what broke) in the task report.

- [ ] **Step 3: Update PR #71**

Append to the PR body (via `gh pr edit 71 --body-file`): a "Force-follow (baton) model" section summarising the change + the line
`ux-contract: none — legacy v1 tldraw file-viewer UI; not a canvas-editor/canvas-react/canvas-v2 contract surface`.

- [ ] **Step 4: Push**

```bash
git push
```
