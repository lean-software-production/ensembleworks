// arrow-handles task (CLAUDE.md's "Interaction contracts" obligation) —
// dragging an EXISTING selected arrow's middle handle must write
// `props.bend`, matching tldraw's own virtual middle handle
// (ArrowShapeUtil.tsx's `getHandles`/`onArcMidpointHandleDrag`, checked
// against source — see canvas-editor/src/tools/arrow-handles.ts's
// `bendFromPoint` doc comment for the exact projection this ports, and the
// note there that v1 does NOT snap back to straight near the centre despite
// this task's own audit brief claiming otherwise).
//
// LEVEL: browser, not fsm — dragging the arrow's own mid handle requires a
// REAL arrow shape with a real routed chord, and the FSM runner's
// `seedScene` (canvas-editor/src/contracts/fsm-runner.ts) can only seed a
// `SceneShape` (x/y/w/h, no `props.end`) — there is no way to seed a
// well-formed arrow at fsm level, and no 'arrow' tool lane on that runner
// either (arrow-binds-to-target-shape's own module comment documents this
// same gap). This contract instead drives the REAL Arrow tool through
// CanvasV2App's toolbar, then the REAL select+transform composite, exactly
// like a user would.
//
// HANDLE ADDRESSING: the mid handle has no DOM element to locate by selector
// (Overlay.tsx's SVG is `pointer-events: none` throughout, by design — see
// its module header) — this contract instead drags at the WORLD point it
// KNOWS the mid handle sits at: for a freshly-drawn STRAIGHT arrow (bend 0),
// that is exactly the chord's midpoint, which is also where this contract
// clicks to SELECT the arrow in the first place (a point ON the line hits
// it, per geometry.ts's arrow hit-test margin).
//
// RED (teeth-checked live, before transform.ts's arrow-handle branch
// existed): the drag at the midpoint hits nothing (transform.ts's onIdle
// only ever computes box resize/rotate handles from the selection's
// worldBounds union — a thin/zero-height arrow's own bounds put no handle
// anywhere near the chord's midpoint), so the whole gesture falls through
// to select.ts's ordinary body-drag and TRANSLATES the arrow instead of
// bending it — `shapeStyle(arrowId, 'bend')` reads `null` (never written),
// a clean, specific assertion failure.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ARROW_TOOL_SELECTOR = '[data-canvas-v2-tool="arrow"]'
const SELECT_TOOL_SELECTOR = '[data-canvas-v2-tool="select"]'

// World == screen here (fresh room, identity camera) — same convention
// arrow-binds-to-target-shape's own literal points rely on.
const START = { x: 300, y: 300 }
const END = { x: 500, y: 300 }
const MID = { x: (START.x + END.x) / 2, y: (START.y + END.y) / 2 } // (400, 300)
const DRAG_TO = { x: MID.x, y: MID.y + 40 } // pull the midpoint DOWN 40 world units

export const arrowMidHandleBends: Contract = {
  name: 'arrow-mid-handle-bends',
  level: 'browser',
  when: 'at-end',
  gesture: (_rng: Rng): GestureOp[] => [
    // Draw a straight, unbound arrow from START to END.
    { kind: 'down', at: { ref: 'element', selector: ARROW_TOOL_SELECTOR } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: START.x, y: START.y } },
    { kind: 'move', at: { ref: 'point', x: END.x, y: END.y }, steps: 4 },
    { kind: 'up' },
    // Switch to Select and click ON the line (its own midpoint) to select it.
    { kind: 'down', at: { ref: 'element', selector: SELECT_TOOL_SELECTOR } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: MID.x, y: MID.y } },
    { kind: 'up' },
    // Grab the mid handle (same point — bend is still 0) and drag it down.
    { kind: 'down', at: { ref: 'point', x: MID.x, y: MID.y } },
    { kind: 'move', at: { ref: 'point', x: DRAG_TO.x, y: DRAG_TO.y }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const ids = obs.listShapeIds()
    if (ids.length !== 1) return `expected exactly one drawn arrow, got listShapeIds() ${JSON.stringify(ids)}`
    const arrowId = ids[0]!
    const bend = obs.shapeStyle(arrowId, 'bend')
    if (typeof bend !== 'number' || Math.abs(bend - 40) > 2) {
      return `expected dragging the mid handle down 40 world units to set props.bend to ~40, got shapeStyle(arrowId, 'bend') = ${JSON.stringify(bend)}`
    }
    return null
  },
}
