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
	/** The LIVE session object, re-captured on every render. Tests that drive
	 * raw InputEvents (the two-finger cases) need `handleInput` itself — the
	 * Viewport's own `onInput` — because a pinch has NO DOM event to dispatch:
	 * it is two independent pointer streams the session has to recognize. */
	session: () => import('./use-canvas-session.js').CanvasSession
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

	let live: import('./use-canvas-session.js').CanvasSession | null = null
	function Host() {
		const scopeRef = useRef<HTMLDivElement | null>(null)
		const containerRef = useRef<HTMLDivElement | null>(null)
		const session = useCanvasSession({ editor, toolContext, tools, host, keyboardScopeRef: scopeRef, viewportContainerRef: containerRef })
		live = session
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
		session: () => {
			assert.ok(live !== null, 'the harness rendered a session')
			return live!
		},
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

// (f) Escape while editing resolves to 'endEdit' (not 'cancel') — it must
// end ONLY the edit (pane input routing task, docs/plans/
// 2026-09-15-bb-thread-frame.md's follow-up section): the active tool stays
// 'select' and no in-flight gesture is torn down.
{
	const h = await mount()
	await act(async () => h.editor.apply({ type: 'SetSelection', ids: ['shape:n'] }))
	await act(async () => {
		keydown(h.body, 'Enter')
	})
	assert.equal(h.editor.get().editingId, 'shape:n', 'precondition: shape:n is being edited')
	await act(async () => {
		keydown(h.body, 'Escape')
	})
	assert.equal(h.editor.get().editingId, null, 'Escape while editing ends the edit')
	assert.ok(h.editor.doc.getShape('shape:n'), 'Escape must not delete the shape being edited')
	await h.unmount()
	console.log("ok: (f) Escape while editing resolves to 'endEdit' and ends the edit")
}

// ---------------------------------------------------------------------------
// (g) TWO FINGERS ARE A PINCH, NOT A DRAG (mobile-touch task).
//
// WHY THIS LIVES HERE AND NOT IN A CONTRACT, which is the whole point of the
// case: the FSM contracts (pinch-zooms-about-the-midpoint,
// pinch-does-not-drag-shapes) drive canvas-editor's `reduceMultiTouch`
// directly from the runner, so they prove the RECOGNIZER. They cannot see
// this file's wiring of it — and the wiring is where the bug was. The session
// armed the pinch, stored it, and then called `cancelAndReset()` to unwind the
// interrupted one-finger gesture; `cancelAndReset` ALSO resets the recognizer
// (it has to: blur and pointercancel take the fingers away without delivering
// the pointerups it waits for), so it wiped the pinch on the very event that
// armed it. Every later move then read as an ordinary drag. Both contracts
// stayed green throughout.
{
	const h = await mount()
	const touch = (type: 'pointerdown' | 'pointermove' | 'pointerup', pointerId: number, x: number, y: number) => ({
		type, x, y,
		buttons: type === 'pointerup' ? 0 : 1,
		modifiers: { shift: false, alt: false, ctrl: false, meta: false },
		t: 0, pointerId, pointerType: 'touch' as const,
	})
	const zoomBefore = h.editor.get().camera.z
	const noteBefore = note(h)
	await act(async () => {
		// One finger lands ON the note and drags it a little: a real gesture is
		// in flight when the second finger arrives, so the cancel path runs.
		h.session().handleInput(touch('pointerdown', 1, 150, 150))
		h.session().handleInput(touch('pointermove', 1, 170, 150))
		// ...second finger, then spread.
		h.session().handleInput(touch('pointerdown', 2, 350, 150))
		h.session().handleInput(touch('pointermove', 2, 450, 150))
		h.session().handleInput(touch('pointermove', 1, 70, 150))
		h.session().handleInput(touch('pointerup', 1, 70, 150))
		h.session().handleInput(touch('pointerup', 2, 450, 150))
	})
	assert.ok(
		h.editor.get().camera.z > zoomBefore,
		`spreading two fingers must zoom the camera in (z ${zoomBefore} -> ${h.editor.get().camera.z})`,
	)
	// ...and the note must sit where the PRE-PINCH one-finger drag left it (20px
	// right at zoom 1) — not dragged on by the pinch, and not rolled back
	// either: a pinch abandons the gesture it interrupts, it does not revert it.
	const noteAfter = note(h)
	assert.deepEqual(
		{ dx: noteAfter.x - noteBefore.x, dy: noteAfter.y - noteBefore.y },
		{ dx: 20, dy: 0 },
		'the two touches must never reach the select tool as a drag',
	)
	await h.unmount()
	console.log('ok: (g) two fingers pinch the camera and never drag a shape')
}

// (h) ...and the session is left clean afterwards: the next one-finger gesture
// works. A suppression that outlived its fingers would silently eat it.
{
	const h = await mount()
	const touch = (type: 'pointerdown' | 'pointermove' | 'pointerup', pointerId: number, x: number, y: number) => ({
		type, x, y,
		buttons: type === 'pointerup' ? 0 : 1,
		modifiers: { shift: false, alt: false, ctrl: false, meta: false },
		t: 0, pointerId, pointerType: 'touch' as const,
	})
	await act(async () => {
		h.session().handleInput(touch('pointerdown', 1, 150, 150))
		h.session().handleInput(touch('pointerdown', 2, 350, 150))
		h.session().handleInput(touch('pointermove', 2, 450, 150))
		h.session().handleInput(touch('pointerup', 1, 150, 150))
		h.session().handleInput(touch('pointerup', 2, 450, 150))
	})
	const before = note(h)
	await act(async () => {
		h.session().handleInput(touch('pointerdown', 3, 150, 150))
		h.session().handleInput(touch('pointermove', 3, 190, 150))
		h.session().handleInput(touch('pointerup', 3, 190, 150))
	})
	const after = note(h)
	assert.ok(after.x !== before.x, 'a one-finger drag after a pinch still moves the shape')
	await h.unmount()
	console.log('ok: (h) a pinch does not eat the gesture that follows it')
}
