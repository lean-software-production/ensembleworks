// arrow-handles task (gap 3, CLAUDE.md's "Interaction contracts" obligation)
// — dragging a selected arrow's terminal handle over a prospective binding
// target previews it via SetHover WHILE STILL DRAGGING, not just resolved
// silently at release (tldraw parity: ArrowHintOverlayUtil is live during a
// terminal drag too, per the audit brief's v1 citation). Same
// draw-then-select-then-drag-the-handle shape as arrow-terminal-handle-
// rebinds (this file's sibling) — see that contract's own module comment
// for why this needs the browser lane (no 'arrow' tool lane, no way to
// seed a well-formed pre-existing arrow, at fsm level).
//
// GESTURE ENDS MID-DRAG, DELIBERATELY (no trailing 'up' op, unlike arrow-
// terminal-handle-rebinds): SetHover is TRANSIENT — it's cleared back to
// null the instant the gesture completes (transform.ts's
// onDraggingArrowTerminal pointerup branch, and arrow.ts's own pointerup
// branch). Ending the gesture with the pointer still down (mid-drag) is
// what lets the check observe the LIVE preview value instead of racing
// (and always losing to) its own release-time clear.
//
// RED (teeth-checked live, transform.ts's onPointingArrow/
// onDraggingArrowTerminal SetHover emissions commented out): the terminal
// visibly moved onto the target (a later re-run with 'up' restored still
// binds correctly — arrow-terminal-handle-rebinds proves that separately),
// but hoveredShapeId() read null throughout the drag — nothing ever
// previewed the target while the gesture was still in flight.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ARROW_TOOL_SELECTOR = '[data-canvas-tool="arrow"]'
const SELECT_TOOL_SELECTOR = '[data-canvas-tool="select"]'

const TARGET_ID = 'shape:arrow-hover-drag-target'
const START = { x: 300, y: 300 }
const END = { x: 500, y: 300 }
const MID = { x: (START.x + END.x) / 2, y: (START.y + END.y) / 2 }

export const arrowHandleDragPreviewsHover: Contract = {
  name: 'arrow-handle-drag-previews-hover',
  level: 'browser',
  when: 'at-end',
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
    // Grab the END terminal handle and drag it onto the target — no
    // trailing 'up': the gesture ends MID-DRAG (see module header).
    { kind: 'down', at: { ref: 'point', x: END.x, y: END.y } },
    { kind: 'move', at: { ref: 'shape', id: TARGET_ID, dx: 0, dy: 0 }, steps: 8 },
  ],
  check: (obs: Obs): string | null => {
    const hovered = obs.hoveredShapeId()
    if (hovered !== TARGET_ID) {
      return `expected dragging the arrow's end handle onto ${TARGET_ID} to preview it via SetHover WHILE STILL DRAGGING (gesture ends mid-drag, no release), got hoveredShapeId() = ${JSON.stringify(hovered)}`
    }
    return null
  },
}
