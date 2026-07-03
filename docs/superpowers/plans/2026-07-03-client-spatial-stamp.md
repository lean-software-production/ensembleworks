# Client-Computed Spatial Stamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each browser computes its own `{at, frame}` spatial stamp from the CRDT replica it already holds and publishes it via `presence.meta.stamp`; the server reads that field for transcript stamping and read-endpoint sort points, deleting `frameAtPoint`/`viewportCenter` and the per-utterance document walk from the sync server's event loop.

**Architecture:** A new dependency-free pure module `client/src/presence/stamp.ts` ports the server's frame geometry and runs inside tldraw's reactive `getUserPresence` derivation (wired in `client/src/App.tsx`). On the server (`server/src/app.ts`), `CursorRef` gains a defensively-parsed `stamp` field; `POST /api/transcript` copies it instead of walking a snapshot, and `/api/frames` + `/api/frame` sort by the stamp point (falling back to the raw cursor — point *selection*, not geometry). Spec: `docs/superpowers/specs/2026-07-03-client-spatial-stamp-design.md`.

**Tech Stack:** TypeScript, tldraw 5.1 (`useSync` `getUserPresence` override, `TLInstancePresence.meta`), Express, tests as standalone `npx tsx src/<name>.test.ts` scripts with `node:assert/strict` (house style — no test framework).

---

## File structure

| File | Responsibility |
|---|---|
| `client/src/presence/stamp.ts` (create) | Pure geometry: `computeStamp(records, inputs)` → `{at, frame}`. No imports. The single home of the frame-matching semantics. |
| `client/src/presence/stamp.test.ts` (create) | Unit tests for `computeStamp` (containment, viewport fallback, cursor fallback, nesting, no-frames, other-page frames). |
| `client/src/App.tsx` (modify, ~line 69) | Wire `getUserPresence` into `useSync`: default presence + `meta: { stamp }`. |
| `server/src/app.ts` (modify) | `SpatialStamp` type + `parseStamp` + `CursorRef.stamp` (~line 154–200); transcript block reads stamp (~line 628–653); `sortPointOf` used by `byProximity` (~line 318) and both `sortedBy` blocks (~lines 1017, 1089); **delete** `frameAtPoint` (~line 292) and `viewportCenter` (~line 243). |
| `server/src/scribe-api.test.ts` (modify) | Stamping cases 4/4b rewritten: server echoes `meta.stamp` verbatim; missing stamp ⇒ nulls. |
| `server/src/canvas-api.test.ts` (modify) | Case 6e extended: reads sort by the stamp point when present, raw cursor otherwise. |

Conventions honoured: pure logic in dependency-free unit-tested modules (like `av/spatial.ts`, `terminal/grid.ts`); wire shapes duplicated client/server carry a "Keep in sync" comment (no `@ensembleworks/contracts` package exists yet — this pair is flagged as an early extraction candidate); commits land directly on `main`.

---

### Task 1: Pure stamp module (`client/src/presence/stamp.ts`)

**Files:**
- Create: `client/src/presence/stamp.test.ts`
- Create: `client/src/presence/stamp.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/presence/stamp.test.ts`:

