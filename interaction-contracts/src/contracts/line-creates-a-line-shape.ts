// Task K (docs/plans/2026-07-22-canvas-v2-line.md, D-6) — the browser
// contract that discharges the presence gate for the whole line sub-cycle
// (T1's tools/, R1's canvas-react/, W1's client/canvas-v2/ gated changes):
// click the Line button, drag on empty canvas, and assert a new shape of
// kind 'line' now exists and is selected.
//
// LEVEL: browser (not fsm) — the line tool is a tool FSM driven through the
// real toolbar Line button; the FSM runner only drives 'select'/
// 'select+transform' (Contract.tool), with no path for the 'line' ToolId.
// T1's own unit tests already pin the tool's FSM-level behavior; this
// contract is the end-to-end tool→doc creation proof.
//
// DISCOVERING THE CREATED SHAPE'S ID: same pattern as
// draw-creates-a-draw-shape — the drawn line's id is minted from
// crypto-random (canvas-editor/src/tools/line.ts's makeId, mirroring
// arrow.ts/draw.ts/create.ts), so this contract cannot predict it up front.
// It rides the line tool's own auto-selection (T1 emits SetSelection([id])
// on both the pointing->drawing transition and pointerup — DIVERGING from
// arrow, which never auto-selects, per D-4/D-6's ground-truth correction)
// via `selectedShapeIds()`, then reuses the existing `shapeKind` Obs for the
// kind assertion — no new Obs added this cycle.
//
// EMPTY SCENE, DELIBERATELY: no seeded shapes — the drawn line must be the
// only shape alive when `check` runs, so `shapeCount() === 1` is itself part
// of the assertion that a shape was really created.
//
// RED (Obligation 2/4 — see the plan's K task for the full discipline): the
// genuine, clean RED is reached by reverting W1's toolset entry
// `line: createLineTool(ctx)` to a no-op (e.g. `line: tools.hand`) — the
// Line button still renders (the `element` anchor resolves and the click
// succeeds), but dragging produces no shape, so `shapeCount()` stays 0 and
// `selectedShapeIds()` stays `[]`: a clean ASSERTION failure, never a
// locator error. Reaching the RED by removing the Line button instead would
// throw a locator/boundingBox error — a FAKE red that proves nothing about
// this contract's own assertions.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

// The toolbar button CanvasV2App.tsx renders for each tool
// (`data-canvas-v2-tool={btn.id}` — verified, W1's TOOL_BUTTONS entry
// `{ id: 'line', label: 'Line' }`).
const LINE_TOOL_SELECTOR = '[data-canvas-v2-tool="line"]'

export const lineCreatesALineShape: Contract = {
  name: 'line-creates-a-line-shape',
  level: 'browser',
  when: 'at-end',
  // No seeded shapes — see module header's EMPTY SCENE note.
  scene: () => [],
  gesture: (_rng: Rng): GestureOp[] => [
    // Select the Line tool.
    { kind: 'down', at: { ref: 'element', selector: LINE_TOOL_SELECTOR } },
    { kind: 'up' },
    // A threshold-clearing down/move.../up drag on empty canvas, well clear
    // of the toolbar (top) and any panel.
    { kind: 'down', at: { ref: 'point', x: 480, y: 520 } },
    { kind: 'move', at: { ref: 'point', x: 640, y: 600 }, steps: 8 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const ids = obs.selectedShapeIds()
    if (ids.length !== 1) {
      return `expected exactly one shape after drawing a line, got ${JSON.stringify(ids)}`
    }
    if (obs.shapeCount() !== 1) {
      return `expected shapeCount 1 after one line, got ${obs.shapeCount()}`
    }
    const kind = obs.shapeKind(ids[0]!)
    if (kind !== 'line') {
      return `expected the created shape ${ids[0]} to be kind 'line', got ${JSON.stringify(kind)}`
    }
    return null
  },
}
