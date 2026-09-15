# Canvas v2 — compact selection toolbar and tool rail (design)

Status: approved 2026-09-15 — variant A (light pill) + left tool rail, one PR.
Clickable mockup: [2026-09-15-canvas-selection-toolbar-mockup.html](2026-09-15-canvas-selection-toolbar-mockup.html)
(open in a browser; "A · Light pill" + "Left rail" is the chosen combination).

## Problem

Selecting a shape in a v2 room (web app v2 mount and the bb Canvas plugin,
both via `canvas-ui`'s `StylePanel`) opens a panel that stacks every relevant
style axis as a labelled row with every value visible. A single sticky note
produces a ~325×205px panel (13 colour swatches, 4 sizes, 4 fonts, 3 + 3
align buttons, 5 opacity stops). A geo+arrow+text selection is worse: the
panel takes the *union* of axes and needs a 480px height cap, internal scroll
and a capture-phase wheel listener. The panel hides neighbouring shapes and
arrows and feels intrusive for the common case of "select, maybe recolour,
move on".

## What the market leaders do

Compared from screenshots of FigJam, Miro and Mural (2026-09-15):

| | FigJam | Miro | Mural |
|---|---|---|---|
| Selection bar | one row, dark pill | one row, light | one row, light |
| Position | above selection | flips above/below | above selection |
| Section labels | none (tooltips) | none (tooltips) | none (tooltips) |
| Colour | current dot + ▾ | current dot | current swatch |
| Font / size | `Aa ▾`, `Small ▾` | `Aa`, `Auto ⌃⌄`, `M` | `A−` `A+` steppers |
| Align | — | single icon | single icon |
| Rare options | hidden | `⋮` | `⋮` |
| Object actions in bar | no (author toggle only) | lock, duplicate, delete, tag… | lock, tag, link… |
| Per-kind bar contents | yes | yes | yes |
| Creation toolbar | bottom centre | left vertical rail | left vertical rail |
| Armed-tool options | — | flyout beside rail | docked panel beside rail |

Shared pattern: **one compact row next to the selection, one trigger per
pick-one-of-N axis showing its current value, values in a small popover,
rare axes behind an overflow button, contents tailored to the selected
kind.** At rest this is roughly a fifth of our panel's area.

## Decisions

1. **Selection style panel becomes a one-row toolbar** of current-value
   triggers with popovers. Light theme (existing `UI_VARS`), no section
   labels, `title`/`aria-label` tooltips.
2. **Style-only.** No object actions (lock/duplicate/delete) in this pass;
   the context menu covers them. A later "actions" group can be appended.
3. **Per-kind layout table** replaces the generic `AXIS_GROUPS` stacking.
4. **Mixed selections show the intersection** of the kinds' axes, not the
   union.
5. **One PR, two parts** (bundled at owner's request, 2026-09-15). Land
   Part 1 commits first so the branch is reviewable in order:
   - **Part 1 — selection toolbar** (selection mode of `StylePanel`).
   - **Part 2 — vertical tool rail + armed flyout**: `Toolbar` moves to a left
     vertical rail; armed-mode style options become a flyout beside the
     active tool button, replacing the floating top-centre armed panel.
6. **Variant A chosen** over dark pill (FigJam-style) and hybrid inline
   colours, after reviewing the mockup.

The per-kind layout below is a first guess, explicitly expected to be tuned
after dogfooding.

## Per-kind layout table

A pure declarative table in `canvas-editor/src/session/` next to
`STYLE_AXES_BY_KIND` (no DOM, unit-testable), e.g. `style-toolbar-layout.ts`:

```ts
type ToolbarSlot =
  | { kind: 'popover'; id: string; axes: readonly StyleAxis[] } // trigger shows first axis's current value
  | { kind: 'overflow'; axes: readonly StyleAxis[] }            // the ⋯ button

const TOOLBAR_LAYOUT_BY_KIND: Record<StyleKind, readonly ToolbarSlot[]>
function toolbarSlots(kinds: ReadonlySet<StyleKind>): readonly ToolbarSlot[]
```

Initial layouts:

- **note**: `colour` · `font` · `size` · `align` (align + verticalAlign) · `⋯` (opacity)
- **text**: `colour` · `font` · `size` · `align` (textAlign) · `⋯` (opacity)
- **geo**: `shape` (geo) · `colour` · `fill` · `dash` · `align` (align + verticalAlign) · `⋯` (size, font, opacity)
- **arrow**: `colour` · `dash` · `arrowheads` (arrowheadStart + arrowheadEnd) · `⋯` (size, fill, font, opacity)

`toolbarSlots` for a mixed selection: take the first selected kind's slot
order, drop axes not relevant to *every* kind, drop empty slots, keep `⋯`
last. Opacity is on every kind so the bar is never empty for a styled
selection. Invariant (unit-tested): for a single kind, the union of axes
across its slots equals `relevantAxes` for that kind — nothing becomes
unreachable, nothing is invented.

Changing `relevantAxes` itself from union to intersection is **not** part of
this; only the toolbar's slot resolution intersects. (`relevantAxes` has
other callers — style memory and the armed panel.)

## Part 1 — selection toolbar (`canvas-ui`)

### Rendering

- `StylePanel` selection branch renders a single flex row (height ~36px):
  one trigger button per slot, thin dividers between slots, `⋯` last.
- Trigger contents per axis: colour → filled dot; font → `Aa` in that font;
  size → `S`/`M`/`L`/`XL`; align → current align icon; geo → current
  `GeoIcon`; fill/dash/arrowheads → existing `style-icons.tsx` glyph. `mixed`
  shows a neutral "mixed" glyph (e.g. striped dot / `–`).
- Popover: a small panel attached to its trigger, reusing today's `AxisRow`
  value buttons (swatches, icon buttons, opacity stops) almost unchanged. A
  multi-axis slot (align h+v, arrowheads start+end) renders one compact row
  per axis. Labels only inside popovers where a slot holds more than one
  axis.
- One popover open at a time. Opening another trigger swaps it.

### Behaviour

- Click trigger: toggle its popover. Click a value: apply (existing
  `onStyleChange`, Ctrl/Cmd "this shape only" preserved) and **keep the
  popover open** (lets you try colours; matches Miro). Click outside,
  `Escape`, selection change, or gesture start: close popover.
- `Escape` with a popover open closes the popover only; it must not also
  clear the selection. Routed through the existing `keyboard-scope.ts`
  focused-chrome rules.
- Keyboard: triggers are focusable buttons; `Enter`/`Space` opens, arrow
  keys move within popover values, `Escape` returns focus to trigger.

### Positioning

- Bar anchored above the selection, flipping below when there isn't room —
  existing `clampPanelPosition`/`avoidAnchorOverlap`, with `PANEL_MAX_WIDTH`/
  `PANEL_MAX_HEIGHT` replaced by the bar's real bounded size (width bounded
  by max slot count × trigger width; height is one row).