```ts
/**
 * Tests for the client-computed spatial stamp — the {at, frame} pair each
 * browser publishes via presence.meta.stamp. Semantics must match what the
 * server used to compute in app.ts (frameAtPoint/viewportCenter), relocated.
 * Run with: npx tsx src/presence/stamp.test.ts
 */
import assert from 'node:assert/strict'
import { computeStamp, type StampRecord } from './stamp'

// One page, one 800×600 frame at (1000, 0) — same fixture geometry the
// server tests use ("Drafting — crew-a" at 1000..1800 × 0..600).
const FRAME: StampRecord = {
	id: 'shape:frame-drafting',
	typeName: 'shape',
	type: 'frame',
	parentId: 'page:page',
	x: 1000,
	y: 0,
	props: { w: 800, h: 600, name: 'Drafting — crew-a' },
}
const PAGE_RECORD: StampRecord = { id: 'page:page', typeName: 'page' }

const NO_VIEW = { camera: null, screenBounds: null }

// 1. Cursor inside a frame wins: at = cursor, frame = that frame, dist 0.
{
	const stamp = computeStamp([PAGE_RECORD, FRAME], {
		currentPageId: 'page:page',
		cursor: { x: 1200, y: 300 },
		camera: { x: 0, y: 0, z: 1 },
		screenBounds: { w: 1920, h: 1080 },
	})
	assert.deepEqual(stamp.at, { x: 1200, y: 300 }, 'at is the cursor when it is inside a frame')
	assert.equal(stamp.frame?.name, 'Drafting — crew-a')
	assert.equal(stamp.frame?.dist, 0, 'inside the frame ⇒ dist 0')
	console.log('ok: cursor inside frame ⇒ at=cursor, dist 0')
}

// 2. Cursor parked outside every frame ⇒ locate by viewport centre.
// centre = (w/2/z − camX, h/2/z − camY) = (400 − (−1000), 100 − (−200)) = (1400, 300).
{
	const stamp = computeStamp([PAGE_RECORD, FRAME], {
		currentPageId: 'page:page',
		cursor: { x: 50, y: 5000 },
		camera: { x: -1000, y: -200, z: 1 },
		screenBounds: { w: 800, h: 200 },
	})
	assert.deepEqual(stamp.at, { x: 1400, y: 300 }, 'at is the viewport centre, not the parked cursor')
	assert.equal(stamp.frame?.name, 'Drafting — crew-a')
	assert.equal(stamp.frame?.dist, 0, 'viewport centre is inside the frame ⇒ dist 0')
	console.log('ok: parked cursor ⇒ at=viewport centre')
}

// 3. No camera/screenBounds ⇒ fall back to the cursor; nearest frame by edge
// distance. Cursor at (900, 300) is 100 left of the frame's x=1000 edge.
{
	const stamp = computeStamp([PAGE_RECORD, FRAME], {
		currentPageId: 'page:page',
		cursor: { x: 900, y: 300 },
		...NO_VIEW,
	})
	assert.deepEqual(stamp.at, { x: 900, y: 300 })
	assert.equal(stamp.frame?.name, 'Drafting — crew-a')
	assert.equal(stamp.frame?.dist, 100, 'edge distance to the nearest frame')
	console.log('ok: no camera ⇒ at=cursor, nearest frame by edge distance')
}

// 4. Nested frames: a child frame's x/y are parent-relative, so page-space
// containment must add the parent offset. The child deliberately protrudes
// past its parent's right edge: parent spans 1000..1800, child (parent-
// relative x:700, w:200) spans page 1700..1900. A point at (1850, 100) is
// inside the child ONLY — finding it proves the offset arithmetic.
{
	const child: StampRecord = {
		id: 'shape:frame-child',
		typeName: 'shape',
		type: 'frame',
		parentId: 'shape:frame-drafting',
		x: 700,
		y: 30,
		props: { w: 200, h: 100, name: 'Child' },
	}
	const stamp = computeStamp([PAGE_RECORD, FRAME, child], {
		currentPageId: 'page:page',
		cursor: { x: 1850, y: 100 },
		...NO_VIEW,
	})
	assert.equal(stamp.frame?.name, 'Child', 'child frame resolved in page space')
	assert.equal(stamp.frame?.dist, 0, 'point is inside the (offset) child rect')
	console.log('ok: nested frame coordinates resolve to page space')
}

// 5. A page with no frames ⇒ frame: null, at still recorded.
{
	const stamp = computeStamp([PAGE_RECORD], {
		currentPageId: 'page:page',
		cursor: { x: 10, y: 20 },
		...NO_VIEW,
	})
	assert.deepEqual(stamp.at, { x: 10, y: 20 })
	assert.equal(stamp.frame, null, 'no frames on the page ⇒ frame is null')
	console.log('ok: no frames ⇒ frame null, at recorded')
}

// 6. Frames on other pages are ignored.
{
	const otherPageFrame: StampRecord = {
		id: 'shape:frame-elsewhere',
		typeName: 'shape',
		type: 'frame',
		parentId: 'page:other',
		x: 0,
		y: 0,
		props: { w: 100, h: 100, name: 'Elsewhere' },
	}
	const stamp = computeStamp([PAGE_RECORD, otherPageFrame], {
		currentPageId: 'page:page',
		cursor: { x: 50, y: 50 },
		...NO_VIEW,
	})
	assert.equal(stamp.frame, null, 'frames on other pages never match')
	console.log('ok: other-page frames ignored')
}

// 7. Fractional inputs are rounded on the way out (the wire carries ints).
{
	const stamp = computeStamp([PAGE_RECORD, FRAME], {
		currentPageId: 'page:page',
		cursor: { x: 1200.6, y: 300.4 },
		...NO_VIEW,
	})
	assert.deepEqual(stamp.at, { x: 1201, y: 300 }, 'at is rounded to integers')
	console.log('ok: at is rounded')
}

console.log('stamp.test.ts: all tests passed')
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd client && npx tsx src/presence/stamp.test.ts
```

