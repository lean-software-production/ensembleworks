// Task keyboard/K1 (canvas-v2 polish batch — "Keyboard parity") — the
// interaction contract that discharges the arrow-key nudge branch added to
// tools/select.ts's `onIdle`: with a shape selected, a bare ArrowRight
// keydown moves it by NUDGE_PX (1) world unit, and a Shift+ArrowRight
// keydown moves it a further SHIFT_NUDGE_PX (10) — pinned to
// e2e/goldens/feel.json's captured tldraw numbers (nudgePx/shiftNudgePx),
// same golden this task's client-level e2e feel.spec.ts already checks
// against the OLD (tldraw) engine.
//
// FSM-level (not browser-only): the nudge branch lives entirely inside the
// select tool's own FSM (tools/select.ts), which the FSM runner drives
// directly via script.ts's `.key()` builder — no session/DOM plumbing
// is exercised by this behavior, unlike Ctrl+A/tool-switch shortcuts (which
// route through canvas-ui's useCanvasSession shortcut path and so can only be
// proven at the browser level — see this task's OTHER new contract for
// those).
//
// RED (teeth-checked live, select.test.ts's own unit coverage first): with
// the keydown branch reverted (onIdle falls through to its pre-existing
// `return { state, intents: [] }` default for every event it doesn't
// explicitly handle), ArrowRight/Shift+ArrowRight are silently swallowed —
// shapeDisplacement(ID) stays {dx:0, dy:0} the whole gesture, so `check`
// fails on the cumulative-displacement assertion with a clean, specific
// message (never a locator/hit-test error — the seeded shape is always
// selected first via a real click).
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:nudge-target'
const NUDGE_PX = 1
const SHIFT_NUDGE_PX = 10

export const arrowNudgeMovesSelection: Contract = {
  name: 'arrow-nudge-moves-selection',
  level: 'fsm',
  tool: 'select',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'geo', x: 200, y: 200, w: 100, h: 100 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Click (no drag) on the shape to select it -- a bare down/up with no
    // move between them stays under select.ts's own crossedThreshold check.
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'up' },
    // Bare ArrowRight: +1 world unit in x.
    { kind: 'key', key: 'ArrowRight' },
    // Shift+ArrowRight: +10 MORE world units in x (cumulative +11 total).
    { kind: 'key', key: 'ArrowRight', modifiers: { shift: true } },
  ],
  check: (obs: Obs): string | null => {
    const { dx, dy } = obs.shapeDisplacement(ID)
    const expectedDx = NUDGE_PX + SHIFT_NUDGE_PX
    if (dx !== expectedDx || dy !== 0) {
      return `expected shapeDisplacement(${JSON.stringify(ID)}) === {dx:${expectedDx}, dy:0} after ArrowRight then Shift+ArrowRight (feel.json's nudgePx=${NUDGE_PX}/shiftNudgePx=${SHIFT_NUDGE_PX}), got {dx:${dx}, dy:${dy}}`
    }
    return null
  },
}
