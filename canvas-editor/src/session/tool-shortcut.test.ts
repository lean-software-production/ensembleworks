// Run: bun src/session/tool-shortcut.test.ts
//
// The pure key -> tool-switch DECISION (Task keyboard/K3) -- DOM-free and
// unit-testable, mirroring clipboard-shortcut.test.ts/reorder-shortcut.test.ts.
// session/keyboard.ts's `resolveShortcut` is the only caller; canvas-ui's
// useCanvasSession runs the resulting command: `selectTool(hit.toolId)` plus, when `armGeo` is set, a `SetNextStyle`
// dispatch over `{ geo: hit.armGeo }` (AS3's armed-style path). The actual
// end-to-end "press 'r' -> the geo tool activates and arms rectangle" is
// proved by the `tool-shortcut-switches-and-arms-tool` interaction contract,
// not here.
import assert from 'node:assert/strict'
import { TOOL_SHORTCUT_LABEL, toolShortcut } from './tool-shortcut.js'

const MODS = { shift: false, alt: false, ctrl: false, meta: false }

function key(k: string, mods: Partial<typeof MODS> = {}): Parameters<typeof toolShortcut>[0] {
	return { type: 'keydown', key: k, modifiers: { ...MODS, ...mods }, t: 0 }
}

// 1. Every tldraw-parity single-letter shortcut v2 supports a tool for.
assert.deepEqual(toolShortcut(key('v'), null), { toolId: 'select' }, "'v' -> select")
assert.deepEqual(toolShortcut(key('h'), null), { toolId: 'hand' }, "'h' -> hand")
assert.deepEqual(toolShortcut(key('n'), null), { toolId: 'note' }, "'n' -> note")
assert.deepEqual(toolShortcut(key('t'), null), { toolId: 'text' }, "'t' -> text")
assert.deepEqual(toolShortcut(key('a'), null), { toolId: 'arrow' }, "'a' -> arrow")
assert.deepEqual(toolShortcut(key('f'), null), { toolId: 'frame' }, "'f' -> frame")
assert.deepEqual(toolShortcut(key('d'), null), { toolId: 'draw' }, "'d' -> draw")
assert.deepEqual(toolShortcut(key('l'), null), { toolId: 'line' }, "'l' -> line")

// 2. 'r'/'o' both select the geo tool but arm DIFFERENT geo variants
//    (rectangle/ellipse) -- tldraw parity (useTools.tsx).
assert.deepEqual(toolShortcut(key('r'), null), { toolId: 'geo', armGeo: 'rectangle' }, "'r' -> geo armed rectangle")
assert.deepEqual(toolShortcut(key('o'), null), { toolId: 'geo', armGeo: 'ellipse' }, "'o' -> geo armed ellipse")

// 3. Case-insensitive (Shift+letter still selects the tool -- undo/redo's
//    own toLowerCase() precedent).
assert.deepEqual(toolShortcut(key('R'), null), { toolId: 'geo', armGeo: 'rectangle' }, "'R' (shifted) still -> geo armed rectangle")

// 4. An unrelated/unmapped key -> null.
assert.equal(toolShortcut(key('q'), null), null, "unrelated key 'q' -> null")
assert.equal(toolShortcut(key('Escape'), null), null, "'Escape' is handled elsewhere, not a tool shortcut")

// 5. editingId !== null suppresses every shortcut (TextEditor owns the
//    keyboard while editing).
assert.equal(toolShortcut(key('r'), 'shape:being-edited'), null, 'editingId!==null suppresses the shortcut entirely')

// 6. Ctrl/Cmd/Alt held suppresses a tool shortcut (Ctrl+A is select-all,
//    Ctrl+D is duplicate -- these must never collide with the bare-letter
//    tool shortcuts).
assert.equal(toolShortcut(key('a', { ctrl: true }), null), null, 'Ctrl+A is select-all, not the arrow-tool shortcut')
assert.equal(toolShortcut(key('d', { meta: true }), null), null, 'Cmd+D is duplicate, not the draw-tool shortcut')
assert.equal(toolShortcut(key('r', { alt: true }), null), null, 'Alt+R is never a tool shortcut')

// 7. TOOL_SHORTCUT_LABEL -- one displayable key per ToolId, for the toolbar
//    tooltip. 'geo' shows its FIRST-registered key ('r').
assert.equal(TOOL_SHORTCUT_LABEL.select, 'V')
assert.equal(TOOL_SHORTCUT_LABEL.hand, 'H')
assert.equal(TOOL_SHORTCUT_LABEL.geo, 'R', "geo's tooltip label is its first-registered shortcut key")
assert.equal(TOOL_SHORTCUT_LABEL.note, 'N')
assert.equal(TOOL_SHORTCUT_LABEL.text, 'T')
assert.equal(TOOL_SHORTCUT_LABEL.arrow, 'A')
assert.equal(TOOL_SHORTCUT_LABEL.frame, 'F')
assert.equal(TOOL_SHORTCUT_LABEL.draw, 'D')
assert.equal(TOOL_SHORTCUT_LABEL.line, 'L')

console.log('ok: tool-shortcut -- toolShortcut maps tldraw-parity letters to ToolId (+ armGeo for r/o), gated on editingId/modifiers')
