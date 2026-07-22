// Task K (docs/plans/2026-07-22-canvas-v2-draw.md, D-6) — the browser
// contract that discharges the presence gate for the whole draw sub-cycle
// (T1's tools/, R1's canvas-react/, W1's client/canvas-v2/ gated changes):
// click the Draw button, draw a freehand stroke on empty canvas, and assert
// a new shape of kind 'draw' now exists and is selected.
//
// LEVEL: browser (not fsm) — the pen tool is a tool FSM driven through the
// real toolbar Draw button; the FSM runner only drives 'select'/
// 'select+transform' (Contract.tool), with no path for the 'draw' ToolId.
// T1's own unit tests already pin the tool's FSM-level behavior; this
// contract is the end-to-end tool→doc creation proof.
//
// DISCOVERING THE CREATED SHAPE'S ID: same pattern as
// armed-style-applies-to-created-shape — the drawn stroke's id is minted
// from crypto-random (canvas-editor/src/tools/draw.ts's makeId, mirroring
// create.ts), so this contract cannot predict it up front. It rides the pen
// tool's own auto-selection (T1 emits SetSelection([id]) on both pointerdown
// and pointerup) via `selectedShapeIds()`, then reuses the new `shapeKind`
// Obs (Task H) for the kind assertion — `shapeStyle` cannot answer this
// (kind is an envelope field, not a props value).
//
// EMPTY SCENE, DELIBERATELY: no seeded shapes — the drawn stroke must be the
// only shape alive when `check` runs, so `shapeCount() === 1` is itself part
// of the assertion that a shape was really created.
//
// RED (Obligation 2/4 — see the plan's K task for the full discipline): the
// genuine, clean RED is reached by reverting W1's toolset entry
// `draw: createDrawTool(ctx)` to a no-op — the Draw button still renders (the
// `element` anchor resolves and the click succeeds), but drawing produces no
// shape, so `shapeCount()` stays 0 and `selectedShapeIds()` stays `[]`: a
// clean ASSERTION failure, never a locator error. Reaching the RED by
// removing the Draw button instead would throw a locator/boundingBox error —
// a FAKE red that proves nothing about this contract's own assertions.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

// The toolbar button CanvasV2App.tsx renders for each tool
// (`data-canvas-v2-tool={btn.id}` — verified, W1's TOOL_BUTTONS entry
// `{ id: 'draw', label: 'Draw' }`).
const DRAW_TOOL_SELECTOR = '[data-canvas-v2-tool="draw"]'

export const drawCreatesADrawShape: Contract = {
  name: 'draw-creates-a-draw-shape',
  level: 'browser',
  when: 'at-end',
  // No seeded shapes — see module header's EMPTY SCENE note.
  scene: () => [],
  gesture: (_rng: Rng): GestureOp[] => [
    // Select the Draw tool.
    { kind: 'down', at: { ref: 'element', selector: DRAW_TOOL_SELECTOR } },
    { kind: 'up' },
    // A freehand down/move.../up path on empty canvas, well clear of the
    // toolbar (top) and any panel.
    { kind: 'down', at: { ref: 'point', x: 480, y: 520 } },
    { kind: 'move', at: { ref: 'point', x: 640, y: 600 }, steps: 8 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const ids = obs.selectedShapeIds()
    if (ids.length !== 1) {
      return `expected exactly one shape after drawing, got ${JSON.stringify(ids)}`
    }
    if (obs.shapeCount() !== 1) {
      return `expected shapeCount 1 after one stroke, got ${obs.shapeCount()}`
    }
    const kind = obs.shapeKind(ids[0]!)
    if (kind !== 'draw') {
      return `expected the created shape ${ids[0]} to be kind 'draw', got ${JSON.stringify(kind)}`
    }
    return null
  },
}
