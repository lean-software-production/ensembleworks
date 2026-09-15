# Compact selection toolbar + left tool rail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the canvas v2 style panel with a one-row light "pill" toolbar of current-value triggers + popovers above the selection, and move the tool toolbar to a vertical left rail whose active style-bearing tool shows its next-shape style in a flyout.

**Architecture:** A pure per-kind slot table in `canvas-editor` decides which triggers a selection gets (intersection across kinds). `canvas-ui`'s `StylePanel` renders those slots as a bar and stays hook-free: which popover is open is a controlled prop owned by `CanvasSurface`. Value controls (swatches, icon buttons, opacity stops) move unchanged into a shared `style-controls.tsx` used by both the popover and the new rail flyout, which `Toolbar` renders beside its active button. Hosts (web app v2 mount, bb Canvas plugin) only change toolbar placement.

**Tech Stack:** TypeScript, React 19, Bun workspaces (self-executing `node:assert` test scripts, `renderToStaticMarkup`, happy-dom), Playwright e2e + `@ensembleworks/interaction-contracts`, plugin package with vitest.

**Spec:** [docs/plans/2026-09-15-canvas-selection-toolbar-design.md](2026-09-15-canvas-selection-toolbar-design.md) — read it first. Clickable mockup of the target look: [2026-09-15-canvas-selection-toolbar-mockup.html](2026-09-15-canvas-selection-toolbar-mockup.html) (variant "A · Light pill" + "Left rail").

## Global Constraints

- Variant A: light pill using existing `UI_VARS` (canvas-ui/src/theme.ts). No new theme variables unless a host needs one; no hard-coded chrome colours.
- Style-only bar: no lock/duplicate/delete/tag controls.
- One PR, Part 1 (Tasks 1–4) commits before Part 2 (Tasks 5–6).
- `canvas-editor` stays DOM/React-free; `canvas-ui` holds no transport/host code.
- `StylePanel` must stay callable as a plain function (no hooks) — `StylePanel.test.ts` invokes it directly.
- Keep `pointer-events: none` on panel/bar/popover containers and `auto` on controls; keep `onPointerDown`/`onPointerUp` stopPropagation on the container.
- Keep DOM hooks: `data-testid="ew-style-panel"`, `data-style-panel-mode="selection"|"armed"`, `data-style-control`, `data-style-value`, `data-current`, `aria-pressed`. Add `data-style-trigger="<slot id>"` and `data-style-popover="<slot id>"`.
- Do not change `relevantAxes` semantics (union) — only the toolbar's slot resolution intersects.
- Interaction-contract obligations (CLAUDE.md "Interaction contracts"): declare/extend contracts; run RED against unfixed code before the fix and record the verbatim failure in the commit body; any `Obs` addition implemented in BOTH `canvas-editor/src/contracts/fsm-runner.ts` and `e2e/lib/contracts.ts`; reviewers re-verify red→green by reverting the fix. If RED is unreachable, STOP and report.
- Comment style: this repo's existing files carry long task-history comments; new code should have short, present-tense comments explaining *why*, not task history.
- Commits end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `canvas-editor/src/session/style-toolbar-layout.ts` (new) | Per-kind ordered slot table + `toolbarSlots(kinds)` intersection resolver. Pure. |
| `canvas-editor/src/session/style-toolbar-layout.test.ts` (new) | Table/invariant tests. |
| `canvas-ui/src/style-controls.tsx` (new) | `AxisRow` value controls, `axisIcon`, `colorSwatchHex`, `humanize`, `AXIS_LABELS`, button styles — moved out of `StylePanel.tsx` verbatim. |
| `canvas-ui/src/StylePanel.tsx` (modify) | Selection bar: triggers, popover, positioning. Armed branch removed in Task 5. |
| `canvas-ui/src/StylePanel.test.ts`, `StylePanel.position.test.ts` (modify) | Bar/popover rendering + pure positioning. |
| `canvas-ui/src/CanvasSurface.tsx` (modify) | Owns `openSlot` state; closes on selection change / gesture. |
| `canvas-ui/src/Toolbar.tsx` (modify) | `orientation` prop; renders `ArmedStyleFlyout` beside the active style-bearing tool. |
| `canvas-ui/src/ArmedStyleFlyout.tsx` (new) | Expanded next-shape style controls for an armed tool. |
| `interaction-contracts/src/types.ts` (modify) | `Obs.openStylePopover()`. |
| `interaction-contracts/src/contracts/style-popover-escape.ts` (new) | Escape closes popover, keeps selection. |
| `interaction-contracts/src/contracts/style-applies-to-selection.ts`, `style-edit-arms-next-shape.ts`, `armed-style-applies-to-created-shape.ts` (modify) | Gesture migrations. |
| `client/src/canvas-v2/CanvasV2App.tsx` (+ `.test.ts`) (modify) | Rail placement; swatch tests open the popover first. |
| `plugins/canvas/canvas/panel/session-view.tsx`, `shared.ts`, `tests/chrome-dock.test.ts` (modify) | Rail placement in the plugin. |
| `e2e/tests/style-panel-scroll.spec.ts` (delete) | Wheel-scroll behaviour removed with the one-row bar. |

---

## Part 1 — selection toolbar

### Task 1: Per-kind toolbar slot table

**Files:**
- Create: `canvas-editor/src/session/style-toolbar-layout.ts`
- Create: `canvas-editor/src/session/style-toolbar-layout.test.ts`
- Modify: `canvas-editor/src/session/index.ts` (add export)

**Interfaces:**
- Consumes: `StyleAxis`, `relevantAxesForTool`, `ToolId` from `./style-axes.js` / `./tool-loop.js`; `ShapeKind` from `@ensembleworks/canvas-model`.
- Produces:
  ```ts
  export type ToolbarSlotId = 'color' | 'font' | 'size' | 'align' | 'geo' | 'fill' | 'dash' | 'arrowheads' | 'more'
  export interface ToolbarSlot { readonly id: ToolbarSlotId; readonly axes: readonly StyleAxis[] }
  export function toolbarSlots(kinds: readonly ShapeKind[]): readonly ToolbarSlot[]
  ```
  `more` is always last when present. `axes[0]` is the axis whose current value the trigger face shows (for `more`, the face is a fixed ⋯ icon).

