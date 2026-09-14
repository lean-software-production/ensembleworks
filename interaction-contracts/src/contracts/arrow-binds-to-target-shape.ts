// Arrow-body task (interaction-contract obligation carried by CLAUDE.md's
// "Interaction contracts" section) — validator-required contract for the
// gesture arrow.ts's `bindingAt` exclusion fix (fab3f06) changed: drawing an
// arrow from empty canvas onto a shape must write an END binding to that
// shape at pointerup.
//
// LEVEL: browser (not fsm) — the arrow tool is a tool FSM driven through the
// real toolbar Arrow button; the FSM runner only drives 'select'/
// 'select+transform' (Contract.tool), with no path for the 'arrow' ToolId —
// same posture as line-creates-a-line-shape / draw-creates-a-draw-shape.
// canvas-editor/src/tools/arrow.test.ts already pins the tool's FSM-level
// behavior in isolation; this contract is the end-to-end tool->doc binding
// proof a real drag onto a real shape produces.
//
// DISCOVERING THE DRAWN ARROW'S ID: unlike line/draw, arrow.ts never emits
// SetSelection (see line-creates-a-line-shape's own module comment on this
// divergence) — so `selectedShapeIds()` cannot find it, AND an arrow renders
// no `[data-shape-kind]` DOM element at all (that is this task's OTHER fix —
// ShapeLayer.tsx now excludes arrow's body entirely, it is pure SVG
// overlay), so `paintOrder()` cannot find it either (confirmed live: it
// read back only the seeded target). This contract instead reads the new
// `listShapeIds()` (a doc-level listing, unlike DOM-scraped `paintOrder()`)
// and takes whichever id is NOT the seeded target — the only other shape
// that can exist in this scene.
//
// RED (Obligation 2/4): reverting arrow.ts's `bindingAt` to its pre-fab3f06
// form (`ctx.hitTestTopmost(worldPt)` with a post-hoc `hit === excludeId`
// bail, instead of threading `excludeId` into `hitTestTopmost` itself) makes
// the topmost hit at pointerup always resolve to the arrow's OWN
// in-progress shape (the cursor sits exactly on its own terminal), so
// `bindingAt` bails to "no binding" every time — `shapeBindingTarget(arrowId,
// 'end')` reads null instead of the target's id: a clean, specific
// assertion failure, never a locator error (the arrow itself still renders
// and paints).
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

// The toolbar button CanvasV2App.tsx renders for each tool
// (`data-canvas-v2-tool={btn.id}` — verified, TOOL_BUTTONS' `{ id: 'arrow',
// label: 'Arrow' }` entry).
const ARROW_TOOL_SELECTOR = '[data-canvas-v2-tool="arrow"]'

const TARGET_ID = 'shape:arrow-bind-target'

export const arrowBindsToTargetShape: Contract = {
  name: 'arrow-binds-to-target-shape',
  level: 'browser',
  when: 'at-end',
  // One seeded geo shape, well clear of the toolbar and of the arrow's own
  // start point below, so the drag's end unambiguously lands ON it.
  scene: () => [{ id: TARGET_ID, kind: 'geo', x: 500, y: 300, w: 120, h: 120 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Select the Arrow tool.
    { kind: 'down', at: { ref: 'element', selector: ARROW_TOOL_SELECTOR } },
    { kind: 'up' },
    // Drag from empty canvas onto the seeded shape's centre — a
    // threshold-clearing down/move.../up, ending exactly on the target.
    // The start point mirrors line-creates-a-line-shape's / draw-creates-a-
    // draw-shape's own (480, 520): empty canvas, well clear of the toolbar
    // (top) and any panel.
    { kind: 'down', at: { ref: 'point', x: 480, y: 520 } },
    { kind: 'move', at: { ref: 'shape', id: TARGET_ID, dx: 0, dy: 0 }, steps: 8 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const ids = obs.listShapeIds()
    const arrowId = ids.find((id) => id !== TARGET_ID)
    if (!arrowId) {
      return `expected a drawn arrow shape alongside the seeded target ${TARGET_ID}, got listShapeIds() ${JSON.stringify(ids)}`
    }
    const boundTo = obs.shapeBindingTarget(arrowId, 'end')
    if (boundTo !== TARGET_ID) {
      return `expected the drawn arrow ${arrowId}'s end binding to target ${TARGET_ID}, got ${JSON.stringify(boundTo)}`
    }
    return null
  },
}
