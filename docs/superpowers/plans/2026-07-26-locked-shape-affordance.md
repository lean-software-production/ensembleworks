# Locked-shape affordance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a locked shape discoverable at the moment of confusion by showing a padlock chip at the top-right of its bounds whenever it is hovered or selected.

**Architecture:** One tldraw-free pure decision module (`chrome/lockedShapes.ts`) decides *which* shape ids deserve a badge from three plain inputs (hovered id, selected ids, a lock-state predicate); one small React component (`chrome/LockedShapeBadge.tsx`) feeds it live editor state via `useValue`, maps each id's page bounds through `editor.pageToViewport`, and renders the chips. It mounts as a third sibling in the existing `InFrontOfTheCanvas` fragment in `ui.tsx`. The feature is dead without `selectLockedShapes: true` on the `<Tldraw>` `options` prop, so that config lands in the same task as the component.

**Tech Stack:** React 18, TypeScript, tldraw 5.1.0 (`useEditor`, `useValue`, `editor.getHoveredShapeId`, `editor.getSelectedShapeIds`, `editor.isShapeOrAncestorLocked`, `editor.getShapePageBounds`, `editor.pageToViewport`), Bun test runner (`bun scripts/run-tests.ts`), `node:assert/strict`.

**Source spec:** [`docs/superpowers/specs/2026-07-23-locked-shape-affordance-design.md`](../specs/2026-07-23-locked-shape-affordance-design.md) (PR #62).

## Global Constraints

- **tldraw stays at 5.1.0.** This feature must not depend on the 5.2 upgrade (spec §7). `selectLockedShapes` already exists in 5.1.0 (`@tldraw/editor/src/lib/options.ts:180,345`).
- **No server changes.** (spec §10)
- **v1 engine only.** Target is `client/src/App.tsx` (tldraw-v1). canvas-v2 gets a TODO marker only (spec §8).
- **The pure module (`client/src/chrome/lockedShapes.ts`) MUST NOT import `tldraw`** — every `*.test.ts` under `**/src/**` is spawned under bare `bun` by `scripts/run-tests.ts`, with no DOM and no bundler. This is the same rule stated at the top of `client/src/chrome/framesDrawerLayout.ts` and `panelLayout.ts`. Keep the module on plain `string` ids and an injected predicate.
- **The badge is informational only** — not clickable, no unlock control (spec §6). Every rendered chip carries `pointerEvents: 'none'`.
- **No badge cap** — every locked shape in the hovered/selected set gets a chip (spec §5).
- **Indentation is tabs** throughout `client/src`. Match the surrounding file.
- **Contract gate:** `scripts/ux-contract-presence.test.ts` fails any diff touching `canvas-editor/src/tools/`, `canvas-react/src/`, or `client/src/canvas-v2/` unless the PR body declares a contract or carries a `ux-contract: none — <reason>` line **with a reason** (a bare `ux-contract: none` is rejected — see that file's own test at line 130). Task 3 touches `client/src/canvas-v2/CanvasV2App.tsx`, so Task 3 also updates the PR body.
- **Prerequisite for any task:** this checkout has no `node_modules`. Run `bun install` once before Task 1.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `client/src/chrome/lockedShapes.ts` | create | Pure decision function. No tldraw, no React, no DOM. |
| `client/src/chrome/lockedShapes.test.ts` | create | `node:assert/strict` unit test for the above (spec §9). |
| `client/src/chrome/LockedShapeBadge.tsx` | create | The React badge: reads live editor state, positions and renders the chips. |
| `client/src/ui.tsx` | modify (`InFrontOfTheCanvas`, ~line 35-42) | Add `<LockedShapeBadge />` as a third sibling. |
| `client/src/App.tsx` | modify (`<Tldraw>` mount, ~line 235-244) | Add `options={{ selectLockedShapes: true }}`. |
| `client/src/canvas-v2/CanvasV2App.tsx` | modify (header comment) | `// TODO(canvas-v2 locked-shape-affordance)` parity marker (spec §8). |
| `docs/superpowers/specs/2026-07-23-locked-shape-affordance-design.md` | modify (line 3) | Flip Status from SPEC to IMPLEMENTED once smoke passes. |

---

### Task 1: The pure decision function

Decides which shape ids should show a badge, from plain inputs. Everything that needs tldraw is deliberately excluded so this runs under bare `bun`.

**Files:**
- Create: `client/src/chrome/lockedShapes.ts`
- Test: `client/src/chrome/lockedShapes.test.ts`

**Interfaces:**
- Consumes: nothing — this is the first task.
- Produces:
  - `interface BadgedShapesInput { hoveredShapeId: string | null; selectedShapeIds: readonly string[]; isLocked: (id: string) => boolean }`
  - `function badgedLockedShapeIds(input: BadgedShapesInput): string[]` — hovered id first (when it qualifies), then selected ids in their given order, no duplicates.

- [x] **Step 1: Write the failing test**

Create `client/src/chrome/lockedShapes.test.ts`:

```ts
/**
 * Run: bun client/src/chrome/lockedShapes.test.ts
 */
import assert from 'node:assert/strict'
import { badgedLockedShapeIds } from './lockedShapes'

// A lock lookup built from an explicit set — stands in for
// editor.isShapeOrAncestorLocked, which is what the component injects.
const lockedAmong =
	(...ids: string[]) =>
	(id: string) =>
		ids.includes(id)

// Hovered and locked → badged.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: 'shape:a',
		selectedShapeIds: [],
		isLocked: lockedAmong('shape:a'),
	}),
	['shape:a']
)

// Hovered but NOT locked → nothing. A locked shape at rest looks like any
// other shape; an unlocked one must never sprout a padlock.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: 'shape:a',
		selectedShapeIds: [],
		isLocked: lockedAmong(),
	}),
	[]
)

// Nothing hovered, nothing selected → nothing.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: null,
		selectedShapeIds: [],
		isLocked: lockedAmong('shape:a'),
	}),
	[]
)

// Selected and locked (not hovered) → badged. This is the trigger that keeps
// the badge up after a click moves the pointer away (spec §3).
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: null,
		selectedShapeIds: ['shape:a'],
		isLocked: lockedAmong('shape:a'),
	}),
	['shape:a']
)

// Mixed selection → only the locked members, selection order preserved.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: null,
		selectedShapeIds: ['shape:a', 'shape:b', 'shape:c'],
		isLocked: lockedAmong('shape:a', 'shape:c'),
	}),
	['shape:a', 'shape:c']
)

// No cap: every locked shape in a large selection badges (spec §5).
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: null,
		selectedShapeIds: ['s:0', 's:1', 's:2', 's:3', 's:4', 's:5', 's:6', 's:7', 's:8', 's:9'],
		isLocked: () => true,
	}),
	['s:0', 's:1', 's:2', 's:3', 's:4', 's:5', 's:6', 's:7', 's:8', 's:9']
)

// Hovered shape is ALSO selected → one badge, not two.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: 'shape:a',
		selectedShapeIds: ['shape:a', 'shape:b'],
		isLocked: lockedAmong('shape:a', 'shape:b'),
	}),
	['shape:a', 'shape:b']
)

// Ancestor-locked child: the caller's predicate reports the CHILD as locked
// (that is what editor.isShapeOrAncestorLocked does), so it badges even
// though nothing set isLocked on the child itself. A locked frame makes its
// children inert too — a live hypothesis during the incident (spec §5).
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: 'shape:child',
		selectedShapeIds: [],
		isLocked: lockedAmong('shape:child'),
	}),
	['shape:child']
)

// Hovered qualifies and comes first, ahead of the selection.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: 'shape:h',
		selectedShapeIds: ['shape:a'],
		isLocked: () => true,
	}),
	['shape:h', 'shape:a']
)

console.log('lockedShapes.test.ts: all assertions passed')
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun client/src/chrome/lockedShapes.test.ts`

Expected: FAIL — module resolution error, `Cannot find module './lockedShapes'`.

- [x] **Step 3: Write the minimal implementation**

Create `client/src/chrome/lockedShapes.ts`:

```ts
/**
 * Locked-shape badge decision (locked-shape affordance spec §5): given what is
 * hovered, what is selected, and a lock-state lookup, which shape ids should
 * show a padlock chip?
 *
 * MUST NOT import 'tldraw' — must stay importable under bare bun test scripts
 * (see framesDrawerLayout.ts's header for why that matters). Shape ids are
 * plain strings here and the lock lookup is injected; LockedShapeBadge.tsx
 * supplies editor.isShapeOrAncestorLocked, so an ancestor-locked child is
 * reported locked without this module knowing what a frame is.
 */

export interface BadgedShapesInput {
	/** editor.getHoveredShapeId() — null when nothing is hovered. */
	hoveredShapeId: string | null
	/** editor.getSelectedShapeIds(). */
	selectedShapeIds: readonly string[]
	/** True when the shape is locked, or sits inside a locked ancestor. */
	isLocked: (id: string) => boolean
}

/**
 * Hovered first (when it qualifies), then the selection in its own order, with
 * duplicates dropped — the hovered shape is very often also the selected one,
 * and two chips stacked at the same coordinates would render as one smudged
 * badge.
 *
 * No cap, deliberately: a truncated set lies about how many shapes are locked
 * (spec §5).
 */
export function badgedLockedShapeIds(input: BadgedShapesInput): string[] {
	const { hoveredShapeId, selectedShapeIds, isLocked } = input
	const out: string[] = []
	const seen = new Set<string>()
	const push = (id: string) => {
		if (seen.has(id)) return
		if (!isLocked(id)) return
		seen.add(id)
		out.push(id)
	}
	if (hoveredShapeId) push(hoveredShapeId)
	for (const id of selectedShapeIds) push(id)
	return out
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `bun client/src/chrome/lockedShapes.test.ts`

Expected: PASS — prints `lockedShapes.test.ts: all assertions passed`, exit 0.

- [x] **Step 5: Run the whole suite and the client typecheck**

Run: `bun run test`
Expected: every discovered test file passes, exit 0. `lockedShapes.test.ts` appears in the list.

Run: `bun run --filter '@ensembleworks/client' typecheck`
Expected: no errors.

- [x] **Step 6: Commit**

```bash
git add client/src/chrome/lockedShapes.ts client/src/chrome/lockedShapes.test.ts
git commit -m "feat(chrome): decide which locked shapes get a padlock badge

Pure, tldraw-free decision function behind the locked-shape affordance:
hovered id + selected ids + a lock predicate in, the ids that deserve a
chip out. Hovered first, selection order preserved, duplicates dropped,
no cap (a truncated set misreports how many shapes are locked).

The lock predicate is injected so the caller can pass
editor.isShapeOrAncestorLocked and get ancestor-locked children for free,
while this module stays importable under bare bun.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The badge component, its mount, and `selectLockedShapes`

The visible feature. The `selectLockedShapes: true` option belongs in this task and not a separate one: with the default (`false`) `getHoveredShapeId()` can never return a locked shape, so the component would render nothing and there would be nothing for a reviewer to accept.

**Files:**
- Create: `client/src/chrome/LockedShapeBadge.tsx`
- Modify: `client/src/ui.tsx` (the `InFrontOfTheCanvas` function, lines 35-42)
- Modify: `client/src/App.tsx` (the `<Tldraw>` element, lines 235-244)

**Interfaces:**
- Consumes: `badgedLockedShapeIds` and `BadgedShapesInput` from Task 1 (`./lockedShapes`).
- Produces: `function LockedShapeBadge(): JSX.Element | null` — a default-export-free named export mounted by `ui.tsx`. Nothing later depends on it.

**Coordinate space — read this before writing the component.** This component renders inside the editor's own container via the `InFrontOfTheCanvas` slot. That container is the positioning root for its `left`/`top`, **not** the window. `editor.pageToViewport(...)` already returns container-relative coordinates and needs no adjustment; `pageToScreen` / `getSelectionRotatedScreenBounds` are window-space and would double-count the container offset. This is spelled out in `client/src/chrome/FocusOverlay.tsx`'s "Fix 3 (coordinate space)" comments — follow the `focusedScreen` block there, not the `enterCandidate` one.

**Reactivity.** `useValue` only re-runs when a signal it read changes. Panning and zooming change neither the hovered id nor the selection, so the computation must call `editor.getCamera()` to subscribe to camera movement — exactly as `client/src/av/leashes.tsx:39` does (`editor.getCamera() // subscribe to pan / zoom`). Without it the chips freeze in place while the canvas moves underneath them.

- [x] **Step 1: Write the component**

Create `client/src/chrome/LockedShapeBadge.tsx`:

```tsx
/**
 * Locked-shape padlock chip (locked-shape affordance spec §3/§5): lives in the
 * InFrontOfTheCanvas slot alongside ContextualStylePanel and FocusOverlay (see
 * ui.tsx).
 *
 * A locked shape is otherwise completely indistinguishable from an unlocked one
 * and silently ignores every interaction — tldraw ships no locked-shape visual
 * at all. This chip appears just outside a shape's top-right corner while that
 * shape is hovered OR selected, and nowhere else: at rest the canvas looks
 * exactly as it did.
 *
 * Top-RIGHT, specifically, because the terminal shape pins its own title chip
 * top-left (TerminalShapeUtil.tsx:736-751, `left: 0; bottom: 100%`), so the two
 * can never collide.
 *
 * HARD PREREQUISITE: `selectLockedShapes: true` on the <Tldraw> options prop
 * (App.tsx). Hover hit-testing passes `hitLocked: editor.options
 * .selectLockedShapes` (tldraw's updateHoveredShapeId.ts) and the default is
 * false, so without it getHoveredShapeId() can never return a locked shape and
 * this component silently renders nothing forever.
 *
 * Informational only — never a control (spec §6). Right-click -> Unlock already
 * exists and is how the live incident was resolved; knowing the shape is locked
 * was the whole problem. Hence pointerEvents: 'none' on every chip.
 */
import type { CSSProperties } from 'react'
import { useEditor, useValue, type TLShapeId } from 'tldraw'
import { wm } from '../theme'
import { badgedLockedShapeIds } from './lockedShapes'

interface BadgePlacement {
	id: string
	/** Container-relative viewport coords of the shape's top-right corner. */
	x: number
	y: number
}

// Reuses the terminal title chip's visual language (mono, small, uppercase
// tracking) so the padlock reads as shape chrome rather than as canvas content.
const chipStyle: CSSProperties = {
	position: 'absolute',
	display: 'flex',
	alignItems: 'center',
	padding: '1px 5px',
	background: wm.bg,
	border: `1px solid ${wm.ruleStrong}`,
	borderRadius: 4,
	boxShadow: wm.shadowPaper,
	fontFamily: wm.mono,
	fontSize: 11,
	lineHeight: '16px',
	color: wm.ink,
	// Informational only (spec §6) — must never eat a canvas click.
	pointerEvents: 'none',
	// Same layer as FocusOverlay's own buttons: above the canvas, below the
	// side panel and rail.
	zIndex: 410,
}

export function LockedShapeBadge() {
	const editor = useEditor()

	const placements = useValue<BadgePlacement[]>(
		'locked shape badges',
		() => {
			// Subscribe to pan / zoom — neither the hovered id nor the selection
			// changes when the camera moves, so without this read the chips would
			// stay pinned to stale screen coordinates (same trick as
			// av/leashes.tsx:39).
			editor.getCamera()
			const ids = badgedLockedShapeIds({
				hoveredShapeId: editor.getHoveredShapeId(),
				selectedShapeIds: editor.getSelectedShapeIds(),
				isLocked: (id) => editor.isShapeOrAncestorLocked(id as TLShapeId),
			})
			const out: BadgePlacement[] = []
			for (const id of ids) {
				const bounds = editor.getShapePageBounds(id as TLShapeId)
				// Shape deleted between the id read and this lookup, or not on the
				// current page — skip rather than render a chip at (0,0).
				if (!bounds) continue
				// pageToViewport is already container-relative, which is the space
				// these left/top values are measured in (FocusOverlay.tsx "Fix 3").
				const topRight = editor.pageToViewport({ x: bounds.maxX, y: bounds.minY })
				out.push({ id, x: topRight.x, y: topRight.y })
			}
			return out
		},
		[editor]
	)

	if (placements.length === 0) return null

	return (
		<>
			{placements.map((p) => (
				<div
					key={p.id}
					// aria-label, not title: pointerEvents is 'none', so a title
					// tooltip could never be hovered into existence anyway.
					aria-label="Locked"
					style={{ ...chipStyle, left: p.x + 6, top: p.y }}
				>
					🔒
				</div>
			))}
		</>
	)
}
```

- [x] **Step 2: Mount it in the `InFrontOfTheCanvas` slot**

In `client/src/ui.tsx`, add the import next to the other chrome imports:

```tsx
import { FocusOverlay } from './chrome/FocusOverlay'
import { LockedShapeBadge } from './chrome/LockedShapeBadge'
```

and add the third sibling to the fragment (replacing the existing `InFrontOfTheCanvas` body):

```tsx
// InFrontOfTheCanvas takes one component, so the contextual style panel
// (spec §6), the focus-view overlay (spec §7) and the locked-shape padlock
// chip — independent chrome concerns that all need to render inside tldraw's
// canvas-region layer — share the slot via a small fragment wrapper rather
// than one merging into another's file.
function InFrontOfTheCanvas() {
	return (
		<>
			<ContextualStylePanel />
			<FocusOverlay />
			<LockedShapeBadge />
		</>
	)
}
```

- [x] **Step 3: Enable `selectLockedShapes` on the `<Tldraw>` mount**

In `client/src/App.tsx`, add the `options` prop to the existing `<Tldraw>` element (the other props stay exactly as they are):

```tsx
				<Tldraw
					store={store}
					onMount={handleMount}
					deepLinks
					assetUrls={assetUrls}
					shapeUtils={customShapeUtils}
					overlayUtils={avOverlayUtils}
					overrides={uiOverrides}
					components={components}
					// Hard prerequisite for the locked-shape padlock chip
					// (chrome/LockedShapeBadge.tsx): hover hit-testing passes
					// `hitLocked: editor.options.selectLockedShapes`, which defaults to
					// false, so getHoveredShapeId() can otherwise never return a locked
					// shape and the chip would silently never render.
					//
					// Accepted side effect (spec §4): locked shapes become click- and
					// marquee-selectable. They stay protected from edits, moves and
					// deletes — and a click now produces visible feedback instead of
					// absolutely nothing, which is the whole point.
					options={{ selectLockedShapes: true }}
				>
```

- [x] **Step 4: Typecheck and build**

Run: `bun run --filter '@ensembleworks/client' typecheck`
Expected: no errors. (If `TLShapeId` is not exported as a type from `tldraw`, import it from `@tldraw/editor` instead — the repo already depends on it transitively; a `getShapePageBounds` overload mismatch is the symptom.)

Run: `bun run test`
Expected: all pass, exit 0.

- [x] **Step 5: Commit**

```bash
git add client/src/chrome/LockedShapeBadge.tsx client/src/ui.tsx client/src/App.tsx
git commit -m "feat(chrome): show a padlock chip on hovered or selected locked shapes

A locked shape rendered identically to an unlocked one and silently
ignored every interaction, which cost about an hour of live-session
triage. This pins a small padlock chip just outside a shape's top-right
corner while it is hovered or selected, for every shape type, from a
single component in the InFrontOfTheCanvas slot. At rest the canvas is
unchanged.

selectLockedShapes: true is not optional config here: hover hit-testing
passes hitLocked: editor.options.selectLockedShapes and the default is
false, so without it getHoveredShapeId() can never return a locked shape
and the chip would never render. The accepted side effect is that locked
shapes become click- and marquee-selectable, still protected from edits,
moves and deletes.

Informational only — right-click -> Unlock already exists, and knowing
the shape is locked was the whole problem.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: canvas-v2 parity marker

Spec §8: canvas-v2 has its own hit-testing and shape stack and does not inherit any of this. Leave the marker where whoever makes v2 the live engine will hit it, mirroring how `docs/plans/2026-07-22-connection-health-modal-design.md` §7 handled the same problem.

**Files:**
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (header doc comment)
- Modify: the PR #62 body (contract-gate opt-out — see Global Constraints)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Comment and PR metadata only.

- [x] **Step 1: Add the marker to the CanvasV2App header comment**

Append this paragraph to the end of the existing top-of-file doc comment block in `client/src/canvas-v2/CanvasV2App.tsx` (before the closing `*/`):

```
 * TODO(canvas-v2 locked-shape-affordance): the v1 engine shows a padlock chip
 * on hovered/selected locked shapes (client/src/chrome/LockedShapeBadge.tsx,
 * spec docs/superpowers/specs/2026-07-23-locked-shape-affordance-design.md
 * §8). v2 inherits none of it — it needs both the `selectLockedShapes`
 * equivalent in its OWN hit-testing (a locked shape excluded from hover can
 * never surface a badge) and the badge itself, before v2 becomes the live
 * engine. Without it, v2 reintroduces the silent-dead-shape bug this fixed.
```

- [x] **Step 2: Add the contract-gate opt-out to the PR body**

`scripts/ux-contract-presence.test.ts` fails any diff touching `client/src/canvas-v2/` without a contract or a reasoned opt-out. This change is a comment. Add this line to the PR #62 body:

```
ux-contract: none — comment-only TODO marker in CanvasV2App.tsx; the feature ships entirely in the v1 chrome layer (client/src/chrome/, ui.tsx, App.tsx), which is outside the gate's interaction-bearing prefixes and adds no gesture, tool or input handling of any kind (the badge is pointerEvents: 'none').
```

Apply it with:

```bash
gh pr view 62 --json body --jq .body > /tmp/pr62-body.md
printf '\nux-contract: none — comment-only TODO marker in CanvasV2App.tsx; the feature ships entirely in the v1 chrome layer (client/src/chrome/, ui.tsx, App.tsx), which is outside the gate'"'"'s interaction-bearing prefixes and adds no gesture, tool or input handling of any kind (the badge is pointerEvents: '"'"'none'"'"').\n' >> /tmp/pr62-body.md
gh pr edit 62 --body-file /tmp/pr62-body.md
```

- [x] **Step 3: Verify the gate passes**

Run: `bun scripts/ux-contract-presence.test.ts`
Expected: PASS, exit 0.

Run: `bun run --filter '@ensembleworks/client' typecheck`
Expected: no errors (a comment change must not move it, but the file is large — confirm rather than assume).

- [x] **Step 4: Commit**

```bash
git add client/src/canvas-v2/CanvasV2App.tsx
git commit -m "docs(canvas-v2): mark the locked-shape affordance as v1-only

canvas-v2 has its own hit-testing and shape stack and inherits none of
the v1 padlock chip. Leave the parity requirement where whoever makes v2
the live engine will actually read it, rather than only in the spec.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Manual smoke, regression, and spec status

Positioning is thin glue over tldraw APIs and is covered by eyes, not by unit tests (spec §9). This task is the gate that says the feature actually works in the running app.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-locked-shape-affordance-design.md:3` (Status line)

**Interfaces:**
- Consumes: the running feature from Tasks 2 and 3.
- Produces: nothing consumed by later tasks — this is the last task.

- [x] **Step 1: Start the dev stack**

Run from the repo root (host):

```bash
bin/dev up
bin/dev status --json 2>/dev/null
```

Expected: services report healthy. Open the room at the edge URL `bin/dev up` narrates (default `http://localhost:8080`).

- [x] **Step 2: Walk the smoke checklist (spec §9)**

Lock a terminal with Cmd+Shift+L (or right-click → Lock), then confirm each of these. Record the actual observed result for every line — a checklist reported as "all fine" without per-line observations is not evidence.

- [x] At rest (pointer elsewhere, nothing selected) the locked terminal looks **identical** to before — no chip, no border change.
- [x] Hover it → the padlock chip appears just outside the top-right of its bounds.
- [x] The chip does **not** overlap the terminal's own title chip (which is top-left).
- [x] Move the pointer away → the chip disappears.
- [x] Click it → it **selects** (tldraw's selection indicator appears) and the chip persists with the pointer moved away.
- [x] Pan and zoom while it is selected → the chip stays glued to the shape's top-right corner (this is the `editor.getCamera()` subscription).
- [x] Lock a **frame**, then hover one of its child shapes → the child shows a chip (`isShapeOrAncestorLocked`).
- [x] Repeat hover+select on a locked **arrow** and a locked **draw stroke** → both badge, positioned off their bounding box.
- [x] Select **every** shape on a canvas with several locked shapes (via
  `editor.setSelectedShapes(...)`) → **every** locked shape badges, no cap. Judge
  whether it is unpleasant when zoomed out; if it is, note it as the §5
  legibility follow-up — do **not** implement a cap. Note: this cannot be reached
  through select-all — `Editor.selectAll()` strips locked shapes unconditionally,
  so Ctrl+A can never badge them. See the "Correction" block in spec §5.
- [x] Draw or arrow tool armed → hovering a locked shape does not badge. This is the accepted §4 limitation, confirm it rather than treat it as a bug.

- [x] **Step 3: Walk the regression checklist (spec §9)**

`selectLockedShapes: true` must not have weakened lock semantics. On a locked terminal:

- [x] Double-click → does **not** enter edit mode / does not accept typing.
- [x] Drag → does **not** move.
- [x] Delete / Backspace with it selected → is **not** deleted.
- [x] Marquee-drag a box over it plus an unlocked shape, then drag the selection → the unlocked shape moves, the locked one stays put.
- [x] Right-click → **Unlock** is present and works; after unlocking, the shape behaves normally and no longer badges.

- [x] **Step 4: Flip the spec status**

In `docs/superpowers/specs/2026-07-23-locked-shape-affordance-design.md`, change line 3-4 from:

```markdown
- **Status:** SPEC (agreed 2026-07-23). Implementation plan follows separately
  (superpowers:writing-plans).
```

to:

```markdown
- **Status:** IMPLEMENTED (2026-07-26). Plan:
  [`../plans/2026-07-26-locked-shape-affordance.md`](../plans/2026-07-26-locked-shape-affordance.md).
```

- [x] **Step 5: Full verification before claiming done**

Run: `bun run test`
Expected: all pass, exit 0.

Run: `bun run typecheck`
Expected: every workspace clean.

Run: `bun run build`
Expected: succeeds.

- [x] **Step 6: Commit and push**

```bash
git add docs/superpowers/specs/2026-07-23-locked-shape-affordance-design.md docs/superpowers/plans/2026-07-26-locked-shape-affordance.md
git commit -m "docs(specs): mark the locked-shape affordance implemented

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

Then confirm CI: `gh pr checks 62`
Expected: `unit-tests` and `e2e` both SUCCESS.

---

## Deliberately not built

Carried from the spec so nobody re-adds them mid-implementation:

- **A badge count cap.** Rejected in spec §5 — a truncated set misreports how many shapes are locked.
- **A legibility/zoom threshold for suppressing tiny badges.** Spec §5 names this as a follow-up to build only if Task 4's select-all check shows it is actually ugly. YAGNI until observed.
- **An unlock button on the chip.** Spec §6 — right-click → Unlock already exists.
- **A per-shape-util canvas overlay.** Spec §5 chose one React component precisely to avoid this.
- **Any tldraw 5.2 work.** Spec §7 — `selectLockedShapes` exists in 5.1.0.
- **Any canvas-v2 implementation.** Spec §8 — Task 3's marker is the whole deliverable there.