- [ ] **Step 1: Write the failing test**

```ts
// Run: bun src/session/style-toolbar-layout.test.ts
import assert from 'node:assert/strict'
import { relevantAxesForTool } from './style-axes.js'
import { toolbarSlots } from './style-toolbar-layout.js'

const ids = (kinds: Parameters<typeof toolbarSlots>[0]) => toolbarSlots(kinds).map((s) => `${s.id}:${s.axes.join('+')}`)

assert.deepEqual(ids(['note']), ['color:color', 'font:font', 'size:size', 'align:align+verticalAlign', 'more:opacity'])
assert.deepEqual(ids(['text']), ['color:color', 'font:font', 'size:size', 'align:textAlign', 'more:opacity'])
assert.deepEqual(ids(['geo']), ['geo:geo', 'color:color', 'fill:fill', 'dash:dash', 'align:align+verticalAlign', 'more:size+font+opacity'])
assert.deepEqual(ids(['arrow']), ['color:color', 'dash:dash', 'arrowheads:arrowheadStart+arrowheadEnd', 'more:size+fill+font+opacity'])
console.log('ok: per-kind layouts')

// Every axis a kind supports is reachable from exactly one slot, and nothing extra is invented.
for (const kind of ['note', 'text', 'geo', 'arrow'] as const) {
	const flat = toolbarSlots([kind]).flatMap((s) => s.axes)
	assert.deepEqual([...flat].sort(), [...relevantAxesForTool(kind)].sort(), `${kind} slots cover relevantAxes exactly`)
	assert.equal(new Set(flat).size, flat.length, `${kind} has no axis in two slots`)
}
console.log('ok: slots cover relevant axes exactly once')

// Mixed selection: intersection, first kind's order, more last.
assert.deepEqual(ids(['geo', 'arrow']), ['color:color', 'fill:fill', 'dash:dash', 'more:size+font+opacity'])
assert.deepEqual(ids(['note', 'geo']), ['color:color', 'font:font', 'size:size', 'align:align+verticalAlign', 'more:opacity'])
assert.deepEqual(ids(['note', 'note']), ids(['note']), 'duplicate kinds collapse')
console.log('ok: mixed selections intersect')

// Kinds with no style props still get opacity.
assert.deepEqual(ids(['frame']), ['more:opacity'])
assert.deepEqual(ids(['note', 'frame']), ['more:opacity'])
assert.deepEqual(ids([]), [])
console.log('ok: unstyled kinds and empty selection')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd canvas-editor && bun src/session/style-toolbar-layout.test.ts`
Expected: FAIL — `Cannot find module './style-toolbar-layout.js'`.

- [ ] **Step 3: Write implementation**

```ts
// Which triggers the selection style toolbar shows, and in what order, per
// shape kind. Pure: canvas-ui renders these slots; the table decides them.
// Axes a kind supports but rarely changes live in the trailing `more` slot.
import type { ShapeKind } from '@ensembleworks/canvas-model'
import type { StyleAxis } from './style-axes.js'

export type ToolbarSlotId = 'color' | 'font' | 'size' | 'align' | 'geo' | 'fill' | 'dash' | 'arrowheads' | 'more'

export interface ToolbarSlot {
	readonly id: ToolbarSlotId
	/** The axes this slot's popover edits; the trigger face shows `axes[0]`. */
	readonly axes: readonly StyleAxis[]
}

const slot = (id: ToolbarSlotId, ...axes: StyleAxis[]): ToolbarSlot => ({ id, axes })

// First guess from the 2026-09-15 design; tune after dogfooding.
const LAYOUT_BY_KIND: Partial<Record<ShapeKind, readonly ToolbarSlot[]>> = {
	note: [slot('color', 'color'), slot('font', 'font'), slot('size', 'size'), slot('align', 'align', 'verticalAlign'), slot('more', 'opacity')],
	text: [slot('color', 'color'), slot('font', 'font'), slot('size', 'size'), slot('align', 'textAlign'), slot('more', 'opacity')],
	geo: [slot('geo', 'geo'), slot('color', 'color'), slot('fill', 'fill'), slot('dash', 'dash'), slot('align', 'align', 'verticalAlign'), slot('more', 'size', 'font', 'opacity')],
	arrow: [slot('color', 'color'), slot('dash', 'dash'), slot('arrowheads', 'arrowheadStart', 'arrowheadEnd'), slot('more', 'size', 'fill', 'font', 'opacity')],
}

// Opacity is an envelope field every kind has.
const UNSTYLED: readonly ToolbarSlot[] = [slot('more', 'opacity')]

function layoutFor(kind: ShapeKind): readonly ToolbarSlot[] {
	return LAYOUT_BY_KIND[kind] ?? UNSTYLED
}

/** Slots for a selection of these kinds: the first kind's order, keeping only
 * axes every kind supports, dropping emptied slots. */
export function toolbarSlots(kinds: readonly ShapeKind[]): readonly ToolbarSlot[] {
	if (kinds.length === 0) return []
	const unique = [...new Set(kinds)]
	const supported = unique.map((k) => new Set(layoutFor(k).flatMap((s) => s.axes)))
	const common = (axis: StyleAxis) => supported.every((set) => set.has(axis))
	const out: ToolbarSlot[] = []
	let more: StyleAxis[] = []
	for (const s of layoutFor(unique[0]!)) {
		const axes = s.axes.filter(common)
		if (s.id === 'more') more = axes
		else if (axes.length > 0) out.push({ id: s.id, axes })
	}
	// An axis that is top-level for the first kind but only in `more` for
	// another is still top-level; an axis only in the first kind's `more`
	// stays there.
	if (more.length > 0) out.push({ id: 'more', axes: more })
	return out
}
```

Add to `canvas-editor/src/session/index.ts`:

```ts
export * from './style-toolbar-layout.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd canvas-editor && bun src/session/style-toolbar-layout.test.ts && bun run typecheck`
Expected: four `ok:` lines, typecheck clean. (`test.ts` discovers the new file automatically.)

- [ ] **Step 5: Commit**

```bash
git add canvas-editor/src/session/style-toolbar-layout.ts canvas-editor/src/session/style-toolbar-layout.test.ts canvas-editor/src/session/index.ts
git commit -m "feat(canvas-editor): per-kind style toolbar slot table"
```

