// Run: bun src/toolbar.test.ts
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Toolbar, TOOL_ORDER } from './Toolbar.js'

const html = renderToStaticMarkup(createElement(Toolbar, { activeToolId: 'note', onSelectTool: () => {} }))

assert.deepEqual(TOOL_ORDER.map((t) => t.id), ['select', 'hand', 'note', 'text', 'geo', 'frame', 'arrow', 'draw', 'line'])
assert.ok(html.includes('role="toolbar"'), 'the toolbar is an ARIA toolbar')
for (const { id } of TOOL_ORDER) {
  assert.ok(html.includes(`data-canvas-tool="${id}"`), `renders a button for ${id}`)
}
assert.match(html, /data-canvas-tool="note"[^>]*aria-pressed="true"/, 'the active tool is pressed')
assert.match(html, /data-canvas-tool="select"[^>]*aria-pressed="false"/, 'inactive tools are not pressed')
assert.ok(html.includes('title="Note (N)"'), 'tooltip names the shortcut letter')
assert.ok(html.includes('title="Shape (R)"'), 'geo shows its first shortcut letter')
assert.equal((html.match(/<svg/g) ?? []).length, 9, 'every button renders an icon')
assert.ok(!/>\s*Note\s*</.test(html), 'buttons show icons, not text labels')
console.log('ok: Toolbar renders nine icon buttons with pressed state and shortcut tooltips')
