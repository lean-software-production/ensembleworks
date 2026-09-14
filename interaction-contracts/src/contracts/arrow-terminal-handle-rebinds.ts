// arrow-handles task (CLAUDE.md's "Interaction contracts" obligation) —
// dragging an EXISTING selected arrow's END terminal handle onto a shape
// must MOVE that terminal there AND bind it to that shape (tldraw parity:
// ArrowShapeUtil.tsx's `getHandles`/`PointingHandle`/`DraggingHandle`
// re-resolve the binding target live while a terminal handle drags).
//
// LEVEL: browser — same reason as arrow-mid-handle-bends: no arrow-tool
// lane and no way to seed a well-formed pre-existing arrow at fsm level
// (see that contract's own module comment). This one ALSO needs a real
// bindable TARGET shape, seeded via `scene()` — SceneShape IS enough for
// that (a plain geo box, same shape arrow-binds-to-target-shape seeds).
//
// HANDLE ADDRESSING: same as arrow-mid-handle-bends — no DOM element to
// locate (Overlay.tsx is pointer-events:none throughout), so this drags at
// the WORLD point it KNOWS the 'end' handle sits at: exactly `END`, the
// literal point the arrow was drawn to (an unbound end handle sits exactly
// on the arrow's own stored end point — arrow-handles.ts's `arrowHandles`
// reads it straight off `routeArrow`, which for an unbound terminal returns
// the arrow's own raw point unclipped).
//
// RED (teeth-checked live, before transform.ts's arrow-handle branch
// existed): a drag starting at `END` (a point in empty space, off any
// handle transform.ts's box-resize model would compute for a thin/zero-
// height arrow selection) falls through to select.ts's ordinary body-drag,
// translating the WHOLE arrow onto the target instead of re-terminating just
// the end — `shapeBindingTarget(arrowId, 'end')` reads null (never bound),
// a clean, specific assertion failure.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ARROW_TOOL_SELECTOR = '[data-canvas-v2-tool="arrow"]'
const SELECT_TOOL_SELECTOR = '[data-canvas-v2-tool="select"]'

const TARGET_ID = 'shape:arrow-rebind-target'
const START = { x: 300, y: 300 }
const END = { x: 500, y: 300 } // drawn well clear of the target below
const MID = { x: (START.x + END.x) / 2, y: (START.y + END.y) / 2 }

export const arrowTerminalHandleRebinds: Contract = {
  name: 'arrow-terminal-handle-rebinds',
  level: 'browser',
  when: 'at-end',
  // Clear of START/END/MID above and of the toolbar.
  scene: () => [{ id: TARGET_ID, kind: 'geo', x: 650, y: 500, w: 120, h: 120 }],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'element', selector: ARROW_TOOL_SELECTOR } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: START.x, y: START.y } },
    { kind: 'move', at: { ref: 'point', x: END.x, y: END.y }, steps: 4 },
    { kind: 'up' }, // unbound straight arrow, START -> END
    { kind: 'down', at: { ref: 'element', selector: SELECT_TOOL_SELECTOR } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: MID.x, y: MID.y } },
    { kind: 'up' }, // select the arrow (click on the line)
    // Grab the END terminal handle and drag it onto the target's centre.
    { kind: 'down', at: { ref: 'point', x: END.x, y: END.y } },
    { kind: 'move', at: { ref: 'shape', id: TARGET_ID, dx: 0, dy: 0 }, steps: 8 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const ids = obs.listShapeIds()
    const arrowId = ids.find((id) => id !== TARGET_ID)
    if (!arrowId) return `expected a drawn arrow alongside the seeded target ${TARGET_ID}, got listShapeIds() ${JSON.stringify(ids)}`
    const boundTo = obs.shapeBindingTarget(arrowId, 'end')
    if (boundTo !== TARGET_ID) {
      return `expected dragging the arrow's end handle onto ${TARGET_ID} to bind its end there, got shapeBindingTarget = ${JSON.stringify(boundTo)}`
    }
    return null
  },
}
