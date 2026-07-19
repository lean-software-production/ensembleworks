# Panel Video Mosaic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the side panel's per-page vertical tile stack with a page-grouped video mosaic whose tile size derives from panel width and headcount — everyone on your page always visible, no slider, no scrolling within a group.

**Architecture:** Two new pure modules (`mosaicLayout.ts` sizing math, `mosaicOrder.ts` ordering/recency/settle) carry all testable logic, following the repo's bare-bun-test pattern (no `tldraw`/`livekit-client` runtime imports). `PanelPages.tsx` rewires each page section: the current page renders a CSS grid of `PanelTile`s at a computed width with FLIP-animated proximity re-ordering; other pages render fixed 22px `MosaicChip`s ordered by most-recently-spoke. `PanelTile` gains a `tileWidth` prop replacing its flex-basis sizing. Bandwidth needs no work: `useLiveKitRoom` already sets `adaptiveStream: true`, so LiveKit downgrades simulcast layers to match small tile elements automatically.

**Tech Stack:** React 18, tldraw signals (`useValue`, `react`), LiveKit (existing), bare `bun` test scripts with `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-07-19-panel-video-mosaic-design.md`

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `client/src/chrome/mosaicLayout.ts` | create | Pure sizing math: columns from N, tile width from panel width, size constants |
| `client/src/chrome/mosaicLayout.test.ts` | create | Bare-bun tests for sizing math |
| `client/src/chrome/mosaicOrder.ts` | create | Pure ordering: viewport-distance sort, spoke-recency tracking + sort, settle debounce |
| `client/src/chrome/mosaicOrder.test.ts` | create | Bare-bun tests for ordering + settle |
| `client/src/chrome/PanelTile.tsx` | modify | `tileWidth` prop (fixed-width sizing, overlay/strip thresholds); new `MosaicChip` export |
| `client/src/chrome/PanelPages.tsx` | modify | Mosaic grid for current page (ordered, FLIP-animated), chips for other pages; drop `TWO_UP_MIN_WIDTH` |
| `client/src/chrome/SidePanel.tsx` | modify | Stop passing `twoUp`-related width logic if referenced (check only) |

Both new `.ts` modules MUST NOT import `tldraw` or runtime `livekit-client` (see `panelLayout.ts` header comment — bare-bun test scripts hang on the tldraw module graph). Test files are auto-discovered by `scripts/run-tests.ts` (`**/src/**/*.test.ts` glob) — no registration step.

---

### Task 1: Sizing math (`mosaicLayout.ts`)

**Files:**
- Create: `client/src/chrome/mosaicLayout.ts`
- Test: `client/src/chrome/mosaicLayout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/chrome/mosaicLayout.test.ts`:

```ts
/**
 * Mosaic sizing math: columns from headcount, tile width from panel content
 * width. Run: bun client/src/chrome/mosaicLayout.test.ts
 */
import assert from 'node:assert/strict'
import {
	CHIP_SIZE,
	LABEL_MIN_WIDTH,
	MOSAIC_GAP,
	TILE_WIDTH_MIN,
	TILE_WIDTH_MAX,
	mosaicColumns,
	mosaicTileWidth,
} from './mosaicLayout'

// --- mosaicColumns: ceil(sqrt(N)), square-ish grid ---
assert.equal(mosaicColumns(1), 1)
assert.equal(mosaicColumns(2), 2)
assert.equal(mosaicColumns(4), 2)
assert.equal(mosaicColumns(5), 3)
assert.equal(mosaicColumns(9), 3)
assert.equal(mosaicColumns(14), 4) // spec's worked example
assert.equal(mosaicColumns(16), 4)
assert.equal(mosaicColumns(25), 5)
// Degenerate inputs clamp to 1 column rather than NaN/0.
assert.equal(mosaicColumns(0), 1)
assert.equal(mosaicColumns(-3), 1)

// --- mosaicTileWidth: fill content width minus gaps, clamped ---
// Spec worked example: 14 people, 280px panel → 4 cols. Content width for a
// 280px panel is ~256 (SidePanel padding); (256 - 3*6)/4 = 59.5 → 59.
assert.equal(mosaicTileWidth(256, 14), 59)
// Wider panel, same crowd: (536 - 18)/4 = 129.5 → 129.
assert.equal(mosaicTileWidth(536, 14), 129)
// Legibility floor: 25 people in a 180px-wide panel (content ~156):
// (156 - 4*6)/5 = 26.4 → clamps up to TILE_WIDTH_MIN.
assert.equal(mosaicTileWidth(156, 25), TILE_WIDTH_MIN)
// Sane max: one person in a huge panel caps at TILE_WIDTH_MAX.
assert.equal(mosaicTileWidth(1200, 1), TILE_WIDTH_MAX)
// Zero participants: still a finite, floored value (callers skip render at 0).
assert.equal(mosaicTileWidth(256, 0), TILE_WIDTH_MAX)

// --- constants sanity (spec values) ---
assert.equal(TILE_WIDTH_MIN, 36)
assert.equal(LABEL_MIN_WIDTH, 64)
assert.equal(CHIP_SIZE, 22)
assert.equal(MOSAIC_GAP, 6)
assert.ok(TILE_WIDTH_MAX >= 320)

console.log('mosaicLayout tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Work/ensembleworks && bun client/src/chrome/mosaicLayout.test.ts`
Expected: FAIL — `Cannot find module './mosaicLayout'`