---

### Task 2: StylePanel renders the one-row bar and a controlled popover

`ux-contract` note for this task's commit: the interaction change lands here but its contracts are migrated/added in Tasks 3–4; the PR body carries the contracts, not an opt-out.

**Files:**
- Create: `canvas-ui/src/style-controls.tsx`
- Modify: `canvas-ui/src/StylePanel.tsx`
- Modify: `canvas-ui/src/StylePanel.test.ts`
- Modify: `canvas-ui/src/StylePanel.position.test.ts`
- Delete: `e2e/tests/style-panel-scroll.spec.ts`

**Interfaces:**
- Consumes: `toolbarSlots`, `ToolbarSlot`, `ToolbarSlotId` (Task 1).
- Produces:
  ```ts
  // style-controls.tsx
  export const AXIS_LABELS: Record<StyleAxis, string>
  export function humanize(value: string): string
  export function colorSwatchHex(value: string): string
  export function axisIcon(axis: StyleAxis, value: string): ReactNode
  export type StyleChange = (axis: StyleAxis, value: StyleValue, options?: { readonly onlySelection: boolean }) => void
  export function AxisRow(props: { axis: StyleAxis; value: StyleValue | 'mixed' | undefined; onStyleChange: StyleChange; showLabel?: boolean }): ReactElement

  // StylePanel.tsx — new props on StylePanelProps
  readonly openSlot: ToolbarSlotId | null
  readonly onOpenSlotChange: (slot: ToolbarSlotId | null) => void
  // new pure export
  export function popoverPosition(
    bar: { left: number; top: number; width: number; height: number },
    trigger: { left: number; width: number },
    popover: { width: number; height: number },
    viewport: { width: number; height: number },
    side: 'above' | 'below',
    margin: number,
  ): { left: number; top: number }
  ```

- [ ] **Step 1: Move value controls to `style-controls.tsx` (pure refactor)**

Move from `StylePanel.tsx` into `style-controls.tsx`, unchanged in behaviour: `AXIS_LABELS`, `colorSwatchHex`, `humanize`, `SWATCH_PX`, `SWATCH_GAP_PX`, `swatchButtonStyle`, `ICON_BUTTON_PX`, `segButtonStyle`, `axisIcon`, `OPACITY_*` styles, `opacityStopStyle`, `AxisRow`. Export the names listed in Interfaces. Add an optional `showLabel` prop to `AxisRow` (default `true`) that hides the `<span style={ROW_LABEL_STYLE}>` label. `StylePanel.tsx` imports them back. Run `cd canvas-ui && bun run test && bun run typecheck` — expected: all existing tests still pass. Commit:

```bash
git add canvas-ui/src/style-controls.tsx canvas-ui/src/StylePanel.tsx
git commit -m "refactor(canvas-ui): move style value controls out of StylePanel"
```

- [ ] **Step 2: Write failing bar/popover tests**

