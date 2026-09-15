// Run: bun src/canvas-surface.test.ts
import assert from 'node:assert/strict'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { createToolContext, createToolSet, createInitialToolStates, Editor } from '@ensembleworks/canvas-editor'
import { CanvasSurface, effectiveOpenSlot, selectionKey } from './CanvasSurface.js'
import type { CanvasSession } from './use-canvas-session.js'

const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putPage({ id: 'page:p', name: 'P' })
doc.putShape({ id: 'shape:n', kind: 'note', parentId: 'page:p', index: 'a1', x: 100, y: 100, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as never)
doc.commit()
const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
editor.apply({ type: 'SetSelection', ids: ['shape:n'] })
const toolContext = createToolContext(editor)
const tools = createToolSet(toolContext)

const session: CanvasSession = {
	editor,
	toolContext,
	activeToolId: 'select',
	toolStates: createInitialToolStates(tools),
	isGesturing: false,
	selectTool: () => {},
	cancelAndReset: () => {},
	handleInput: () => {},
	dispatch: (intents) => editor.applyAll(intents),
	onStyleChange: () => {},
	onArmStyle: () => {},
}

const html = renderToStaticMarkup(
	createElement(CanvasSurface, {
		session,
		editorState: editor.get(),
		snapshot: toolContext.snapshot(),
		viewportSize: { width: 1024, height: 768 },
		overlays: createElement('div', { 'data-host-overlay': '' }) as ReactNode,
	}),
)

assert.ok(html.includes('data-shape-kind="note"'), 'renders shape bodies')
assert.ok(html.includes('data-style-panel-mode="selection"'), 'renders the style panel for the selection')
assert.ok(html.includes('data-host-overlay'), 'renders the host overlay slot')
assert.ok(html.indexOf('data-host-overlay') < html.indexOf('data-style-panel-mode'), 'host overlays paint below the style panel')
console.log('ok: CanvasSurface renders shapes, host overlays and the style panel')
toolContext.dispose()

const sel = new Set(['shape:a', 'shape:b'])
const state = { slot: 'color' as const, selectionKey: selectionKey(sel) }
assert.equal(effectiveOpenSlot(state, new Set(['shape:b', 'shape:a']), false), 'color', 'same selection (any order) keeps it open')
assert.equal(effectiveOpenSlot(state, new Set(['shape:a']), false), null, 'selection change closes it')
assert.equal(effectiveOpenSlot(state, sel, true), null, 'a gesture closes it')
console.log('ok: open popover closes on selection change and gesture')