- Popover opens on the side of the bar away from the selection and is
  edge-clamped with the same pure helper.
- With a one-row bar, `maxHeight`/`overflowY`/the capture-phase wheel
  listener are no longer needed for the bar. Keep them only if a popover can
  overflow (the geo `shape` popover with ~20 values is the candidate — lay
  it out as a grid that fits instead).
- Keep `pointer-events: none` on containers, `auto` on controls, and
  `stopPropagation` on pointer down/up — the regressions those comments
  document still apply.

### Stable DOM hooks

- Bar: keep `data-testid="ew-style-panel"`, `data-style-panel-mode="selection"`.
- Trigger: `data-style-trigger="<slot id>"`, `aria-expanded`,
  `aria-haspopup`.
- Popover: `data-style-popover="<slot id>"`; inside it, today's
  `data-style-control="<axis>"` / `data-style-value` / `data-current` /
  `aria-pressed` unchanged. Existing selectors keep resolving once the
  popover is open.

## Part 2 — vertical tool rail + armed flyout

- `Toolbar` renders as a vertical rail on the left edge (both hosts),
  vertically centred, same tool set and icons.
- Arming a style-bearing tool shows its style options as a flyout to the
  right of the active rail button, using the same slot table
  (`toolbarSlots({kindForTool(tool)})`) and the same popover components —
  but in flyout form the slots render expanded (values visible), since the
  flyout's whole purpose is choosing the next shape's style.
- Replaces `ARMED_PANEL_POSITION`; keeps `data-style-panel-mode="armed"` and
  `onArmStyle` wiring.
- Check for clashes with each host's own left-edge chrome (bb plugin
  sidebar, web app page menu) before landing; the design doc should get a
  CHANGE NOTE if the rail must move.

## Interaction contracts

Both parts touch `canvas-ui/src/` so the obligations in CLAUDE.md apply.

Part 1:

- **Extend** `style-applies-to-selection` and `style-edit-arms-next-shape`:
  gesture becomes select → click `[data-style-trigger="colour"]` → click the
  blue swatch. Check unchanged.
- **New** `style-popover-dismiss`: select a shape, open the colour popover,
  press `Escape`; invariant: popover closed **and** selection unchanged.
  (Guards the Escape-clears-selection trap.)
- **New** `style-toolbar-intersection`: select a geo + an arrow; invariant:
  no trigger exists for an axis irrelevant to either (e.g. no `align`,
  no `shape`). Needs an `Obs` for "style trigger present" — implement in
  both `fsm-runner.ts` (throw-stub: DOM-only) and `e2e/lib/contracts.ts`.
- RED first against current code for each, verbatim failure recorded. The
  extended contracts' new trigger click has no element on current code, so
  their RED would be a locator failure, not an assertion failure; land the
  `data-style-trigger` hook (a no-op trigger) first so RED is a genuine
  "colour stayed unset" assertion, same approach Task P2/P3 used.
- Update `e2e/tests/context-menu.spec.ts`, `locked-shape.spec.ts`; retire or
  rewrite `style-panel-scroll.spec.ts` if the wheel listener goes.

