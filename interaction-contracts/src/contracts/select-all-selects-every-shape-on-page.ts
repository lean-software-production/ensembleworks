// Task keyboard/K4 (canvas-v2 polish batch — "Keyboard parity") — the
// interaction contract that discharges the Ctrl/Cmd+A branch this task adds
// to CanvasV2App.tsx's `handleGlobalShortcut`: with nothing selected,
// Ctrl+A (Playwright's `keyboard.press` normalizes Cmd+A/Ctrl+A per-OS —
// the browser runner drives Chromium under Linux/CI, where Ctrl is the
// accelerator key) selects every top-level shape on the current page —
// tldraw parity (actions.tsx's `select-all`, `kbd: 'cmd+a,ctrl+a'`).
//
// Browser-only: like Ctrl+C/X/V/D/Z/Y and the bracket reorder keys,
// Ctrl+A routes through `handleGlobalShortcut`, never a tool FSM.
//
// RED (teeth-checked live): with the Ctrl+A branch reverted (or absent),
// the keydown falls through to `dispatchToActiveTool` -- the select tool's
// FSM has no keydown handling for a modified key at all (tools/select.ts's
// onIdle keydown branch matches only ArrowUp/Down/Left/Right, see this
// task's OTHER new contract) -- so `selectedShapeIds()` stays empty,
// failing this contract's count assertion with a clean, specific message.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID_A = 'shape:select-all-a'
const ID_B = 'shape:select-all-b'

export const selectAllSelectsEveryShapeOnPage: Contract = {
  name: 'select-all-selects-every-shape-on-page',
  level: 'browser',
  when: 'at-end',
  scene: () => [
    { id: ID_A, kind: 'geo', x: 100, y: 100, w: 100, h: 100 },
    { id: ID_B, kind: 'geo', x: 300, y: 100, w: 100, h: 100 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    // Nothing selected/edited, so this keydown reaches
    // handleGlobalShortcut's Ctrl+A branch.
    { kind: 'key', key: 'a', modifiers: { ctrl: true } },
  ],
  check: (obs: Obs): string | null => {
    const ids = new Set(obs.selectedShapeIds())
    if (ids.size !== 2 || !ids.has(ID_A) || !ids.has(ID_B)) {
      return `expected Ctrl+A to select both seeded shapes (${JSON.stringify([ID_A, ID_B])}), got ${JSON.stringify([...ids])}`
    }
    return null
  },
}