- [ ] **Step 3: Write the implementation**

Create `client/src/chrome/mosaicLayout.ts`:

```ts
/**
 * Mosaic sizing math (panel-video-mosaic spec "Sizing rules"): the current
 * page's participant grid is square-ish — columns = ceil(√N) — and tile
 * width derives from the panel's content width, so dragging the panel edge
 * is the ONE size control. No slider, nothing new persisted.
 *
 * MUST NOT import 'tldraw' — bare-bun test scripts import this module
 * (see panelLayout.ts's header comment for why that matters).
 */

/** Gap between mosaic tiles/chips, px (matches PanelPages' tile-list gap). */
export const MOSAIC_GAP = 6

/** Legibility floor for a current-page tile's width, px (spec: ~36px). */
export const TILE_WIDTH_MIN = 36

/**
 * Cap for a current-page tile's width, px — a lone participant in a dragged-
 * wide panel tops out here instead of ballooning (spec "N = 1" edge case).
 * Matches PanelTile's previous TILE_MAX_WIDTH so the biggest tile looks the
 * same as before the mosaic.
 */
export const TILE_WIDTH_MAX = 320

/** Width at/above which a tile shows its name/control strip and overlays. */
export const LABEL_MIN_WIDTH = 64

/** Fixed size of an other-page ambient chip, px (spec: ~22px chips). */
export const CHIP_SIZE = 22

/** Square-ish grid: columns = ceil(√N), min 1. */
export function mosaicColumns(count: number): number {
	if (!Number.isFinite(count) || count < 1) return 1
	return Math.ceil(Math.sqrt(count))
}

/**
 * Tile width for the current page's grid: fill the content width minus
 * inter-tile gaps, clamped to [TILE_WIDTH_MIN, TILE_WIDTH_MAX]. The floor can
 * exceed what fits — the grid then wraps to more rows (CSS handles it); it
 * never scrolls horizontally and never hides anyone (spec invariant).
 */
export function mosaicTileWidth(contentWidth: number, count: number): number {
	const cols = mosaicColumns(count)
	const raw = Math.floor((contentWidth - MOSAIC_GAP * (cols - 1)) / cols)
	return Math.min(TILE_WIDTH_MAX, Math.max(TILE_WIDTH_MIN, raw))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Work/ensembleworks && bun client/src/chrome/mosaicLayout.test.ts`
Expected: `mosaicLayout tests passed`

- [ ] **Step 5: Commit**

```bash
cd ~/Work/ensembleworks
git add client/src/chrome/mosaicLayout.ts client/src/chrome/mosaicLayout.test.ts
git commit -m "feat(panel): mosaic sizing math — columns from headcount, tile width from panel width"
```

---

### Task 2: Ordering + recency + settle (`mosaicOrder.ts`)

**Files:**
- Create: `client/src/chrome/mosaicOrder.ts`
- Test: `client/src/chrome/mosaicOrder.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/chrome/mosaicOrder.test.ts`:

```ts
/**
 * Mosaic ordering: viewport-distance sort (missing cursors last, stable),
 * spoke-recency tracking + sort, and the viewport settle debounce.
 * Run: bun client/src/chrome/mosaicOrder.test.ts
 */
import assert from 'node:assert/strict'
import {
	VIEWPORT_SETTLE_MS,
	createSettler,
	orderByRecency,
	orderByViewportDistance,
	updateSpokeRecency,
} from './mosaicOrder'

// --- orderByViewportDistance ---
{
	const ids = ['a', 'b', 'c', 'd']
	const cursors = {
		a: { x: 100, y: 100 }, // dist 100√2 from centre
		b: { x: 10, y: 0 },    // dist 10 — closest
		c: { x: 0, y: 50 },    // dist 50
		// d: no cursor (never moved) — sorts last
	}
	const centre = { x: 0, y: 0 }
	assert.deepEqual(orderByViewportDistance(ids, cursors, centre), ['b', 'c', 'a', 'd'])
}
{
	// Stability: equal distances keep input order (join order).
	const ids = ['x', 'y', 'z']
	const cursors = { x: { x: 5, y: 0 }, y: { x: 0, y: 5 }, z: { x: 3, y: 4 } } // all dist 5
	assert.deepEqual(orderByViewportDistance(ids, cursors, { x: 0, y: 0 }), ['x', 'y', 'z'])
}
{
	// All cursors missing: input order preserved.
	assert.deepEqual(orderByViewportDistance(['p', 'q'], {}, { x: 0, y: 0 }), ['p', 'q'])
}

// --- updateSpokeRecency ---
{
	const r1 = updateSpokeRecency({}, ['a'], 1000)
	assert.deepEqual(r1, { a: 1000 })
	// No speakers, nothing stale to write → same reference back (no churn).
	const r2 = updateSpokeRecency(r1, [], 2000)
	assert.equal(r2, r1)
	// New speaker joins the record; old entry kept.
	const r3 = updateSpokeRecency(r2, ['b'], 3000)
	assert.deepEqual(r3, { a: 1000, b: 3000 })
	// Same speaker again at same timestamp → same reference (dedupe).
	assert.equal(updateSpokeRecency(r3, ['b'], 3000), r3)
}

// --- orderByRecency ---
{
	const recency = { a: 1000, c: 5000 } // b never spoke
	// c spoke most recently → first; never-spoke keeps input order, last.
	assert.deepEqual(orderByRecency(['a', 'b', 'c'], recency), ['c', 'a', 'b'])
	// Nobody spoke: input (join) order.
	assert.deepEqual(orderByRecency(['a', 'b'], {}), ['a', 'b'])
}

// --- createSettler: debounce with injectable scheduler ---
{
	assert.equal(VIEWPORT_SETTLE_MS, 1000)
	let pending: { fn: () => void; ms: number } | null = null
	let cancelled = 0
	const schedule = (fn: () => void, ms: number) => {
		pending = { fn, ms }
		return 7 as unknown as ReturnType<typeof setTimeout>
	}
	const cancel = () => {
		cancelled++
		pending = null
	}
	const settled: number[] = []
	const settler = createSettler<number>(1000, (v) => settled.push(v), schedule, cancel)

	settler.feed(1)
	assert.equal(pending!.ms, 1000)
	settler.feed(2) // re-feed before fire: cancels + reschedules, latest wins
	assert.equal(cancelled, 1)
	pending!.fn() // timer fires
	assert.deepEqual(settled, [2])

	settler.feed(3)
	settler.dispose() // dispose cancels the pending timer
	assert.equal(cancelled, 2)
	assert.deepEqual(settled, [2]) // nothing more fires
}

console.log('mosaicOrder tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Work/ensembleworks && bun client/src/chrome/mosaicOrder.test.ts`
Expected: FAIL — `Cannot find module './mosaicOrder'`

- [ ] **Step 3: Write the implementation**

Create `client/src/chrome/mosaicOrder.ts`:

```ts
/**
 * Mosaic ordering (panel-video-mosaic spec "Ordering rules"):
 *
 * - Current page: tiles sort by cursor distance from YOUR viewport centre,
 *   closest first. Missing cursors (collaborator never moved) sort last,
 *   stable by input (join) order.
 * - Other pages: proximity is meaningless cross-page, so chips sort by
 *   most-recently-spoke, then join order.
 * - Re-sorts happen only after the viewport has been still for
 *   VIEWPORT_SETTLE_MS (settle-after-pause) — createSettler is the debounce,
 *   with an injectable scheduler so bare-bun tests need no fake timers.
 *
 * MUST NOT import 'tldraw' — bare-bun test scripts import this module.
 */

export interface MosaicPoint {
	x: number
	y: number
}

/** How long the viewport must hold still before a proximity re-sort. */
export const VIEWPORT_SETTLE_MS = 1000

/**
 * Sort ids by their cursor's distance from `centre`, closest first. Ids with
 * no cursor sort last. Stable (Array.prototype.sort is stable): ties and
 * missing-cursor runs keep input order.
 */
export function orderByViewportDistance(
	ids: readonly string[],
	cursors: Record<string, MosaicPoint | undefined>,
	centre: MosaicPoint
): string[] {
	const dist = (id: string): number => {
		const c = cursors[id]
		if (!c) return Infinity
		return Math.hypot(c.x - centre.x, c.y - centre.y)
	}
	return [...ids].sort((a, b) => dist(a) - dist(b))
}

/**
 * Fold the currently-speaking set into a lastSpokeAt record. Returns the
 * SAME reference when nothing changed, so React effects keyed on the record
 * don't churn (the AV snapshot republishes often).
 */
export function updateSpokeRecency(
	prev: Record<string, number>,
	speakingIds: readonly string[],
	now: number
): Record<string, number> {
	let changed = false
	for (const id of speakingIds) {
		if (prev[id] !== now) {
			changed = true
			break
		}
	}
	if (!changed) return prev
	const next = { ...prev }
	for (const id of speakingIds) next[id] = now
	return next
}

/**
 * Sort ids by lastSpokeAt descending (most recent first). Ids that never
 * spoke sort last, stable by input (join) order.
 */
export function orderByRecency(
	ids: readonly string[],
	recency: Record<string, number>
): string[] {
	const at = (id: string): number => recency[id] ?? -Infinity
	return [...ids].sort((a, b) => at(b) - at(a))
}

export interface Settler<T> {
	/** Feed the latest value; (re)starts the settle countdown. */
	feed(value: T): void
	/** Cancel any pending settle. */
	dispose(): void
}

/**
 * Debounce: `onSettle(latest)` fires once the feed has been quiet for
 * `delayMs`. Scheduler injectable for tests; defaults to real timers.
 */
export function createSettler<T>(
	delayMs: number,
	onSettle: (value: T) => void,
	schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
	cancel: (t: ReturnType<typeof setTimeout>) => void = clearTimeout
): Settler<T> {
	let timer: ReturnType<typeof setTimeout> | null = null
	let latest: T
	return {
		feed(value: T) {
			latest = value
			if (timer !== null) cancel(timer)
			timer = schedule(() => {
				timer = null
				onSettle(latest)
			}, delayMs)
		},
		dispose() {
			if (timer !== null) cancel(timer)
			timer = null
		},
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Work/ensembleworks && bun client/src/chrome/mosaicOrder.test.ts`
Expected: `mosaicOrder tests passed`

- [ ] **Step 5: Run the full suite (regression gate)**

Run: `cd ~/Work/ensembleworks && bun run test`
Expected: `all N suites passed` (N grows by 2 — the new mosaic suites are auto-discovered)

- [ ] **Step 6: Commit**

```bash
cd ~/Work/ensembleworks
git add client/src/chrome/mosaicOrder.ts client/src/chrome/mosaicOrder.test.ts
git commit -m "feat(panel): mosaic ordering — viewport-distance sort, spoke recency, settle debounce"
```

---

### Task 3: `PanelTile` width prop + `MosaicChip`

**Files:**
- Modify: `client/src/chrome/PanelTile.tsx`

