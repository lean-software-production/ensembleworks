// Run: bun src/use-canvas-session.test.ts
//
// Mounts useCanvasSession + CanvasSurface against a real Editor and a fake
// CanvasHost, with a real react-dom/client reconciler in happy-dom (the
// session's document keydown/pointerdown/focusin listeners live in effects,
// which renderToStaticMarkup never runs). The harness mirrors a host: a
// keyboard-scope element holding a toolbar button, a plain in-scope span, and
// the viewport container wrapping CanvasSurface; a sibling outside the scope
// stands in for another bb pane.
//
// happy-dom's globals must be installed before react-dom loads, so every
// React-flavoured import below is dynamic.
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

const win = new Window()
;(globalThis as any).window = win
;(globalThis as any).document = win.document
;(globalThis as any).navigator = win.navigator
;(globalThis as any).ResizeObserver = win.ResizeObserver
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { createElement, useRef, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { LoroCanvasDoc } = await import('@ensembleworks/canvas-doc')
const { createToolContext, createToolSet, Editor } = await import('@ensembleworks/canvas-editor')
const { CanvasSurface } = await import('./CanvasSurface.js')
const { useCanvasSession } = await import('./use-canvas-session.js')
type CanvasHost = import('./host.js').CanvasHost
type ShapeT = import('@ensembleworks/canvas-model').Shape

interface Harness {
	editor: InstanceType<typeof Editor>
	host: CanvasHost
	writes: string[]
	notices: string[]
	body: HTMLElement
	toolButton: HTMLElement
	inScope: HTMLElement
	outOfScope: HTMLElement
	unmount: () => Promise<void>
}

async function mount(opts: { rejectWrite?: boolean } = {}): Promise<Harness> {
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	doc.putPage({ id: 'page:p', name: 'P' })
	doc.putShape({ id: 'shape:n', kind: 'note', parentId: 'page:p', index: 'a1', x: 100, y: 100, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as ShapeT)
	doc.commit()
	const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
	const toolContext = createToolContext(editor)
	const tools = createToolSet(toolContext)
	const writes: string[] = []
	const notices: string[] = []
	const host: CanvasHost = {
		clipboard: {
			read: () => Promise.resolve(''),
			write: (text) => {
				writes.push(text)
				return opts.rejectWrite ? Promise.reject(new Error('denied')) : Promise.resolve()
			},
		},
		notify: (message) => notices.push(message),
		onCursorScreen: () => {},
	}

	function Host() {
		const scopeRef = useRef<HTMLDivElement | null>(null)
		const containerRef = useRef<HTMLDivElement | null>(null)
		const session = useCanvasSession({ editor, toolContext, tools, host, keyboardScopeRef: scopeRef, viewportContainerRef: containerRef })
		return createElement(
			'div',
			null,
			createElement('span', { 'data-testid': 'outside' }, 'another pane'),
			createElement(
				'div',
				{ ref: scopeRef, 'data-testid': 'scope' },
				createElement('button', { type: 'button', 'data-canvas-tool': 'select', onClick: () => session.selectTool('select') }, 'Select'),
				createElement('span', { 'data-testid': 'in-scope' }, 'page tab'),
				createElement(
					'div',
					{ ref: containerRef },
					createElement(CanvasSurface, { session, editorState: editor.get(), snapshot: toolContext.snapshot(), viewportSize: { width: 800, height: 600 } }),
				),
			),
		)
	}

	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	await act(async () => root.render(createElement(Host)))
	const q = (sel: string) => container.querySelector(sel) as HTMLElement
	return {
		editor,
		host,
		writes,
		notices,
		body: document.body,
		toolButton: q('[data-canvas-tool]'),
		inScope: q('[data-testid="in-scope"]'),
		outOfScope: q('[data-testid="outside"]'),
		unmount: async () => {
			await act(async () => root.unmount())
			container.remove()
			toolContext.dispose()
		},
	}
}

function pointerdown(target: HTMLElement): void {
	target.dispatchEvent(new (win as any).Event('pointerdown', { bubbles: true }))
}

function keydown(target: HTMLElement, key: string, mods: { ctrl?: boolean } = {}): KeyboardEvent {
	const e = new (win as any).KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey: mods.ctrl ?? false })
	target.dispatchEvent(e)
	return e
}

function note(h: Harness): { x: number; y: number } {
	const s = h.editor.doc.listShapes().find((sh) => sh.id === 'shape:n')!
	return { x: s.x, y: s.y }
}