Part 2:

- **Extend** `armed-style-applies-to-created-shape`: click rail tool → click
  blue in flyout → create shape → check colour.
- **New** `rail-flyout-follows-tool`: arm note then geo; invariant: exactly
  one flyout, anchored to the geo button, showing geo's slots.

## Testing

- `canvas-editor`: unit tests for `toolbarSlots` (per-kind layout, the
  slots-cover-relevantAxes invariant, mixed intersection, `⋯` always last).
- `canvas-ui`: `StylePanel.test.ts` cases for trigger rendering per kind,
  mixed glyph, popover open/close state; `StylePanel.position.test.ts` for
  bar + popover clamping.
- Contracts above, RED then GREEN, reviewer re-verifies by reverting.
- Plugin: `npm run typecheck`, `npm test`, `npm run audit:quality:compare`,
  `bb plugin build .` in `plugins/canvas`.
- Visual check in both hosts with screenshots of note, geo, arrow, mixed.

## Out of scope

- Object actions in the bar (lock/duplicate/delete/tag).
- Rich-text marks (bold/strike/link/list) — canvas-model has none.
- Legacy tldraw `ContextualStylePanel` in `client/src/chrome/`.
- Changing `relevantAxes` semantics.
- Font size steppers (Mural's `A−`/`A+`) — revisit after dogfooding.

## Execution notes (2026-09-15)

### Visual check (web app, v2 engine, Playwright 1280x720)

Screenshots in `~/.bb/thread-storage/thr_jrjdkpxprn/screenshots/`. They were
taken with a throwaway spec against the e2e webServer and the room ids
`vis-*`. The spec was not committed.

- `01-note-closed.png`: the pill (colour, font, size `M`, align, `⋯`) sits
  centred about 8px above the note. It does not overlap the note.
- `02-note-colour-open.png`: the colour popover opens upward, centred on its
  trigger, and stays clear of the note. The 13th swatch (white) wraps onto a
  row of its own.
- `03-geo.png`: the geo bar (shape, colour, fill, dash, align, `⋯`) sits above
  the resize handles.
- `04-geo-arrow-mixed.png`: the shapes were a geo plus a seeded `arrow`
  (`props.end`). The bar shows only the shared slots (colour, fill, dash,
  `⋯`), centred over the union bounds.
- `05-note-more-open.png`: `⋯` opens an opacity slider above the bar. The
  slider has no label.
- `06-armed-note.png`: the note tool is active on the rail. Its flyout is to
  the right, centred on the rail (see the Task 6 ruling), and inside the
  viewport.
- `07-armed-geo.png`: the geo flyout is about 488px tall (y 117 to 604) and
  fits in the viewport.
- `08-short-window-armed-geo.png` (1280x420): the flyout is capped and
  scrolls (the `Size` row is cut at the bottom edge). **Defect:** its top edge
  (y≈13) covers the page-switcher row, including the tab and `+`. The rail
  itself (y≈52) is clear of that row.
- `09-note-near-top.png`: the note is at y=10. The bar flips below it and the
  colour popover opens further down, away from the note.

At 720px the rail (y 201 to 519) is clear of the page switcher. No bar
overlapped its selection, and nothing was clipped except in 08.

### RED evidence

- Task 4, `style-popover-escape` against unfixed code:
  `Error: expected Escape to close the style popover, but "color" is still open`.
  The reviewer's revert of the `onKeyDown` handler reproduced the same error.
- Task 5, `armed-style-applies-to-created-shape` migrated to the rail flyout,
  before the implementation:
  `Error: locator.boundingBox: Test timeout of 60000ms exceeded.` while
  `waiting for locator('[data-canvas-toolbar] [data-style-panel-mode="armed"] [data-style-control="color"] [data-style-value="blue"]')`.
  The brief expected "has no bounding box", but the element did not exist at
  all, so the locator waited until the timeout. The cause is the same.

### Controller rulings

- Popover max size is 200x220 and the flip headroom is 284px. The arrow `⋯`
  popover measures about 206px, so the brief's 180 was too small.
- The Escape focus return looks up the trigger inside its own panel
  (`e.currentTarget.querySelector`), not by a page-global id, so two canvases
  on one page (bb split panes) don't collide.
- The interim horizontal flyout used `side:'end'` because measured e2e
  collisions ruled out placing it below. Task 6 removed it once both hosts
  moved to the vertical rail.
- The rail flyout is centred on the rail, not level with the active button,
  with a `calc(100cqh - 24px)` cap and scroll. Top-edge anchoring can't be
  capped in pure CSS. Screenshot 08 shows this is the cause of the
  short-window overlap with the page-switcher row.
- The e2e cancellation drag moved from (200,500) to (500,500) because the
  armed-arrow flyout covers x 61 to 281.
- Test regexes don't depend on attribute order. The Task 5 WIP commits were
  squashed with `git reset --soft`.

Plugin visual check in a short bb split pane: pending owner.