No bare-bun test (component; DOM-less test harness can't render it) — verification is typecheck + Task 5's manual smoke. Keep changes minimal and mechanical.

- [ ] **Step 1: Add the `tileWidth` prop and threshold gating**

In `client/src/chrome/PanelTile.tsx`:

1. Import the layout constant at the top (alongside existing imports):

```ts
import { LABEL_MIN_WIDTH } from './mosaicLayout'
```

2. Extend the props of `PanelTile` — replace the `twoUp` prop with `tileWidth`:

```ts
export function PanelTile({
	editor,
	participant,
	snap,
	tileWidth,
}: {
	editor: Editor
	participant: PanelTileParticipant
	snap: AvPanelSnapshot | null
	// Fixed tile width (px) computed by PanelPages' mosaic sizing. When set,
	// the tile renders at exactly this width (grid cell); when undefined the
	// legacy flex-basis flow sizing applies (unknown-page section only).
	tileWidth?: number
}) {
```

3. Inside the component, derive the gates (place right after the destructure of `participant`):

```ts
	// Small mosaic tiles shed their chrome: below LABEL_MIN_WIDTH the name/
	// control strip and the media overlays (latency pill, cam glyph, quiet
	// badge, volume readout) don't fit legibly. The LOCAL tile keeps its strip
	// at every size — mic/cam/crosstalk must stay reachable.
	const compact = tileWidth !== undefined && tileWidth < LABEL_MIN_WIDTH
	const showStrip = isLocal || !compact
	const showOverlays = !compact
```

4. Replace the fixed `initialsFontSize` line:

```ts
	const initialsFontSize =
		tileWidth !== undefined
			? Math.max(12, Math.min(40, Math.round(tileWidth * 0.32)))
			: INITIALS_FONT_DEFAULT
```

Delete the `INITIALS_FONT_TWO_UP` constant and the old `twoUp`-based expression.

5. In the root `<div>` style, replace the flex sizing:

```ts
				style={{
					...(tileWidth !== undefined
						? { width: tileWidth, flex: '0 0 auto' }
						: { flex: `1 1 ${TILE_BASIS_WIDTH}px`, maxWidth: TILE_MAX_WIDTH }),
					display: 'flex',
					// …rest unchanged
```

Also shrink the identity border on compact tiles — change `borderLeft`:

```ts
					borderLeft: `${compact ? 2 : 4}px solid ${color}`,
```

6. Gate the media-area overlays. Wrap the latency-pill `<div>`, the remote cam-status `<span>`, the `quiet` badge, and the hover `vol %` readout each in `showOverlays && (…)`. Example for the latency pill:

```tsx
				{showOverlays && (
					<div style={{ position: 'absolute', top: 4, right: 4, /* …unchanged */ }}>
						<LatencyPill latency={latency} history={latencyHistory} />
					</div>
				)}
```

(The existing `{!isLocal && …}` guards become `{showOverlays && !isLocal && …}`.)

7. Gate the control strip: wrap the entire strip `<div>` (the one with `padding: '5px 6px'`) in `{showStrip && (…)}`. Inside it, hide the name text when the tile is compact-but-local (icons only):

```tsx
					{!compact && (
						<span style={{ /* existing name-span style, unchanged */ }}>
							{name}
							{isLocal ? ' (you)' : ''}
						</span>
					)}
```

- [ ] **Step 2: Add `MosaicChip`**

Append to `client/src/chrome/PanelTile.tsx` (new export, below `PanelTile`):

```tsx
// Ambient chip for OTHER pages' participants (panel-video-mosaic spec
// "Sizing rules"): a fixed CHIP_SIZE square — identity-tinted, speaking ring,
// name tooltip, click-to-zoom — pinned at minimum regardless of panel width,
// so widening the panel enlarges YOUR room's faces, not a wall of everyone.
// No video element at this size: LiveKit's adaptiveStream would still deliver
// frames for a 22px element, and a moving thumbnail this small is noise.
export function MosaicChip({
	editor,
	participant,
	snap,
}: {
	editor: Editor
	participant: PanelTileParticipant
	snap: AvPanelSnapshot | null
}) {
	const { rawId, prefixedId, name, color, isLocal } = participant
	const peer = !isLocal ? (snap?.peers.find((p) => p.id === rawId) ?? null) : null
	const isSpeaking = isLocal ? (snap?.localSpeaking ?? false) : (peer?.isSpeaking ?? false)
	return (
		<button
			type="button"
			data-testid={'ew-chip-' + rawId}
			title={name + (isLocal ? ' (you)' : '')}
			aria-label={`${name}${isSpeaking ? ' (speaking)' : ''} — jump to their view`}
			onClick={() => {
				if (!isLocal) editor.zoomToUser(prefixedId)
			}}
			style={{
				width: CHIP_SIZE,
				height: CHIP_SIZE,
				flex: '0 0 auto',
				padding: 0,
				border: 0,
				borderRadius: 3,
				background: `${color}55`,
				boxShadow: `inset 0 0 0 1.5px ${color}`,
				outline: isSpeaking ? `2px solid ${wm.sealBlue}` : 'none',
				outlineOffset: 1,
				cursor: isLocal ? 'default' : 'pointer',
				display: 'grid',
				placeItems: 'center',
				fontFamily: wm.sans,
				fontSize: 9,
				fontWeight: 700,
				color: wm.ink,
			}}
		>
			{initialsFor(name)}
		</button>
	)
}
```

Add `CHIP_SIZE` to the `./mosaicLayout` import in step 1's import line.

- [ ] **Step 3: Typecheck**

Run: `cd ~/Work/ensembleworks && bun run --filter '@ensembleworks/client' typecheck`
Expected: FAILS in `PanelPages.tsx` (still passes `twoUp`) — that's the next task's cutover; `PanelTile.tsx` itself must contribute no errors. If other files reference `twoUp`, list them for Task 4.

- [ ] **Step 4: Commit**

```bash
cd ~/Work/ensembleworks
git add client/src/chrome/PanelTile.tsx
git commit -m "feat(panel): PanelTile tileWidth prop + MosaicChip for other-page ambience"
```

---

### Task 4: `PanelPages` mosaic cutover

**Files:**
- Modify: `client/src/chrome/PanelPages.tsx`

- [ ] **Step 1: Rewire imports and roster derivation**

In `client/src/chrome/PanelPages.tsx`:

1. Update imports:

```ts
import { rawUserId } from '@ensembleworks/contracts'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { getIndexBetween, react, type Editor, type IndexKey, type TLPageId, useValue } from 'tldraw'
import { useAvSnapshot } from '../av/bridge'
import { wm } from '../theme'
import { exitFocus } from './focus'
import { peekCloseSoon, peekOpen, togglePinned, useFramesDrawer } from './framesDrawerLayout'
import { MOSAIC_GAP, mosaicTileWidth } from './mosaicLayout'
import {
	VIEWPORT_SETTLE_MS,
	createSettler,
	orderByRecency,
	orderByViewportDistance,
	updateSpokeRecency,
	type MosaicPoint,
} from './mosaicOrder'
import { MosaicChip, PanelTile, type PanelTileParticipant } from './PanelTile'
```

2. Delete `export const TWO_UP_MIN_WIDTH = 480` and its comment block. Delete the `const twoUp = width >= TWO_UP_MIN_WIDTH` line.

3. Leave the `panel-page-sections` `useValue` block's roster derivation as-is — cursor positions are read by `CurrentPageMosaic`'s own `useValue` (step 3), not here, so panning doesn't re-derive the whole roster.

- [ ] **Step 2: Add the settled-centre hook and spoke-recency hook**

Add near the top of the file (module level, below imports):

```tsx
// The proximity sort keys off a SETTLED viewport centre (spec "settle-after-
// pause"): re-sorting live while panning would shuffle faces mid-gesture —
// the very confusion the mosaic exists to avoid. tldraw's `react` tracks the
// camera signal; the settler (mosaicOrder.ts) holds the value until the
// viewport has been still for VIEWPORT_SETTLE_MS.
function useSettledViewportCentre(editor: Editor): MosaicPoint {
	const [centre, setCentre] = useState<MosaicPoint>(() => {
		const c = editor.getViewportPageBounds().center
		return { x: c.x, y: c.y }
	})
	useEffect(() => {
		const settler = createSettler<MosaicPoint>(VIEWPORT_SETTLE_MS, setCentre)
		const stop = react('mosaic-viewport-settle', () => {
			const c = editor.getViewportPageBounds().center
			settler.feed({ x: c.x, y: c.y })
		})
		return () => {
			stop()
			settler.dispose()
		}
	}, [editor])
	return centre
}

// lastSpokeAt per raw user id, folded from the AV snapshot's speaking flags.
// Drives other-page chip order (spec: "most-recently-spoke, then join order").
function useSpokeRecency(snap: ReturnType<typeof useAvSnapshot>): Record<string, number> {
	const [recency, setRecency] = useState<Record<string, number>>({})
	useEffect(() => {
		if (!snap) return
		const speaking = snap.peers.filter((p) => p.isSpeaking).map((p) => p.id)
		setRecency((prev) => updateSpokeRecency(prev, speaking, Date.now()))
	}, [snap])
	return recency
}
```

- [ ] **Step 3: Replace the tile list with the mosaic grid**

1. In `PanelPages`, call the hooks and thread props down:

```tsx
	const settledCentre = useSettledViewportCentre(editor)
	const recency = useSpokeRecency(snap)
```

Pass `width`, `settledCentre`, and `recency` to `PageSectionView` (add them to its props); pass `recency` to `UnknownPageSection`. Remove every `twoUp` prop.

2. Replace `tileListStyle()` and both of its call sites. New shared pieces:

```tsx
// Other pages' participants render as a wrap row of fixed-size ambient chips
// — pinned at minimum regardless of panel width (spec "Sizing rules").
function chipRowStyle(): CSSProperties {
	return { display: 'flex', flexWrap: 'wrap', gap: MOSAIC_GAP, marginTop: 6 }
}
```

3. Rewrite `PageSectionView`'s body. The current page gets the mosaic grid; other pages get chips:

```tsx
function PageSectionView({
	editor,
	section,
	isCurrent,
	isOnlyPage,
	onMoveUp,
	onMoveDown,
	snap,
	width,
	settledCentre,
	recency,
}: {
	editor: Editor
	section: PageSectionData
	isCurrent: boolean
	isOnlyPage: boolean
	onMoveUp?: () => void
	onMoveDown?: () => void
	snap: ReturnType<typeof useAvSnapshot>
	width: number
	settledCentre: MosaicPoint
	recency: Record<string, number>
}) {
	return (
		<div>
			<SectionHeader
				editor={editor}
				section={section}
				isCurrent={isCurrent}
				isOnlyPage={isOnlyPage}
				onMoveUp={onMoveUp}
				onMoveDown={onMoveDown}
			/>
			{section.participants.length > 0 &&
				(isCurrent ? (
					<CurrentPageMosaic
						editor={editor}
						participants={section.participants}
						snap={snap}
						width={width}
						settledCentre={settledCentre}
					/>
				) : (
					<div style={chipRowStyle()}>
						{orderParticipants(section.participants, (ids) => orderByRecency(ids, recency)).map(
							(participant) => (
								<MosaicChip key={participant.rawId} editor={editor} participant={participant} snap={snap} />
							)
						)}
					</div>
				))}
		</div>
	)
}
```

4. Add the ordering helper and the mosaic grid component (module level):

```tsx
// Apply an id-order function to a participant list (comparators in
// mosaicOrder.ts work on raw ids so they stay tldraw-free and bun-testable).
function orderParticipants(
	participants: PanelTileParticipant[],
	orderIds: (ids: string[]) => string[]
): PanelTileParticipant[] {
	const byId = new Map(participants.map((p) => [p.rawId, p]))
	return orderIds(participants.map((p) => p.rawId)).map((id) => byId.get(id)!)
}

// Cheap FLIP: after a re-order, each moved tile animates from its previous
// screen position to its new one, so eyes can track who went where (spec
// "animated tile position transitions"). Skipped under reduced motion.
const REDUCED_MOTION =
	typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function CurrentPageMosaic({
	editor,
	participants,
	snap,
	width,
	settledCentre,
}: {
	editor: Editor
	participants: PanelTileParticipant[]
	snap: ReturnType<typeof useAvSnapshot>
	width: number
	settledCentre: MosaicPoint
}) {
	// Cursor map comes with the participants from PanelPages' useValue read.
	const cursors = useValue(
		'mosaic-cursors',
		() => {
			const map: Record<string, MosaicPoint | undefined> = {}
			const selfPoint = editor.inputs.currentPagePoint
			map[rawUserId(editor.user.getId())] = { x: selfPoint.x, y: selfPoint.y }
			for (const presence of editor.getCollaborators()) {
				if (presence.cursor) {
					map[rawUserId(presence.userId)] = { x: presence.cursor.x, y: presence.cursor.y }
				}
			}
			return map
		},
		[editor]
	)

	const tileWidth = mosaicTileWidth(width - PANEL_CONTENT_INSET, participants.length)
	const ordered = orderParticipants(participants, (ids) =>
		orderByViewportDistance(ids, cursors, settledCentre)
	)

	// FLIP bookkeeping: previous rects by rawId, measured after every render.
	const gridRef = useRef<HTMLDivElement>(null)
	const prevRects = useRef<Map<string, DOMRect>>(new Map())
	useLayoutEffect(() => {
		const grid = gridRef.current
		if (!grid) return
		const next = new Map<string, DOMRect>()
		for (const el of Array.from(grid.children)) {
			if (!(el instanceof HTMLElement) || !el.dataset.mosaicId) continue
			const rect = el.getBoundingClientRect()
			next.set(el.dataset.mosaicId, rect)
			const prev = prevRects.current.get(el.dataset.mosaicId)
			if (prev && !REDUCED_MOTION) {
				const dx = prev.left - rect.left
				const dy = prev.top - rect.top
				if (dx !== 0 || dy !== 0) {
					el.animate(
						[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
						{ duration: 250, easing: 'ease-out' }
					)
				}
			}
		}
		prevRects.current = next
	})

	return (
		<div
			ref={gridRef}
			data-testid="ew-mosaic-grid"
			style={{ display: 'flex', flexWrap: 'wrap', gap: MOSAIC_GAP, marginTop: 6 }}
		>
			{ordered.map((participant) => (
				<div key={participant.rawId} data-mosaic-id={participant.rawId} style={{ display: 'flex' }}>
					<PanelTile editor={editor} participant={participant} snap={snap} tileWidth={tileWidth} />
				</div>
			))}
		</div>
	)
}

// Horizontal padding SidePanel puts around PanelPages' content — the sizing
// math needs the CONTENT width, not the stored panel width. Check SidePanel's
// actual padding when wiring this (12px each side at time of planning).
const PANEL_CONTENT_INSET = 24
```

> **Note for the implementer:** verify `PANEL_CONTENT_INSET` against SidePanel.tsx's real padding around the `PanelPages` container (open the file and read the style on the scroll container). If it's not 12px per side, set the constant to the real total and say so in the commit message. A flex-wrap row (not CSS `grid`) is deliberate: with the width clamped at `TILE_WIDTH_MIN`, wrap produces the extra rows the spec requires instead of overflowing.

5. Update `UnknownPageSection` the same way as other pages — replace its `tileListStyle()` list of `PanelTile`s with a `chipRowStyle()` row of `MosaicChip`s ordered by `orderByRecency`, and drop its `twoUp` prop.

6. FLIP + join/leave: no special code — joins/leaves re-render immediately (participants array changes), and the settle debounce only gates *centre* updates, which matches the spec's "join/leave bypasses debounce".

- [ ] **Step 4: Typecheck**

Run: `cd ~/Work/ensembleworks && bun run --filter '@ensembleworks/client' typecheck`
Expected: PASS, zero errors. If `SidePanel.tsx` or others still reference `TWO_UP_MIN_WIDTH`/`twoUp`, fix those call sites (delete the prop) and re-run.

- [ ] **Step 5: Full test suite**

Run: `cd ~/Work/ensembleworks && bun run test`
Expected: `all N suites passed`

- [ ] **Step 6: Commit**

```bash
cd ~/Work/ensembleworks
git add client/src/chrome/PanelPages.tsx client/src/chrome/SidePanel.tsx
git commit -m "feat(panel): page-grouped video mosaic — width-linked tiles, proximity order, ambient chips"
```

---

### Task 5: Manual smoke + spec cross-check

**Files:** none (verification)

- [ ] **Step 1: Run the dev stack**

Run: `cd ~/Work/ensembleworks && bun run dev`
Open the client (Vite prints the URL), join a room in two browser profiles.

- [ ] **Step 2: Verify against the spec, point by point**

- Current page section shows a grid of tiles; second participant appears in it.
- Drag the panel wider → tiles grow smoothly; narrower → shrink, never below 36px, nobody disappears, no horizontal scroll.
- Move profile B's cursor near/far from profile A's viewport centre; hold still ≥1s → A's grid re-orders with a visible slide animation. No re-order while actively panning.
- Switch profile B to another page → B becomes a 22px chip under that page's header; speaking ring appears on the chip when B talks; clicking the chip zooms to B.
- Local tile keeps mic/cam/crosstalk buttons at every panel width (compact tiles: icons without name).
- Speaking ring (existing seal-blue outline) shows on current-page tiles.

- [ ] **Step 3: Fix anything that fails, re-run affected checks, commit fixes**

```bash
cd ~/Work/ensembleworks
git add -A client/src
git commit -m "fix(panel): mosaic smoke-test fixes"
```

(Skip the commit if nothing needed fixing.)

---

## Deliberately NOT in this plan (YAGNI, per spec)

- **Bandwidth work** — `useLiveKitRoom` already constructs `new Room({ adaptiveStream: true, dynacast: true })`: delivered simulcast layer follows the attached `<video>` element's size, so small tiles are automatically cheap. Chips render no video element at all. Nothing to add.
- **25-participant e2e** — the spec lists it as a smoke; the existing e2e harness has no multi-peer fixture today. Manual two-profile smoke (Task 5) covers the mechanics; a fixture is its own project.
- Hero tiles, sliders, per-group controls, on-canvas video, spatial-audio changes (spec "Out of scope").