// (a) Backspace on body deletes the selection only after an in-scope pointerdown.
{
	const h = await mount()
	await act(async () => h.editor.apply({ type: 'SetSelection', ids: ['shape:n'] }))
	await act(async () => {
		pointerdown(h.outOfScope)
		keydown(h.body, 'Backspace')
	})
	assert.equal(h.editor.doc.listShapes().length, 1, 'Backspace on body after an out-of-scope pointerdown must not delete')
	await act(async () => {
		pointerdown(h.inScope)
		keydown(h.body, 'Backspace')
	})
	assert.equal(h.editor.doc.listShapes().length, 0, 'Backspace on body after an in-scope pointerdown deletes the selection')
	await h.unmount()
	console.log('ok: (a) body Backspace deletes only after an in-scope pointerdown')
}

// (b) Ctrl+C with a selection writes through the host clipboard.
{
	const h = await mount()
	await act(async () => h.editor.apply({ type: 'SetSelection', ids: ['shape:n'] }))
	let e: KeyboardEvent | undefined
	await act(async () => {
		pointerdown(h.inScope)
		e = keydown(h.body, 'c', { ctrl: true })
	})
	assert.equal(h.writes.length, 1, 'Ctrl+C calls host.clipboard.write once')
	assert.ok(h.writes[0]!.includes('shape:n'), `the payload carries the selected shape — got ${h.writes[0]}`)
	assert.equal(e!.defaultPrevented, true, 'the clipboard keydown is suppressed on the document path')
	assert.deepEqual(h.notices, [], 'a successful write notifies nothing')
	await h.unmount()
	console.log('ok: (b) Ctrl+C writes the selection through host.clipboard')
}

// (c) A rejected write notifies the user and does not throw.
{
	const h = await mount({ rejectWrite: true })
	await act(async () => h.editor.apply({ type: 'SetSelection', ids: ['shape:n'] }))
	await act(async () => {
		pointerdown(h.inScope)
		keydown(h.body, 'c', { ctrl: true })
	})
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0))
	})
	assert.deepEqual(h.notices, ['Clipboard is not available'], 'a rejected write calls host.notify')
	await h.unmount()
	console.log('ok: (c) a rejected clipboard write calls host.notify')
}

// (d) Enter or Space on a focused chrome button inside the scope is the
// button's own activation key: it must not begin editing the selected note.
// Arrow nudge still reaches the tool from a focused button (the web app's
// CanvasV2App.test.ts case f8), and shortcuts still run.
{
	const h = await mount()
	await act(async () => h.editor.apply({ type: 'SetSelection', ids: ['shape:n'] }))
	const before = note(h)
	let enter: KeyboardEvent | undefined
	await act(async () => {
		h.toolButton.focus()
		enter = keydown(h.toolButton, 'Enter')
		keydown(h.toolButton, ' ')
	})
	assert.equal(h.editor.get().editingId, null, 'Enter on a focused toolbar button must not begin editing the selected note')
	assert.equal(enter!.defaultPrevented, false, "the button's own Enter activation is not suppressed")
	await act(async () => {
		keydown(h.toolButton, 'ArrowRight')
	})
	assert.deepEqual(note(h), { x: before.x + 1, y: before.y }, 'ArrowRight on a focused toolbar button still nudges the selection')
	await act(async () => {
		keydown(h.toolButton, 'Delete')
	})
	assert.equal(h.editor.doc.listShapes().length, 0, 'Delete on a focused toolbar button still deletes the selection')
	await h.unmount()
	console.log('ok: (d) Enter/Space on a focused chrome button stay with the button; arrows and shortcuts still run')
}

// (e) From body, Enter still begins editing (and suppresses its native default
// so no newline lands in the freshly focused editor) and arrows still nudge.
{
	const h = await mount()
	await act(async () => h.editor.apply({ type: 'SetSelection', ids: ['shape:n'] }))
	const before = note(h)
	await act(async () => {
		pointerdown(h.inScope)
		keydown(h.body, 'ArrowRight')
	})
	assert.equal(note(h).x, before.x + 1, 'ArrowRight on body nudges the selection')
	let e: KeyboardEvent | undefined
	await act(async () => {
		e = keydown(h.body, 'Enter')
	})
	assert.equal(h.editor.get().editingId, 'shape:n', 'Enter on body begins editing the selected note')
	assert.equal(e!.defaultPrevented, true, 'an Enter that began an edit is preventDefaulted')
	await h.unmount()
	console.log('ok: (e) body Enter begins editing with its default suppressed; body arrows nudge')
}