Expected: FAIL — `Cannot find module './stamp'` (or equivalent ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Write the implementation**

Create `client/src/presence/stamp.ts`:

```ts
/**
 * Client-computed spatial stamp: where am I on the canvas (page space) and
 * which frame am I at? Each browser computes this for itself from the CRDT
 * replica it already holds and publishes it via presence.meta.stamp; the
 * server reads the field instead of walking the document (transcript
 * stamping, proximity-ordered agent reads).
 *
 * Semantics (ported verbatim from the server's former frameAtPoint /
 * viewportCenter): the mouse cursor wins when it is inside a frame (they're
 * pointing at something); otherwise the viewport centre (what they're
 * looking at), falling back to the cursor when camera/screenBounds are
 * unavailable. `at` and `frame` always agree — `frame` was matched against
 * exactly the point recorded in `at`.
 *
 * Pure and dependency-free so it is unit-testable and safe inside the
 * reactive getUserPresence derivation.
 *
 * Keep in sync with the server-side consumer: SpatialStamp / parseStamp in
 * server/src/app.ts. (Early extraction candidate for @ensembleworks/contracts.)
 */

// The minimal structural slice of a tldraw store record the stamp needs.
export interface StampRecord {
	id: string
	typeName?: string
	type?: string
	parentId?: string
	x?: number
	y?: number
	props?: Record<string, unknown>
}

export interface StampInputs {
	currentPageId: string
	cursor: { x: number; y: number }
	camera: { x: number; y: number; z: number } | null
	screenBounds: { w: number; h: number } | null
}

// The wire shape carried in presence.meta.stamp. A `type` (not interface) so
// it structurally satisfies tldraw's JsonObject for the meta field.
export type SpatialStamp = {
	at: { x: number; y: number }
	frame: { name: string; dist: number } | null
}

// The page id a shape ultimately lives on (walks up nested parents).
function pageIdOf(shape: StampRecord, byId: Map<string, StampRecord>): string | null {
	let pid: string | undefined = shape.parentId
	let guard = 0
	while (pid && pid.startsWith('shape:') && guard++ < 50) {
		pid = byId.get(pid)?.parentId
	}
	return pid ?? null
}

// A shape's top-left in page coordinates (child x/y are parent-relative).
function pagePoint(shape: StampRecord, byId: Map<string, StampRecord>): { x: number; y: number } {
	let x = shape.x ?? 0
	let y = shape.y ?? 0
	let parent = shape.parentId ? byId.get(shape.parentId) : undefined
	let guard = 0
	while (parent && parent.typeName === 'shape' && guard++ < 50) {
		x += parent.x ?? 0
		y += parent.y ?? 0
		parent = parent.parentId ? byId.get(parent.parentId) : undefined
	}
	return { x, y }
}

// The frame a point is inside of (dist 0), or the nearest one on the same
// page (distance to the frame's edge). First-best-wins on ties.
function frameAtPoint(
	shapes: StampRecord[],
	byId: Map<string, StampRecord>,
	pageId: string,
	point: { x: number; y: number }
): { name: string; dist: number } | null {
	let best: { name: string; dist: number } | null = null
	for (const f of shapes) {
		if (f.type !== 'frame' || pageIdOf(f, byId) !== pageId) continue
		const pt = pagePoint(f, byId)
		const w = typeof f.props?.w === 'number' ? f.props.w : 0
		const h = typeof f.props?.h === 'number' ? f.props.h : 0
		// Distance from the point to the frame rect (0 when inside).
		const dx = Math.max(pt.x - point.x, 0, point.x - (pt.x + w))
		const dy = Math.max(pt.y - point.y, 0, point.y - (pt.y + h))
		const d = Math.hypot(dx, dy)
		if (!best || d < best.dist) {
			best = { name: typeof f.props?.name === 'string' ? f.props.name : '', dist: Math.round(d) }
		}
	}
	return best
}

// The page point at the centre of my viewport — what I'm looking at.
// tldraw screen→page is page = screen/z − camera, evaluated at the centre.
function viewportCenter(
	camera: { x: number; y: number; z: number } | null,
	screenBounds: { w: number; h: number } | null
): { x: number; y: number } | null {
	if (!camera || !screenBounds) return null
	const z = camera.z || 1
	return { x: screenBounds.w / 2 / z - camera.x, y: screenBounds.h / 2 / z - camera.y }
}

export function computeStamp(records: readonly StampRecord[], inputs: StampInputs): SpatialStamp {
	const byId = new Map(records.map((r) => [r.id, r]))
	const shapes = records.filter((r) => r.typeName === 'shape')
	const atCursor = frameAtPoint(shapes, byId, inputs.currentPageId, inputs.cursor)
	let at = inputs.cursor
	let frame = atCursor
	if (!(atCursor && atCursor.dist === 0)) {
		at = viewportCenter(inputs.camera, inputs.screenBounds) ?? inputs.cursor
		frame = frameAtPoint(shapes, byId, inputs.currentPageId, at)
	}
	return { at: { x: Math.round(at.x), y: Math.round(at.y) }, frame }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd client && npx tsx src/presence/stamp.test.ts
```

Expected: all `ok:` lines then `stamp.test.ts: all tests passed`, exit 0.

- [ ] **Step 5: Typecheck and commit**

```bash
cd client && npm run typecheck
cd .. && git add client/src/presence/stamp.ts client/src/presence/stamp.test.ts
git commit -m "feat(presence): pure client-side spatial stamp module

Ports frameAtPoint/viewportCenter semantics from server/src/app.ts into a
dependency-free client module, ahead of publishing the stamp via
presence.meta (spec: docs/superpowers/specs/2026-07-03-client-spatial-stamp-design.md)."
```

---

### Task 2: Publish the stamp via `getUserPresence` (`client/src/App.tsx`)

**Files:**
- Modify: `client/src/App.tsx` (imports at lines 1–11; `useSync` options at lines 69–77)

- [ ] **Step 1: Add the imports**

In `client/src/App.tsx`, add `getDefaultUserPresence` to the existing `tldraw` import (it re-exports `@tldraw/tlschema`), and import the stamp module:

```ts
import {
	DefaultColorStyle,
	Editor,
	Tldraw,
	defaultBindingUtils,
	defaultShapeUtils,
	getDefaultUserPresence,
	getUserPreferences,
	setUserPreferences,
} from 'tldraw'
```

and below the existing imports (next to `identity`):

```ts
import { computeStamp, type StampRecord } from './presence/stamp'
```

- [ ] **Step 2: Wire `getUserPresence` into `useSync`**

Extend the `useSync` options object (currently lines 69–77) with a `getUserPresence` entry after `onCustomMessageReceived`:

```ts
	const store = useSync({
		uri: `${wsBase()}/sync/${roomId}?userId=${encodeURIComponent(identity.id)}`,
		assets: assetStore,
		shapeUtils: useMemo(() => [...defaultShapeUtils, ...customShapeUtils], []),
		bindingUtils: useMemo(() => [...defaultBindingUtils], []),
		onCustomMessageReceived(message) {
			if (message?.type === 'kicked') setWasKicked(true)
		},
		// Publish the client-computed spatial stamp (client/src/presence/stamp.ts)
		// on our presence record. Reactive: recomputes exactly when the cursor,
		// camera, page or frames change, so the server (transcript stamping,
		// proximity-ordered reads) only ever reads a field. O(frames on page)
		// per recompute — noise next to tldraw's own pointer hit-testing.
		getUserPresence(store, user) {
			const defaults = getDefaultUserPresence(store, user)
			if (!defaults) return null
			const stamp = computeStamp(store.allRecords() as unknown as StampRecord[], {
				currentPageId: defaults.currentPageId,
				cursor: defaults.cursor,
				camera: defaults.camera ?? null,
				screenBounds: defaults.screenBounds ?? null,
			})
			return { ...defaults, meta: { stamp } }
		},
	})
```

- [ ] **Step 3: Typecheck**

```bash
cd client && npm run typecheck
```

Expected: clean exit. If `meta: { stamp }` is rejected against `JsonObject`, the fix is in Task 1's module (make sure `SpatialStamp` is a `type`, not an `interface`) — do not cast here.

- [ ] **Step 4: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat(presence): publish the spatial stamp via getUserPresence meta"
```

---

### Task 3: Transcript stamping reads the presence stamp (`server/src/app.ts`)

**Files:**
- Modify: `server/src/scribe-api.test.ts` (cases 4 and 4b, lines ~112–219)
- Modify: `server/src/app.ts` (`CursorRef` ~line 154; `getCursorRefs` ~line 176; transcript block lines ~628–653; delete `viewportCenter` ~line 243 and `frameAtPoint` ~line 292)
- Modify: `server/src/participants-api.test.ts` (the `ref()` fixture factory at lines 13–19 — it builds full `CursorRef` literals and needs the new field's default)

- [ ] **Step 1: Rewrite the stamping tests to expect stamp echo**

In `server/src/scribe-api.test.ts`, replace case 4 (lines 112–164). The presence record now carries `meta.stamp`, and the stamp's values are deliberately offset from the raw cursor so the test proves the server **echoes the stamp** rather than recomputing geometry:

```ts
	// 4. Spatial stamping: the speaker's browser computes {at, frame} from its
	// own CRDT replica and publishes it as presence.meta.stamp; the server
	// echoes it onto the transcript entry verbatim. The stamp's `at` is
	// deliberately offset from the raw cursor to prove no server geometry runs.
	// The scribe posts the raw LiveKit identity ("speaker-1") while tldraw
	// presence stores the prefixed userId ("user:speaker-1"); the stamp must
	// match across that prefix.
	{
		const ws = await new Promise<WebSocket>((resolve, reject) => {
			const s = new WebSocket(
				`ws://127.0.0.1:${address.port}/sync/test?sessionId=tab1&storeId=s1&userId=speaker-1`
			)
			s.once('open', () => resolve(s))
			s.once('error', reject)
		})
		const connected = new Promise<void>((resolve) =>
			ws.on('message', (d) => {
				if (JSON.parse(d.toString()).type === 'connect') resolve()
			})
		)
		ws.send(
			JSON.stringify({
				type: 'connect', connectRequestId: 'r1', lastServerClock: 0, protocolVersion: 8,
				schema: schema.serialize(),
			})
		)
		await connected
		ws.send(
			JSON.stringify({
				type: 'push', clock: 1,
				presence: ['put', {
					userId: 'user:speaker-1', userName: 'Speaker One', color: '#FF0000', currentPageId: 'page:page',
					cursor: { x: 1200, y: 300, type: 'default', rotation: 0 },
					camera: { x: 0, y: 0, z: 1 }, selectedShapeIds: [], screenBounds: { x: 0, y: 0, w: 1, h: 1 },
					lastActivityTimestamp: 10, followingUserId: null, brush: null, scribbles: [], chatMessage: '',
					meta: { stamp: { at: { x: 1201, y: 301 }, frame: { name: 'Drafting — crew-a', dist: 0 } } },
				}],
			})
		)
		await new Promise((r) => setTimeout(r, 300))

		const res = await postJson('/api/transcript', {
			room: 'test',
			identity: 'speaker-1',
			name: 'Speaker One',
			text: 'I think the spec is too loose here',
		})
		assert.equal(res.status, 200)
		assert.deepEqual(res.body.entry.cursor, { x: 1201, y: 301 }, 'stamp.at echoed, not the raw cursor')
		assert.equal(res.body.entry.page, 'page:page')
		assert.equal(res.body.entry.frame.name, 'Drafting — crew-a', 'stamp.frame echoed')
		assert.equal(res.body.entry.frame.dist, 0)
		ws.close()
		await new Promise((r) => setTimeout(r, 100))
		console.log('ok: transcript echoes the client-computed presence stamp')
	}
```

Replace case 4b (lines 166–219) entirely — viewport-fallback geometry is now the client's concern (covered by `stamp.test.ts` case 2); the server-side case that remains is a connected tab **without** a stamp (pre-deploy bundle):

```ts
	// 4b. Stampless presence (a tab still on a pre-stamp bundle): page is
	// stamped from presence, but cursor/frame are null — same as no tab open.
	// No server-side geometry fallback by design (spec decision 2).
	{
		const ws = await new Promise<WebSocket>((resolve, reject) => {
			const s = new WebSocket(
				`ws://127.0.0.1:${address.port}/sync/test?sessionId=tab2&storeId=s1&userId=speaker-2`
			)
			s.once('open', () => resolve(s))
			s.once('error', reject)
		})
		const connected = new Promise<void>((resolve) =>
			ws.on('message', (d) => {
				if (JSON.parse(d.toString()).type === 'connect') resolve()
			})
		)
		ws.send(
			JSON.stringify({
				type: 'connect', connectRequestId: 'r2', lastServerClock: 0, protocolVersion: 8,
				schema: schema.serialize(),
			})
		)
		await connected
		ws.send(
			JSON.stringify({
				type: 'push', clock: 1,
				presence: ['put', {
					userId: 'user:speaker-2', userName: 'Speaker Two', color: '#00FF00', currentPageId: 'page:page',
					cursor: { x: 1200, y: 300, type: 'default', rotation: 0 },
					camera: { x: 0, y: 0, z: 1 }, selectedShapeIds: [], screenBounds: { x: 0, y: 0, w: 800, h: 200 },
					lastActivityTimestamp: 20, followingUserId: null, brush: null, scribbles: [], chatMessage: '', meta: {},
				}],
			})
		)
		await new Promise((r) => setTimeout(r, 300))

		const res = await postJson('/api/transcript', {
			room: 'test',
			identity: 'speaker-2',
			name: 'Speaker Two',
			text: 'I reckon we cut this scope',
		})
		assert.equal(res.status, 200)
		assert.equal(res.body.entry.page, 'page:page', 'page still stamped from presence')
		assert.equal(res.body.entry.cursor, null, 'no stamp ⇒ no cursor (no server geometry fallback)')
		assert.equal(res.body.entry.frame, null, 'no stamp ⇒ no frame')
		ws.close()
		await new Promise((r) => setTimeout(r, 100))
		console.log('ok: stampless presence yields page-only stamp')
	}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npx tsx src/scribe-api.test.ts
```

Expected: FAIL — case 4 asserts `{x: 1201, y: 301}` but the (still geometry-computing) server stamps the raw cursor `{x: 1200, y: 300}`.

- [ ] **Step 3: Implement — `SpatialStamp` + `parseStamp` + `CursorRef.stamp`**

In `server/src/app.ts`, extend `CursorRef` (line 154) and add the stamp types just above it:

```ts
// The client-computed spatial stamp carried in presence.meta.stamp: the
// point the speaker is at (their cursor when it's inside a frame, else
// their viewport centre) and the frame containing/nearest that point —
// computed by each browser from its own CRDT replica, so the server never
// walks the document for it. Keep in sync with client/src/presence/stamp.ts.
export interface SpatialStamp {
	at: { x: number; y: number }
	frame: { name: string; dist: number } | null
}

// Defensive parse of the wire value — never trust presence meta.
function parseStamp(s: any): SpatialStamp | null {
	if (!s || typeof s.at?.x !== 'number' || typeof s.at?.y !== 'number') return null
	const frame =
		s.frame && typeof s.frame.name === 'string' && typeof s.frame.dist === 'number'
			? { name: s.frame.name.slice(0, 256), dist: Math.round(s.frame.dist) }
			: null
	return { at: { x: Math.round(s.at.x), y: Math.round(s.at.y) }, frame }
}

export interface CursorRef {
	userId: string | null
	userName: string
	currentPageId: string
	cursor: { x: number; y: number }
	// Camera + viewport, used to stamp the frame a speaker is *looking at* when
	// their mouse cursor isn't pointing inside a frame (null on tldraw versions
	// or presence records that omit them).
	camera: { x: number; y: number; z: number } | null
	screenBounds: { w: number; h: number } | null
	lastActivityTimestamp: number
	// Client-computed spatial stamp (null: pre-stamp bundle or non-canvas peer).
	stamp: SpatialStamp | null
}
```

In `getCursorRefs` (the `.map` at lines 185–199), add one field to the returned object:

```ts
			lastActivityTimestamp: p.lastActivityTimestamp ?? 0,
			stamp: parseStamp(p.meta?.stamp),
```

In `server/src/participants-api.test.ts`, the `ref()` factory (lines 13–19) builds complete `CursorRef` literals; add the new field to its defaults so the workspace still typechecks:

```ts
		lastActivityTimestamp: 0,
		stamp: null,
```

- [ ] **Step 4: Implement — transcript block reads the stamp**

In `POST /api/transcript`, replace lines 628–663 (from the `// Best-effort spatial stamp` comment through `transcripts.append`) with:

```ts
		// Best-effort spatial stamp, computed by the speaker's own browser from
		// its CRDT replica and published as presence.meta.stamp — the server
		// just copies the field (client/src/presence/stamp.ts owns the
		// semantics: cursor-inside-frame wins, else viewport centre). No live
		// tab, or a pre-stamp bundle, ⇒ unstamped entry. No server-side
		// geometry fallback by design.
		const room = getOrCreateRoom(roomId)
		const want = rawUserId(identity)
		const ref = getCursorRefs(room).find((r) => rawUserId(r.userId) === want) ?? null

		const entry = await transcripts.append(roomId, {
			identity,
			name,
			text,
			t,
			page: ref?.currentPageId ?? null,
			cursor: ref?.stamp?.at ?? null,
			frame: ref?.stamp?.frame ?? null,
		})
```

- [ ] **Step 5: Delete the dead geometry**

Still in `server/src/app.ts`, delete whole functions:
- `viewportCenter` (lines ~240–250, including its comment block)
- `frameAtPoint` (lines ~288–313, including its comment block)

`pageIdOf`, `pagePoint`, `dist`, and `byProximity` **stay** — the read endpoints still build responses with them. The `camera`/`screenBounds` fields on `CursorRef` also stay (still parsed; documented as presence passthrough).

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd server && npx tsx src/scribe-api.test.ts && npx tsx src/canvas-api.test.ts && npm run typecheck
```

Expected: both test scripts end with `all tests passed`; typecheck clean. (`canvas-api.test.ts` is unchanged so far and must not regress — its 6e case pushes stampless presence, which still sorts by raw cursor after Task 4's fallback.)

- [ ] **Step 7: Verify the success criteria greps**

```bash
grep -n "frameAtPoint\|viewportCenter" server/src/app.ts
```

Expected: no output (both deleted).

```bash
grep -n "getCurrentSnapshot" server/src/app.ts | head
```

Expected: no hit inside the `/api/transcript` handler (hits in `/api/frames`, `/api/frame`, `/api/sticky`, `/api/shape` handlers are fine).

- [ ] **Step 8: Commit**

```bash
git add server/src/app.ts server/src/scribe-api.test.ts server/src/participants-api.test.ts
git commit -m "feat(scribe): transcript stamping reads the client-computed presence stamp

POST /api/transcript no longer touches the document: the speaker's browser
computes {at, frame} (client/src/presence/stamp.ts) and the server copies it
from presence.meta.stamp. frameAtPoint/viewportCenter deleted — no server
geometry fallback by design (spec decision 2)."
```

---

### Task 4: Read endpoints sort by the stamp point (`server/src/app.ts`)

**Files:**
- Modify: `server/src/canvas-api.test.ts` (extend case 6e, after line ~296)
- Modify: `server/src/app.ts` (`byProximity` ~line 318; `sortedBy` blocks in `/api/frames` ~line 1017 and `/api/frame` ~line 1089)

- [ ] **Step 1: Extend the proximity test**

In `server/src/canvas-api.test.ts`, inside case 6e after the existing `dist` assertion (line ~296, before `ws.close()`), add a second presence push carrying a stamp whose point sits on the FAR note — order must flip and `sortedBy.cursor` must report the stamp point. Note geometry: frame at x:1000, FAR note at frame-relative (10, 10) ⇒ page (1010, 10); NEAR at (1600, 400).

```ts
		// Same tab publishes a stamp whose point is on top of the FAR note while
		// the raw cursor stays on NEAR: reads must sort by the stamp point (what
		// the user is at/looking at), and sortedBy must report that point.
		ws.send(
			JSON.stringify({
				type: 'push', clock: 2,
				presence: ['put', {
					userId: 'mover', userName: 'Mover', color: '#FF0000', currentPageId: 'page:page',
					cursor: { x: FRAME_X + 600, y: 400, type: 'default', rotation: 0 },
					camera: { x: 0, y: 0, z: 1 }, selectedShapeIds: [], screenBounds: { x: 0, y: 0, w: 1, h: 1 },
					lastActivityTimestamp: 20, followingUserId: null, brush: null, scribbles: [], chatMessage: '',
					meta: { stamp: { at: { x: FRAME_X + 10, y: 10 }, frame: { name: 'Advice — crew-a', dist: 0 } } },
				}],
			})
		)
		await new Promise((r) => setTimeout(r, 300))

		const stamped = await getJson('/api/frame?room=test&name=advice')
		assert.equal(stamped.status, 200)
		assert.deepEqual(
			stamped.body.sortedBy.cursor,
			{ x: FRAME_X + 10, y: 10 },
			'sortedBy reports the stamp point actually used'
		)
		const stampedTexts = stamped.body.notes.map((n: any) => n.text)
		assert.ok(
			stampedTexts.indexOf('FAR') < stampedTexts.indexOf('NEAR'),
			`stamp point flips the order, got ${JSON.stringify(stampedTexts)}`
		)
		console.log('ok: /api/frame sorts by the presence stamp point when present')
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npx tsx src/canvas-api.test.ts
```

Expected: FAIL — `sortedBy.cursor` is still the raw cursor `{x: 1600, y: 400}` and NEAR still sorts first.

- [ ] **Step 3: Implement `sortPointOf` and use it**

In `server/src/app.ts`, add above `byProximity` (~line 315):

```ts
// The point a teammate's reads are ordered by: their client-computed stamp
// point when present (where they're at / looking at — the cursor is usually
// parked off-canvas since the camera bubble decoupled from it), else the raw
// cursor. Point *selection* only; no geometry is recomputed here.
function sortPointOf(ref: CursorRef): { x: number; y: number } {
	return ref.stamp?.at ?? ref.cursor
}
```

In `byProximity` (line ~324), change the distance line:

```ts
		const d = cursor ? dist(pt, sortPointOf(cursor)) : null
```

In `/api/frames` (line ~1017), change the `sortedBy` block:

```ts
			sortedBy: cursor ? { userName: cursor.userName, page: cursor.currentPageId, cursor: sortPointOf(cursor) } : null,
```

In `/api/frame` (line ~1089), likewise:

```ts
		sortedBy: cursor ? { userName: cursor.userName, cursor: sortPointOf(cursor) } : null,
```

(The `sortedBy.cursor` key name is kept — its meaning is "the point items were ranked by", and renaming would break `bin/canvas` consumers for zero gain.)

- [ ] **Step 4: Run all server tests and typecheck**

```bash
cd server && npx tsx src/canvas-api.test.ts && npx tsx src/scribe-api.test.ts && npx tsx src/participants-api.test.ts && npm run typecheck
```

Expected: all pass. (`participants-api.test.ts` exercises `buildParticipants` over `CursorRef`s — it must be unaffected by the added field.)

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/canvas-api.test.ts
git commit -m "feat(canvas-api): proximity reads sort by the presence stamp point

Falls back to the raw cursor for stampless presence — point selection, not
geometry. sortedBy reports the point actually used."
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Repo-wide checks**

```bash
npm run typecheck && npm run build
```

Expected: clean (all three workspaces).

- [ ] **Step 2: Full unit sweep**

```bash
cd client && npx tsx src/presence/stamp.test.ts && npx tsx src/av/spatial.test.ts
cd ../server && for t in src/*.test.ts; do npx tsx "$t" || exit 1; done
```

Expected: every script prints `all tests passed` (skip none; `vm-stats.test.ts` etc. guard against collateral damage).

- [ ] **Step 3: Live-stack check (spec "verification pass")**

Boot the dev stack and confirm a real browser publishes the stamp end-to-end:

```bash
npm run dev   # then, once client + server are up, in another canvas terminal:
curl -s -X POST localhost:8080/api/transcript \
  -H 'content-type: application/json' \
  -d '{"room":"team","identity":"<your-userId>","name":"check","text":"stamp check"}' | jq .entry
```

With a browser tab open on the room and your viewport over a named frame, `entry.cursor` and `entry.frame` must be non-null and name that frame. (Find `<your-userId>` via `GET /api/participants?room=team`.) The `debugging-roadmap-control` skill's headless-browser recipe is the fallback if no interactive browser is handy.

- [ ] **Step 4: Done — hand back**

Implementation complete. Use superpowers:finishing-a-development-branch if a branch/PR flow was used; house style is commits directly on `main` (already done per-task), so the remaining decision is when to cut a release (`deploy/release.sh patch`).