Rewrite the selection-mode cases in `StylePanel.test.ts` (keep the file's `shape`/`docOf` helpers and all ARMED-mode cases untouched). Add a helper and these cases; delete any case asserting the old stacked layout (every-row-visible, `maxHeight`, wheel listener) — they describe removed behaviour:

```ts
function renderSelection(shapes: readonly Shape[], openSlot: string | null = null) {
	return renderToStaticMarkup(
		createElement(StylePanel, {
			selection: new Set(shapes.map((s) => s.id)),
			snapshot: docOf(...shapes),
			camera: CAMERA,
			viewportSize: VIEWPORT,
			isGesturing: false,
			activeToolId: 'select',
			nextShapeStyle: {},
			onStyleChange: noop,
			onArmStyle: noop,
			openSlot: openSlot as never,
			onOpenSlotChange: noop,
		}),
	)
}
const triggers = (html: string) => [...html.matchAll(/data-style-trigger="([^"]+)"/g)].map((m) => m[1])

// Closed: one trigger per slot, no value controls rendered.
{
	const n = shape({ id: 'shape:n', kind: 'note', props: { color: 'blue' } })
	const html = renderSelection([n])
	assert.deepEqual(triggers(html), ['color', 'font', 'size', 'align', 'more'])
	assert.ok(!html.includes('data-style-value='), `no value buttons while closed — html: ${html}`)
	assert.ok(!html.includes('data-style-popover'), 'no popover while closed')
	assert.match(html, /data-style-trigger="color"[^>]*aria-expanded="false"/)
	assert.match(html, /data-style-trigger="color"[^>]*aria-haspopup="true"/)
	console.log('ok: closed note bar shows five triggers and no values')
}

// Trigger face shows the current value.
{
	const n = shape({ id: 'shape:n', kind: 'note', props: { color: 'blue', size: 'l' } })
	const html = renderSelection([n])
	assert.match(html, /data-style-trigger="color"[^>]*>.*background:#4465e9/s, 'colour trigger shows the blue swatch')
	assert.match(html, /data-style-trigger="size"[^>]*title="Size: L"/, 'size trigger names its value')
	console.log('ok: trigger faces reflect current values')
}

// Open: popover renders that slot's axes with existing data hooks.
{
	const n = shape({ id: 'shape:n', kind: 'note', props: { color: 'blue' } })
	const html = renderSelection([n], 'color')
	assert.ok(html.includes('data-style-popover="color"'))
	assert.match(html, /data-style-trigger="color"[^>]*aria-expanded="true"/)
	assert.match(html, /data-style-control="color"/)
	assert.match(html, /data-style-value="blue"[^>]*data-current="true"|data-current="true"[^>]*data-style-value="blue"/)
	const alignHtml = renderSelection([n], 'align')
	assert.ok(alignHtml.includes('data-style-control="align"') && alignHtml.includes('data-style-control="verticalAlign"'), 'multi-axis slot renders both rows')
	console.log('ok: open popover renders the slot controls')
}

// Mixed geo + arrow: intersection only.
{
	const g = shape({ id: 'shape:g', kind: 'geo', props: {} })
	const a = shape({ id: 'shape:a', kind: 'arrow', props: {} })
	assert.deepEqual(triggers(renderSelection([g, a])), ['color', 'fill', 'dash', 'more'])
	console.log('ok: mixed selection shows only shared triggers')
}

// Mixed value: colour trigger marks mixed.
{
	const a = shape({ id: 'shape:a', kind: 'note', props: { color: 'blue' } })
	const b = shape({ id: 'shape:b', kind: 'note', props: { color: 'red' } })
	assert.match(renderSelection([a, b]), /data-style-trigger="color"[^>]*data-style-mixed="true"/)
	console.log('ok: disagreeing selection marks the trigger mixed')
}

// Pointer-events contract still holds for bar and popover.
{
	const n = shape({ id: 'shape:n', kind: 'note', props: {} })
	const html = renderSelection([n], 'color')
	assert.match(html, /data-testid="ew-style-panel"[^>]*pointer-events:none/)
	assert.match(html, /data-style-popover="color"[^>]*pointer-events:none/)
	assert.match(html, /data-style-trigger="color"[^>]*pointer-events:auto/)
	console.log('ok: containers pass pointers through, controls take them')
}
```

Also exercise the click wiring by calling the function directly (house pattern of existing cases 9/10): find the trigger element in `StylePanel({...})`'s returned tree and call its `onClick`; assert `onOpenSlotChange` received `'color'` when closed and `null` when `openSlot === 'color'`. Use the existing tree-walk helper already in the file for cases 9/10.

In `StylePanel.position.test.ts`, delete cases pinned to `PANEL_MAX_HEIGHT`/`colorRowWidth`/`panelContentWidth` and add:

```ts
import { popoverPosition } from './StylePanel.js'

// Above the selection: popover opens above the bar, centred on its trigger.
assert.deepEqual(
	popoverPosition({ left: 400, top: 300, width: 200, height: 40 }, { left: 420, width: 30 }, { width: 180, height: 60 }, { width: 1280, height: 720 }, 'above', 8),
	{ left: 345, top: 232 },
)
// Below the selection: popover opens below the bar.
assert.deepEqual(
	popoverPosition({ left: 400, top: 300, width: 200, height: 40 }, { left: 420, width: 30 }, { width: 180, height: 60 }, { width: 1280, height: 720 }, 'below', 8),
	{ left: 345, top: 348 },
)
// Clamped at the viewport's left edge.
assert.equal(popoverPosition({ left: 0, top: 300, width: 200, height: 40 }, { left: 4, width: 30 }, { width: 180, height: 60 }, { width: 1280, height: 720 }, 'below', 8).left, 8)
console.log('ok: popoverPosition opens away from the selection and clamps')
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd canvas-ui && bun src/StylePanel.test.ts; bun src/StylePanel.position.test.ts`
Expected: FAIL — first new assertion (`triggers(html)` is `[]`) and `popoverPosition is not a function`.

- [ ] **Step 4: Implement the bar**

In `StylePanel.tsx` selection branch:

1. `const kinds = shapes.map((s) => s.kind)`; `const slots = toolbarSlots(kinds)`; return `null` when `slots.length === 0` (replaces the `relevantAxes` emptiness check; the locked-selection suppression upstream is unchanged).
2. Bar container: `PANEL_STYLE` becomes `BAR_STYLE` — `display:flex; flexDirection:row; alignItems:center; gap:2; padding:4; borderRadius:10; background/border/shadow from UI_VARS; pointerEvents:'none'; zIndex:500; whiteSpace:'nowrap'; boxSizing:'border-box'`. Remove `maxWidth`, `maxHeight`, `overflowY`, `ref={panelRefCallback}`, and the whole wheel-listener block (`livePanelEl`, `handlePanelWheel`, `bindPanelWheelListenerOnce`, `panelRefCallback`).
3. Per slot a trigger button: `data-style-trigger={slot.id}`, `aria-haspopup="true"`, `aria-expanded={openSlot === slot.id}`, `data-style-mixed` when `currentValue(shapes, slot.axes[0]) === 'mixed'`, `title` = `${AXIS_LABELS[axis]}: ${humanize(String(value))}` (for `more`: `"More styles"`), `pointerEvents:'auto'`, 30px tall, transparent background, `accentSoft` background + `accent` colour when open. `onClick={() => onOpenSlotChange(openSlot === slot.id ? null : slot.id)}`.
4. Trigger face: `color` → 18px round swatch `background: colorSwatchHex(value)` (mixed → conic-gradient of four palette colours); `size` → uppercase value text (`S`/`M`/`L`/`XL`); `font` → `<FontIcon variant={value} />`; others → `axisIcon(axis, value)`; mixed non-colour → `–`; `more` → three-dot SVG.
5. A 1px `UI_VARS.panelBorder` divider before `more`.
6. When `openSlot` names a slot present in `slots`, render the popover as a SIBLING of the bar. Both live inside one wrapper `<div data-testid="ew-style-panel" data-canvas-v2-style-panel data-style-panel-mode="selection" onPointerDown/onPointerUp={stopPropagation}>` styled `position:absolute; inset:0; pointer-events:none` (the wrapper is always rendered when there are slots; bar and popover are absolutely positioned inside it). Popover: `data-style-popover={slot.id}`, same card styling as the bar, `display:flex; flexDirection:column; gap:8; padding:8`, `pointerEvents:'none'`, one `<AxisRow axis value onStyleChange showLabel={slot.axes.length > 1} />` per axis. Colour row width: 6 swatches per line (`width: 6*SWATCH_PX + 5*SWATCH_GAP_PX` + a little); geo row: 5 per line.
7. Positioning: keep `clampPanelPosition`/`avoidAnchorOverlap`, now called with `{ width: BAR_MAX_WIDTH, height: BAR_HEIGHT }` where `BAR_HEIGHT = 40` and `BAR_MAX_WIDTH = 6 * 34 + 12` (widest layout is geo's six slots). `side` is `'above'` when the resulting transform is `translate(-50%, -100%)`, else `'below'`. The popover's pixel position comes from `popoverPosition`, computed from the bar's position, the trigger's index × 34px offset, and `POPOVER_MAX = { width: 200, height: 180 }` — no DOM measurement, so it is renderable statically.

```ts
export function popoverPosition(bar, trigger, popover, viewport, side, margin) {
	const centre = trigger.left + trigger.width / 2
	const left = clampRange(centre - popover.width / 2, margin, viewport.width - popover.width - margin)
	const top = side === 'above' ? bar.top - popover.height - margin : bar.top + bar.height + margin
	return { left, top: clampRange(top, margin, viewport.height - popover.height - margin) }
}
```

Delete `e2e/tests/style-panel-scroll.spec.ts` (the behaviour it pins is gone).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd canvas-ui && bun run test && bun run typecheck`
Expected: all `ok:` lines; `canvas-surface.test.ts` fails to typecheck because `CanvasSurface` does not yet pass `openSlot` — pass `openSlot={null} onOpenSlotChange={() => {}}` in `CanvasSurface.tsx` for now (wired in Task 3) and re-run: clean.

- [ ] **Step 6: Commit**

```bash
git add canvas-ui/src e2e/tests/style-panel-scroll.spec.ts
git commit -m "feat(canvas-ui): one-row selection style bar with slot popovers"
```

---

### Task 3: CanvasSurface owns the open popover; migrate selection contracts

**Files:**
- Modify: `canvas-ui/src/CanvasSurface.tsx`
- Modify: `canvas-ui/src/canvas-surface.test.ts`
- Modify: `client/src/canvas-v2/CanvasV2App.test.ts` (swatch-click cases ~lines 1238–1400)
- Modify: `interaction-contracts/src/contracts/style-applies-to-selection.ts`
- Modify: `interaction-contracts/src/contracts/style-edit-arms-next-shape.ts`

**Interfaces:**
- Consumes: `StylePanelProps.openSlot/onOpenSlotChange` (Task 2).
- Produces: exported pure helper in `CanvasSurface.tsx`:
  ```ts
  export interface OpenSlotState { readonly slot: ToolbarSlotId | null; readonly selectionKey: string }
  export function selectionKey(selection: ReadonlySet<string>): string
  export function effectiveOpenSlot(state: OpenSlotState, selection: ReadonlySet<string>, isGesturing: boolean): ToolbarSlotId | null
  ```

- [ ] **Step 1: Write failing unit test**

Append to `canvas-surface.test.ts`:

```ts
import { effectiveOpenSlot, selectionKey } from './CanvasSurface.js'

const sel = new Set(['shape:a', 'shape:b'])
const state = { slot: 'color' as const, selectionKey: selectionKey(sel) }
assert.equal(effectiveOpenSlot(state, new Set(['shape:b', 'shape:a']), false), 'color', 'same selection (any order) keeps it open')
assert.equal(effectiveOpenSlot(state, new Set(['shape:a']), false), null, 'selection change closes it')
assert.equal(effectiveOpenSlot(state, sel, true), null, 'a gesture closes it')
console.log('ok: open popover closes on selection change and gesture')
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd canvas-ui && bun src/canvas-surface.test.ts`
Expected: FAIL — `effectiveOpenSlot` is not exported.

- [ ] **Step 3: Implement**

```ts
export function selectionKey(selection: ReadonlySet<string>): string {
	return [...selection].sort().join('\n')
}

export function effectiveOpenSlot(state: OpenSlotState, selection: ReadonlySet<string>, isGesturing: boolean): ToolbarSlotId | null {
	if (isGesturing || state.selectionKey !== selectionKey(selection)) return null
	return state.slot
}
```

In `CanvasSurface`:

```ts
const [openState, setOpenState] = useState<OpenSlotState>({ slot: null, selectionKey: '' })
const openSlot = effectiveOpenSlot(openState, editorState.selection, session.isGesturing)
const onOpenSlotChange = useCallback(
	(slot: ToolbarSlotId | null) => setOpenState({ slot, selectionKey: selectionKey(editorState.selection) }),
	[editorState.selection],
)
```

Pass both to `<StylePanel>`. A gesture that ends with the same selection leaves `openState.slot` set, so after a drag the popover would reappear — reset it: in the same component, `useEffect(() => { if (session.isGesturing) setOpenState((s) => (s.slot === null ? s : { ...s, slot: null })) }, [session.isGesturing])`.

- [ ] **Step 4: Migrate the two selection contracts (gesture change only)**

These contracts' invariants are unchanged and GREEN before and after; only the gesture gains a trigger click. In both files insert, immediately before the blue-swatch `down`:

```ts
    { kind: 'down', at: { ref: 'element', selector: COLOR_TRIGGER_SELECTOR } },
    { kind: 'up' },
```

with `const COLOR_TRIGGER_SELECTOR = '[data-style-panel-mode="selection"] [data-style-trigger="color"]'` and the swatch selector scoped to `[data-style-popover="color"] [data-style-value="blue"]`. Replace the task-history header comments with a short description of the current gesture.

Reviewer check (in lieu of RED — no behaviour is being fixed): temporarily make `onOpenSlotChange` a no-op in `CanvasSurface.tsx`, run the two contracts, confirm they FAIL, restore. Record the verbatim failure in the commit body.

- [ ] **Step 5: Update `CanvasV2App.test.ts`**

Each happy-dom swatch/opacity click first clicks the matching trigger, then re-queries the value button (the popover mounts on re-render):

```ts
const openSlot = async (slot: string) => {
	;(styleContainer.querySelector(`[data-style-trigger="${slot}"]`) as HTMLElement).click()
	await flush() // use the file's existing render-settle helper
}
await openSlot('color')
const blueSwatch = styleContainer.querySelector('[data-style-popover="color"] [data-style-value="blue"]') as HTMLElement | null
```

Opacity lives in the `more` slot: `await openSlot('more')` before querying `[data-style-control="opacity"] [data-style-value="0.5"]`.

- [ ] **Step 6: Run**

Run: `cd canvas-ui && bun run test && bun run typecheck && cd ../client && bun src/canvas-v2/CanvasV2App.test.ts && cd ../e2e && bunx playwright test --project=e2e tests/contracts.spec.ts -g "style-applies-to-selection|style-edit-arms-next-shape"`
Expected: all pass. (e2e needs the dev stack: `bin/dev up` from the host; see CLAUDE.md "Local dev".)

- [ ] **Step 7: Commit**

```bash
git add canvas-ui/src client/src/canvas-v2/CanvasV2App.test.ts interaction-contracts/src/contracts
git commit -m "feat(canvas-ui): CanvasSurface owns the style popover; contracts open it first"
```

---

### Task 4: Escape closes the popover without touching the selection (contract, RED first)

**Files:**
- Modify: `interaction-contracts/src/types.ts` (add `openStylePopover`)
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` (throw-stub)
- Modify: `e2e/lib/contracts.ts` (sample + expose)
- Create: `interaction-contracts/src/contracts/style-popover-escape.ts`
- Modify: `interaction-contracts/src/index.ts` (register)
- Modify: `canvas-ui/src/StylePanel.tsx` (the fix)

**Interfaces:**
- Produces: `Obs.openStylePopover(): string | null` — the `data-style-popover` value of the mounted popover, or null. Browser-only.

- [ ] **Step 1: Add the observation to both adapters**

`types.ts`, after `renderedArrowIds`:

```ts
  /** The slot id of the style popover currently open over the selection
   * (`[data-style-popover]`), or null. Browser-only: the popover is rendered
   * chrome; the FSM adapter throws 'not observable at fsm level'. */
  openStylePopover(): string | null
```

`fsm-runner.ts`, next to `renderedArrowIds()`:

```ts
    openStylePopover() {
      throw new Error('not observable at fsm level')
    },
```

`e2e/lib/contracts.ts`: add `readonly openStylePopover: string | null` to `ActorSample`; in `sampleActor`:

```ts
  const openStylePopover = await page.evaluate(() => document.querySelector('[data-style-popover]')?.getAttribute('data-style-popover') ?? null)
```

include it in the returned object, and in the Obs builder `openStylePopover: () => sample.openStylePopover,`.

- [ ] **Step 2: Write the contract**

```ts
// Escape with a style popover open closes the popover and leaves the
// selection alone: the popover is the innermost thing Escape should dismiss.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:style-popover-escape'
const COLOR_TRIGGER = '[data-style-panel-mode="selection"] [data-style-trigger="color"]'
const BLUE_SWATCH = '[data-style-popover="color"] [data-style-value="blue"]'

export const stylePopoverEscape: Contract = {
  name: 'style-popover-escape',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'note', x: 300, y: 300, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'element', selector: COLOR_TRIGGER } },
    { kind: 'up' },
    // Clicking a swatch leaves focus inside the popover, where Escape lands.
    { kind: 'down', at: { ref: 'element', selector: BLUE_SWATCH } },
    { kind: 'up' },
    { kind: 'key', key: 'Escape' },
  ],
  check: (obs: Obs): string | null => {
    const open = obs.openStylePopover()
    if (open !== null) return `expected Escape to close the style popover, but ${JSON.stringify(open)} is still open`
    const selected = obs.selectedShapeIds()
    if (selected.length !== 1 || selected[0] !== ID) return `expected Escape to keep ${ID} selected, got ${JSON.stringify(selected)}`
    if (obs.shapeStyle(ID, 'color') !== 'blue') return `expected the swatch click to have applied blue, got ${JSON.stringify(obs.shapeStyle(ID, 'color'))}`
    return null
  },
}
```

Register it in `interaction-contracts/src/index.ts` alongside `styleAppliesToSelection`.

- [ ] **Step 3: Run RED**

Run: `cd e2e && bunx playwright test --project=e2e tests/contracts.spec.ts -g "style-popover-escape"`
Expected: FAIL with `expected Escape to close the style popover, but "color" is still open`. Record the verbatim output for the commit body. If it passes, or fails for any other reason (locator, selection cleared), STOP and report — do not adjust the contract to force RED.

- [ ] **Step 4: Fix**

On the `ew-style-panel` wrapper in `StylePanel.tsx`:

```tsx
onKeyDown={(e) => {
	if (e.key !== 'Escape' || openSlot === null) return
	// Stop here so neither the Viewport nor the session's document listener
	// treats this Escape as a canvas cancel.
	e.stopPropagation()
	e.preventDefault()
	onOpenSlotChange(null)
}}
```

Also return focus to the trigger: give the trigger `id={`ew-style-trigger-${slot.id}`}` and, in the handler, `document.getElementById(...)?.focus()` guarded by `typeof document !== 'undefined'`.

- [ ] **Step 5: Run GREEN + unit tests**

Run: `cd e2e && bunx playwright test --project=e2e tests/contracts.spec.ts -g "style-" && cd ../canvas-editor && bun run test && cd ../interaction-contracts && bun run test && cd .. && bun run typecheck`
Expected: all style contracts pass; FSM library test unaffected (browser-level contract); typecheck clean.

- [ ] **Step 6: Commit** (body includes the verbatim RED output)

```bash
git add interaction-contracts canvas-editor/src/contracts/fsm-runner.ts e2e/lib/contracts.ts canvas-ui/src/StylePanel.tsx
git commit -m "feat(canvas-ui): Escape closes the style popover and keeps the selection"
```

---

## Part 2 — left tool rail + armed flyout

### Task 5: Toolbar rail with armed-style flyout; remove floating armed panel

**Files:**
- Create: `canvas-ui/src/ArmedStyleFlyout.tsx`
- Modify: `canvas-ui/src/Toolbar.tsx`, `canvas-ui/src/toolbar.test.ts`
- Modify: `canvas-ui/src/StylePanel.tsx`, `canvas-ui/src/StylePanel.test.ts` (remove armed branch + cases, move armed cases to `toolbar.test.ts`)
- Modify: `canvas-ui/src/index.ts` (export flyout)
- Modify: `interaction-contracts/src/contracts/armed-style-applies-to-created-shape.ts`

**Interfaces:**
- Consumes: `AxisRow`, `StyleChange` (Task 2); `relevantAxesForTool`, `kindForTool`, `kindDefault` from canvas-editor.
- Produces:
  ```ts
  // Toolbar.tsx — ToolbarProps additions
  readonly orientation?: 'horizontal' | 'vertical'   // default 'horizontal'
  readonly nextShapeStyle?: Record<string, unknown>  // flyout shown only when this and onArmStyle are provided
  readonly onArmStyle?: StyleChange
  // ArmedStyleFlyout.tsx
  export function ArmedStyleFlyout(props: { toolId: ToolId; nextShapeStyle: Record<string, unknown>; onArmStyle: StyleChange; side: 'right' | 'above' }): ReactElement | null
  export function armedValue(nextShapeStyle: Record<string, unknown>, toolId: ToolId, axis: StyleAxis): StyleValue | undefined // moved from StylePanel.tsx
  ```

- [ ] **Step 1: Write failing tests in `toolbar.test.ts`**

```ts
const railHtml = renderToStaticMarkup(
	createElement(Toolbar, { activeToolId: 'geo', onSelectTool: () => {}, orientation: 'vertical', nextShapeStyle: { color: 'blue' }, onArmStyle: () => {} }),
)
assert.match(railHtml, /data-canvas-toolbar[^>]*aria-orientation="vertical"/, 'rail declares vertical orientation')
assert.match(railHtml, /data-canvas-toolbar[^>]*flex-direction:column/, 'rail stacks buttons')
assert.ok(railHtml.includes('data-style-panel-mode="armed"'), 'armed flyout renders for a style-bearing tool')
assert.match(railHtml, /data-style-value="blue"[^>]*data-current="true"|data-current="true"[^>]*data-style-value="blue"/, 'flyout shows the armed value')
assert.ok(railHtml.includes('data-style-control="geo"') && railHtml.includes('data-style-control="dash"'), 'flyout shows every axis expanded')
assert.ok(!railHtml.includes('data-style-control="opacity"'), 'flyout omits opacity')
assert.ok(railHtml.indexOf('data-canvas-tool="geo"') < railHtml.indexOf('data-style-panel-mode="armed"'), 'flyout is attached to the active tool button')

const selectHtml = renderToStaticMarkup(createElement(Toolbar, { activeToolId: 'select', onSelectTool: () => {}, orientation: 'vertical', nextShapeStyle: {}, onArmStyle: () => {} }))
assert.ok(!selectHtml.includes('data-style-panel-mode="armed"'), 'no flyout for select')
assert.ok(!html.includes('data-style-panel-mode="armed"'), 'no flyout when the host passes no onArmStyle')
console.log('ok: vertical rail with an armed flyout beside the active style tool')
```

Move the armed-mode cases from `StylePanel.test.ts` here, rendering `ArmedStyleFlyout` directly (same assertions on `armedValue` defaults, `onArmStyle` called instead of `onStyleChange`). In `StylePanel.test.ts`, replace them with one case: empty selection + `activeToolId: 'note'` renders `''`.

- [ ] **Step 2: Run to verify failure**

Run: `cd canvas-ui && bun src/toolbar.test.ts`
Expected: FAIL on `rail declares vertical orientation`.

- [ ] **Step 3: Migrate the armed contract and run RED (before implementing)**

Scope the swatch selector in `armed-style-applies-to-created-shape.ts` to the rail: `const ARMED_BLUE_SWATCH_SELECTOR = '[data-canvas-toolbar] [data-style-panel-mode="armed"] [data-style-control="color"] [data-style-value="blue"]'`. Commit Steps 1 and 3 as a WIP commit (do not stash), then:

Run: `cd e2e && bunx playwright test --project=e2e tests/contracts.spec.ts -g "armed-style-applies-to-created-shape"`
Expected RED: `element anchor "[data-canvas-toolbar] [data-style-panel-mode=\"armed\"] ..." has no bounding box` (the flyout does not exist yet). Record it verbatim. This missing-element RED is accepted because the change being proven is "the armed controls live in the rail"; the value assertion is unchanged. Any other failure: STOP and report.

- [ ] **Step 4: Implement**

`ArmedStyleFlyout.tsx`: move `armedValue` here from `StylePanel.tsx`. Render `null` unless `relevantAxesForTool(toolId)` has an axis other than `opacity`. Card: `data-testid="ew-style-panel" data-style-panel-mode="armed"`, `position:absolute`, `left: 'calc(100% + 10px)'`, `top: '50%'`, `transform: 'translateY(-50%)'` for `side: 'right'` (for `'above'`: `bottom: 'calc(100% + 10px)'`, `left: '50%'`, `transform: 'translateX(-50%)'`), `width: 220`, UI_VARS card styling, `zIndex: 500`, padding 10/12, small heading with the tool label, then `<AxisRow axis value={armedValue(...)} onStyleChange={onArmStyle} />` per non-opacity axis (labels shown). Controls keep `pointerEvents:'auto'`; the card itself `pointerEvents:'auto'` (it sits over the canvas edge, not a selection).

`Toolbar.tsx`: `role="toolbar"`, `aria-orientation={orientation}`, `flexDirection: orientation === 'vertical' ? 'column' : 'row'`. Wrap each button in `<div style={{ position: 'relative' }}>`; after the active button, when `nextShapeStyle && onArmStyle`, render `<ArmedStyleFlyout toolId={id} nextShapeStyle={nextShapeStyle} onArmStyle={onArmStyle} side={orientation === 'vertical' ? 'right' : 'above'} />`. Add a 1px separator after `hand` in vertical orientation.

`StylePanel.tsx`: delete the armed branch, `ARMED_PANEL_POSITION`, `armedValue`, and the `activeToolId`/`nextShapeStyle`/`onArmStyle` props; the empty-selection path returns `null`. Update `CanvasSurface.tsx` and `canvas-surface.test.ts` for the removed props.

- [ ] **Step 5: Run GREEN**

Run: `cd canvas-ui && bun run test && bun run typecheck && cd ../e2e && bunx playwright test --project=e2e tests/contracts.spec.ts -g "style|armed"`
Expected: all pass. The web app still renders the toolbar horizontally at the top (host placement is Task 6) — the flyout opens `above`, which may clip at the top edge; acceptable until Task 6.

- [ ] **Step 6: Commit** (squash the WIP commit; body includes the RED output)

```bash
git add canvas-ui/src interaction-contracts/src/contracts/armed-style-applies-to-created-shape.ts
git commit -m "feat(canvas-ui): armed style flyout beside the active rail tool"
```

---

### Task 6: Hosts place the toolbar as a left rail

`ux-contract: none — host layout only; the rail's interactions are covered by Task 5's contracts.`

**Files:**
- Modify: `client/src/canvas-v2/CanvasV2App.tsx:683-691`
- Modify: `plugins/canvas/canvas/panel/session-view.tsx` (`CanvasChrome`)
- Modify: `plugins/canvas/canvas/panel/shared.ts` (`chromeWrapperStyle`, `chromeToolbarStyle`)
- Modify: `plugins/canvas/tests/chrome-dock.test.ts`

**Interfaces:**
- Consumes: `Toolbar` `orientation`/`nextShapeStyle`/`onArmStyle` (Task 5); `session.onArmStyle` (existing, `use-canvas-session.ts`).

- [ ] **Step 1: Write failing plugin test**

In `plugins/canvas/tests/chrome-dock.test.ts` add:

```ts
it("docks the tool rail on the left edge, vertically centred", () => {
  expect(chromeWrapperStyle.left).toBe(CHROME_DOCK_EDGE_GAP_PX);
  expect(chromeWrapperStyle.top).toBe("50%");
  expect(chromeWrapperStyle.transform).toBe("translateY(-50%)");
  expect(chromeWrapperStyle.bottom).toBeUndefined();
  expect(chromeWrapperStyle.right).toBeUndefined();
});

it("renders the rail vertically with the armed flyout wired", () => {
  expect(countInCode(PANEL, 'orientation="vertical"')).toBe(1);
  expect(countInCode(PANEL, "onArmStyle={canvas.onArmStyle}")).toBe(1);
});
```

Update any existing assertion that pinned `bottom`/`right`/`justifyContent: center`, and the `CHROME_DOCK_TOOLBAR_OVERFLOW` "wraps" case: a vertical rail must not wrap into a second column — change the constant to `"nowrap"` and the test name/expectation to match.

- [ ] **Step 2: Run to verify failure**

Run: `cd plugins/canvas && npm test -- chrome-dock`
Expected: FAIL on `chromeWrapperStyle.top`.

- [ ] **Step 3: Implement plugin placement**

```ts
export const chromeWrapperStyle: CSSProperties = {
  position: "absolute",
  left: CHROME_DOCK_EDGE_GAP_PX,
  top: "50%",
  transform: "translateY(-50%)",
  zIndex: CHROME_DOCK_Z_INDEX,
  pointerEvents: CHROME_DOCK_POINTER_EVENTS.wrapper,
  display: "flex",
};
```

`chromeToolbarStyle`: `flexDirection: "column"`, `padding: "6px 5px"`. In `CanvasChrome`:

```tsx
<Toolbar
  orientation="vertical"
  activeToolId={canvas.activeToolId}
  onSelectTool={canvas.selectTool}
  nextShapeStyle={editorState.nextShapeStyle}
  onArmStyle={canvas.onArmStyle}
  style={{ background: "transparent", border: "none", padding: 0 }}
/>
```

`CanvasChrome` currently destructures only `{ canvas }`; change it to `{ canvas, editorState }` (both are already on `SessionViewProps`).

The wrapper's `transform` creates a containing block, so the flyout's absolute position is relative to the rail — intended.

- [ ] **Step 4: Implement web-app placement**

In `CanvasV2App.tsx`, remove the top `<div style={{ display: 'flex', padding: 6 }}><Toolbar …/></div>` row and render the toolbar as the last child of the `position: fixed` root div (`rootRef`) — NOT inside the `data-canvas-v2-viewport` container: `use-canvas-session`'s document keydown listener returns early for any target inside that container, so a focused rail button placed there would stop forwarding shortcuts.

```tsx
<Toolbar
	orientation="vertical"
	activeToolId={session.activeToolId}
	onSelectTool={session.selectTool}
	nextShapeStyle={editorState.nextShapeStyle}
	onArmStyle={session.onArmStyle}
	style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', zIndex: 600, boxShadow: 'var(--canvas-ui-shadow, 0 2px 10px rgba(15,23,42,0.18))' }}
/>
```

Because the root is `position: fixed; inset: 0`, `top: '50%'` centres the rail on the window, which sits over the viewport since the page switcher is a thin top row. Confirm focused-toolbar keyboard behaviour is unchanged (Enter/Space withheld, other shortcuts forwarded) by running `client/src/canvas-v2/CanvasV2App.test.ts` and `canvas-ui/src/use-canvas-session.test.ts`.

- [ ] **Step 5: Run all gates**

Run:
```bash
bun run typecheck && bun run test
cd plugins/canvas && npm run typecheck && npm test && npm run audit:quality:compare && bb plugin build .
cd ../../e2e && bunx playwright test --project=e2e tests/contracts.spec.ts
```
Expected: all green. `audit:quality:compare` must not regress the baseline; if it does, fix the flagged file rather than updating `quality-audit-baseline.json`.

- [ ] **Step 6: Commit**

```bash
git add client/src/canvas-v2/CanvasV2App.tsx plugins/canvas
git commit -m "feat(canvas): left tool rail in the web app and bb Canvas plugin"
```

---

### Task 7: Visual verification and doc close-out

**Files:**
- Modify: `docs/plans/2026-09-15-canvas-selection-toolbar-design.md` (Execution notes section)

- [ ] **Step 1: Screenshot both hosts**

Web app: `bin/dev up`, open `http://localhost:8080/?room=toolbar-check&engine=v2` (never `team`). bb plugin: follow the "Local canvas plugin install" notes (the laptop bb loads the plugin from the main checkout — check out this branch there, `npm ci`, `bb plugin reload canvas`). In each host capture: note selected (closed bar), note with colour popover open, geo selected, geo + arrow selected, note tool armed (rail flyout). Compare against the mockup's variant A + left rail.

- [ ] **Step 2: Check left-edge clashes**

In the plugin: the rail must not cover the page tab row, agent affordances (`AgentLayer`), or the AV dock. In the web app: must not cover `PageSwitcher`. Fix by adjusting the rail's `top`/`left` in the host only.

- [ ] **Step 3: Record execution notes**

Append `## Execution notes (2026-09-xx)` to the design doc: screenshots' paths, the RED outputs from Tasks 4 and 5, and any layout-table tweaks made during verification.

- [ ] **Step 4: Commit and open PR**

```bash
git add docs/plans
git commit -m "docs(plans): selection toolbar execution notes"
```

PR body lists the contracts added/extended (`style-popover-escape` new; `style-applies-to-selection`, `style-edit-arms-next-shape`, `armed-style-applies-to-created-shape` extended) and states Task 6's host-layout `ux-contract: none — <reason>` scope.
