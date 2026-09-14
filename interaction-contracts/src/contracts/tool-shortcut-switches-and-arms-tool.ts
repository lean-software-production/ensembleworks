// Task keyboard/K3 (canvas-v2 polish batch — "Keyboard parity") — the
// interaction contract that discharges the tool-shortcut keydown branch
// this task added to CanvasV2App.tsx's `handleGlobalShortcut` (now
// canvas-editor's `resolveShortcut`, run by canvas-ui's useCanvasSession)
// (canvas-editor/src/session/tool-shortcut.ts's pure `toolShortcut` decision):
// pressing 'r' (with nothing focused in a text field) must switch the
// active tool to 'geo' AND arm the geo variant to 'rectangle' (the same
// `SetNextStyle` path StylePanel's armed mode already uses, Task AS3) —
// tldraw parity (useTools.tsx: `kbd: 'r'` on the rectangle geo entry calls
// BOTH `setStyleForNextShapes(GeoShapeGeoStyle, 'rectangle')` and
// `setCurrentTool('geo')`).
//
// Proven END-TO-END, not by inspecting `activeToolId` directly (no `Obs`
// method exposes it, and adding one purely to prove a toolbar click would
// duplicate `armed-style-applies-to-created-shape`'s own established
// pattern): press 'r', then click empty canvas (a bare down/up -- no drag,
// so the create tool's click-not-drag path fires) -- if the shortcut never
// switched the tool, the SELECT tool (still active) would just marquee/
// deselect on that click and no shape would be created at all.
//
// Browser-only: like every other global keydown shortcut
// (Escape/Delete/undo/redo/clipboard/reorder), this routes through
// canvas-ui's useCanvasSession shortcut path, never a tool FSM directly -- the FSM runner drives
// tool FSMs only.
//
// RED (teeth-checked live): with the tool-shortcut branch reverted (or
// `toolShortcut` itself returning null unconditionally), 'r' does nothing --
// the select tool stays active, the click on empty canvas resolves as a
// deselect (select.ts's onPointing "click on empty canvas" branch), and NO
// shape is created -- `shapeCount()` stays 0, failing this contract's count
// assertion with a clean, specific message (never a locator-not-found
// error).
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

export const toolShortcutSwitchesAndArmsTool: Contract = {
  name: 'tool-shortcut-switches-and-arms-tool',
  level: 'browser',
  when: 'at-end',
  scene: () => [],
  gesture: (_rng: Rng): GestureOp[] => [
    // No text field is focused (an empty scene starts with nothing
    // selected/edited), so this bare 'r' keydown reaches
    // the session's tool-shortcut command.
    { kind: 'key', key: 'r' },
    // Click (not drag) on empty canvas, well clear of the toolbar.
    { kind: 'down', at: { ref: 'point', x: 500, y: 560 } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const ids = obs.selectedShapeIds()
    if (ids.length !== 1) {
      return `expected exactly one shape selected after pressing 'r' then clicking empty canvas (the create tool auto-selects its new shape), got ${JSON.stringify(ids)} -- 'r' may not have switched the active tool to 'geo'`
    }
    const id = ids[0]!
    const kind = obs.shapeKind(id)
    if (kind !== 'geo') {
      return `expected the shape created after pressing 'r' to be kind 'geo', got ${JSON.stringify(kind)}`
    }
    const geo = obs.shapeStyle(id, 'geo')
    if (geo !== 'rectangle') {
      return `expected 'r' to also arm the geo variant to 'rectangle' (SetNextStyle, tldraw parity), got ${JSON.stringify(geo)}`
    }
    return null
  },
}
