// Run: bun src/canvas-v2/CanvasV2App.test.ts
//
// THE LOAD-BEARING INTEGRATION TEST for Task G3 — mirrors canvas-react's OWN
// house precedent for exactly this kind of test (see
// canvas-react/src/embed/embed-reconciler.test.ts's header): happy-dom + a
// REAL react-dom/client reconciler + <StrictMode>, because
// renderToStaticMarkup (this repo's usual component-test rig) never runs
// effects at all — and CanvasV2App's entire construction sequence (connect
// -> SyncClientPeer -> resolvePageId -> Editor -> ToolContext -> mount) lives
// inside effects. No real WebSocket/server process: `connect` is CanvasV2App's
// own documented test seam, injected here to hand back one half of a
// canvas-sync `makePair()` memory-transport pair wired to a REAL
// `SyncServerPeer` + real `LoroCanvasDoc`, in-process — proving the actual
// sync/render code paths, not a mock of them.
//
// DOM GLOBALS BEFORE REACT-DOM (same reasoning as embed-reconciler.test.ts):
// happy-dom's window/document must be installed on globalThis BEFORE
// react-dom/client (which binds to `document` at createRoot time) or any
// canvas-react import runs — static `import` declarations hoist above any
// statement, so every React-flavored and canvas-v2 import below is dynamic,
// AFTER the globals are set. IS_REACT_ACT_ENVIRONMENT makes React 19's
// act() flush renders + effects (incl. StrictMode's dev-only double-invoke)
// synchronously, which is what makes the assertions below deterministic
// despite CanvasV2App's async boot sequence (act() accepts an async
// callback and awaits it before returning).
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

const win = new Window()
;(globalThis as any).window = win
;(globalThis as any).document = win.document
;(globalThis as any).navigator = win.navigator
;(globalThis as any).location = win.location
;(globalThis as any).ResizeObserver = win.ResizeObserver
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { createElement, StrictMode, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { SyncServerPeer, SyncClientPeer, PresenceStore, makePair } = await import('@ensembleworks/canvas-sync')
const { CanvasV2App } = await import('./CanvasV2App.js')
type Transport = import('@ensembleworks/canvas-sync').Transport
type Shape = import('@ensembleworks/canvas-model').Shape

function seedShape(id: string, x: number, y: number): Shape {
	return {
		id, kind: 'geo', parentId: 'page:p', index: 'a1', x, y, rotation: 0,
		isLocked: false, opacity: 1, meta: {}, props: { w: 80, h: 60 },
	} as Shape
}

async function main() {
	// ==========================================================================
	// Server-side fixture: a REAL SyncServerPeer/LoroCanvasDoc, pre-seeded with
	// a page + one shape BEFORE the client ever connects — this is the "the
	// server's existing shapes" the mount must render.
	// ==========================================================================
	const server = new SyncServerPeer({ peerId: 1n })
	server.doc.putPage({ id: 'page:p', name: 'Canvas' })
	server.doc.putShape(seedShape('shape:seed-1', 10, 10))
	server.doc.commit()

	// A FRESH memory-transport pair per `connect()` CALL, not one shared pair
	// reused across calls — StrictMode invokes the mount effect TWICE (mount
	// -> simulated cleanup -> mount again), and the first (cancelled) mount's
	// cleanup calls `transport.close()` on whatever it connected; memory-
	// transport.ts's `close()` tears down BOTH ends of a `makePair()` pair
	// together (one shared `open` flag), so reusing a single pair across both
	// StrictMode invocations would have the cancelled mount's cleanup silently
	// kill the transport the SURVIVING mount goes on to use — the exact
	// StrictMode hazard this test wants to prove CanvasV2App does NOT have
	// (its own cleanup only ever closes the transport ITS OWN boot sequence
	// connected, never one it didn't). A real WebSocket doesn't have this
	// failure mode either way (each `new WebSocket(url)` call opens an
	// independent connection), so this per-call-fresh-pair setup is what
	// makes the in-process test fixture behave like the real thing.
	function connect(): Promise<Transport> {
		const [serverSide, clientSide]: [Transport, Transport] = makePair()
		server.connect(serverSide)
		return Promise.resolve(clientSide)
	}

	// Via the bare global `document` (not `win.document`) so TS resolves it
	// through the ambient lib.dom `Document`/`HTMLDivElement` types — the
	// same types react-dom's `createRoot(Container)` expects — rather than
	// happy-dom's own (structurally different) class types, which `win.
	// document.createElement(...)` would carry and createRoot would then
	// reject at the type level (see this file's own history: that's exactly
	// what happened here before this comment was added).
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)

	// (a) MOUNT HANDSHAKES AND RENDERS THE SERVER'S EXISTING SHAPES.
	// `connect` hands back the CLIENT half of the pair directly (already
	// "open" — no ws handshake to await), and `settleMs: 0` skips the
	// production settle window (see CanvasV2App's own module header + Table
	// bootstrap-page.ts's KNOWN RACE note): the memory transport's round trip
	// is SYNCHRONOUS (canvas-sync/src/memory-transport.ts's `send` dispatches
	// on the same call stack, no queueMicrotask anywhere), so by the time
	// `connect()`'s promise resolves the server's existing content has
	// already been imported into the client's doc.
	await act(async () => {
		root.render(
			createElement(
				StrictMode,
				null,
				createElement(CanvasV2App, {
					roomId: 'dogfood-test',
					userId: 'test-user',
					connect,
					settleMs: 0,
				}),
			),
		)
		// Flush the async boot sequence's microtask chain (connect() ->
		// SyncClientPeer construction -> delay(0) -> resolvePageId -> setSession)
		// inside act() so React's synchronous-update flushing covers it.
		await new Promise((r) => setTimeout(r, 0))
		await new Promise((r) => setTimeout(r, 0))
	})

	assert.ok(
		container.querySelector('[data-shape-id="shape:seed-1"]'),
		`the server's pre-existing shape must be rendered after the sync handshake — DOM: ${container.innerHTML}`,
	)
	console.log("ok: CanvasV2App — mount handshakes and renders the server's existing shapes")

	// ==========================================================================
	// (b) A SERVER-SIDE putShape APPEARS IN THE DOM AFTER SYNC.
	// ==========================================================================
	await act(async () => {
		server.doc.putShape(seedShape('shape:live-add', 200, 200))
		server.doc.commit() // subscribeLocalUpdates -> broadcast -> client import (all synchronous over the memory transport)
		await new Promise((r) => setTimeout(r, 0))
	})
	assert.ok(
		container.querySelector('[data-shape-id="shape:live-add"]'),
		`a server-side putShape committed after mount must render into the client DOM — DOM: ${container.innerHTML}`,
	)
	console.log('ok: CanvasV2App — a server-side putShape after mount appears in the DOM')

	// ==========================================================================
	// (c) PRESENCE (Task G4): a SECOND peer's published cursor renders in this
	// mount's DOM, and this mount's OWN presence entry never renders itself
	// (self-filtered — Cursors.tsx's documented contract, unit-tested
	// directly in canvas-react/src/cursors.test.ts; this is the end-to-end
	// proof over the real wire + a real SyncServerPeer).
	// ==========================================================================
	const [serverSideB, clientSideB]: [Transport, Transport] = makePair()
	server.connect(serverSideB)
	const presenceB = new PresenceStore('peer-b')
	const peerB = new SyncClientPeer({ peerId: 2n, transport: clientSideB, presence: presenceB })

	const ewPresence = (globalThis as any).window.__ew as { presencePublisher: { setCursor(c: { x: number; y: number } | null): void } }
	assert.ok(ewPresence?.presencePublisher, 'window.__ew.presencePublisher must be set by the mount (Task G4)')

	await act(async () => {
		// Peer B publishes a cursor -- relayed over the wire (server + this
		// mount's SyncClientPeer/PresenceStore) to the mount under test.
		presenceB.publish({ cursor: { x: 50, y: 50 }, viewport: null, stamp: null, presenting: [] })
		// This mount ALSO publishes its OWN cursor (via the test-only __ew hook,
		// standing in for a real pointermove) -- proving self-exclusion is
		// actually filtering a REAL entry, not merely "nothing to filter".
		ewPresence.presencePublisher.setCursor({ x: 60, y: 60 })
		// The wire relay is effectively synchronous (memory transport), but this
		// mount's Cursors render is driven by CanvasV2App's PRESENCE_POLL_MS
		// (150ms) polling tick, not a push -- wait past at least one tick.
		await new Promise((r) => setTimeout(r, 250))
	})

	assert.ok(
		container.querySelector('[data-presence-key="peer-b"]'),
		`peer B's published cursor must render in this mount's DOM after the wire relay — DOM: ${container.innerHTML}`,
	)
	assert.ok(
		!container.querySelector('[data-presence-key="test-user"]'), // 'test-user' is this mount's OWN userId/selfKey (CanvasV2App props above)
		'this mount\'s OWN presence entry must never render itself, even though it has a real (non-null) cursor',
	)
	console.log("ok: CanvasV2App — a peer's published presence cursor renders in the DOM, this mount's own entry self-filtered")

	// ==========================================================================
	// (c2) CAMERA-ONLY CHANGE REPUBLISHES THE CURSOR (quality-review fix
	// round): record a screen cursor via setCursorFromScreen (standing in for
	// a real pointermove), then apply a SetCamera with NO further pointer
	// event — the mount's editor-subscribe effect must re-derive and
	// republish the world cursor, observable from peer B's presence store
	// over the real wire. Waits >60ms (PRESENCE_THROTTLE_MS) between the two
	// publishes so the refresh isn't dropped by the shared cursor throttle.
	// ==========================================================================
	const ewFull = (globalThis as any).window.__ew as {
		editor: { apply(intent: unknown): void }
		presencePublisher: { setCursorFromScreen(s: { x: number; y: number }, c: { x: number; y: number; z: number }): void }
	}
	await act(async () => {
		// Screen (100,100) at the identity camera -> world (100,100).
		ewFull.presencePublisher.setCursorFromScreen({ x: 100, y: 100 }, { x: 0, y: 0, z: 1 })
		await new Promise((r) => setTimeout(r, 100)) // clear the 60ms throttle window before the camera change
	})
	assert.deepEqual(
		(presenceB.all()['test-user'] as { cursor: unknown }).cursor,
		{ x: 100, y: 100 },
		'precondition: peer B sees the pre-pan world cursor',
	)
	await act(async () => {
		// Camera-only change, NO pointermove: the world point under the same
		// screen point becomes (100/2 - (-50), 100/2 - 0) = (100, 50).
		ewFull.editor.apply({ type: 'SetCamera', x: -50, y: 0, z: 2 })
		await new Promise((r) => setTimeout(r, 100))
	})
	assert.deepEqual(
		(presenceB.all()['test-user'] as { cursor: unknown }).cursor,
		{ x: 100, y: 50 },
		'a camera-only change republishes the cursor at the RECOMPUTED world position (peers no longer see it frozen at the pre-pan spot)',
	)
	console.log('ok: CanvasV2App — a camera-only change republishes the world cursor to peers')

	peerB.close()
	presenceB.destroy()

	// ==========================================================================
	// (d) DELETE/BACKSPACE -> DeleteShapes (Task B2), including the
	// text-editing SUPPRESSION case: TextEditor owns Delete/Backspace while a
	// shape is being edited (`editingId !== null`), so a real DOM keydown must
	// reach handleInput (it bubbles all the way up through Viewport's own
	// onKeyDown — TextEditor's own handler, handleEditorKeyDown, never calls
	// stopPropagation, see TextEditor.tsx) WITHOUT deleting the shape being
	// edited. Drives the FULL real path end to end: a genuine bubbling
	// `KeyboardEvent` dispatched on the focusable viewport div (the tabIndex
	// target Viewport.tsx documents as required for onKeyDown to ever fire at
	// all) -> Viewport's keyEventToInput -> CanvasV2App.handleInput's new
	// Delete/Backspace branch -> deleteSelectionIntents -> editor.applyAll.
	// ==========================================================================
	const ewDel = (globalThis as any).window.__ew as {
		editor: {
			get(): { selection: ReadonlySet<string>; editingId: string | null }
			apply(intent: unknown): void
			applyAll(intents: unknown[]): void
		}
		doc: { getShape(id: string): unknown }
	}
	// The tabIndex=0 div Viewport itself renders (see Viewport.tsx's
	// ABANDONMENT-GAP / keyboard-focus header) — the ONLY element in this whole
	// render tree carrying an explicit tabIndex, so a plain attribute selector
	// finds it unambiguously.
	const viewportEl = container.querySelector('[tabindex]') as HTMLElement | null
	assert.ok(viewportEl, `the focusable viewport div (Viewport.tsx's tabIndex=0 root) must exist in the DOM — DOM: ${container.innerHTML}`)

	function pressKey(key: 'Delete' | 'Backspace'): void {
		viewportEl!.dispatchEvent(new (win as any).KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
	}

	// (d1) Delete, editingId === null: deletes the selection.
	await act(async () => {
		ewDel.editor.apply({ type: 'CreateShape', shape: seedShape('shape:del-a', 400, 400) })
		ewDel.editor.apply({ type: 'SetSelection', ids: ['shape:del-a'] })
	})
	assert.ok(ewDel.doc.getShape('shape:del-a'), 'precondition: shape:del-a exists and is selected before the keypress')
	await act(async () => {
		pressKey('Delete')
	})
	assert.equal(ewDel.doc.getShape('shape:del-a'), undefined, 'Delete with a non-empty selection and editingId===null deletes the selected shape')
	assert.deepEqual([...ewDel.editor.get().selection], [], 'the selection is cleared after the Delete-driven DeleteShapes')
	console.log('ok: CanvasV2App — a real Delete keydown deletes the selected shape (editingId===null)')

	// (d2) Backspace, editingId === null: same wiring, the other bound key.
	await act(async () => {
		ewDel.editor.apply({ type: 'CreateShape', shape: seedShape('shape:del-b', 420, 420) })
		ewDel.editor.apply({ type: 'SetSelection', ids: ['shape:del-b'] })
	})
	assert.ok(ewDel.doc.getShape('shape:del-b'), 'precondition: shape:del-b exists and is selected before the keypress')
	await act(async () => {
		pressKey('Backspace')
	})
	assert.equal(ewDel.doc.getShape('shape:del-b'), undefined, 'Backspace with a non-empty selection and editingId===null deletes the selected shape')
	console.log('ok: CanvasV2App — a real Backspace keydown deletes the selected shape (editingId===null)')

	// (d3) SUPPRESSION: editingId !== null -- neither key deletes the shape
	// being edited. BeginEdit stands in for the real double-click-to-edit
	// gesture (already covered by tool-loop.test.ts's own transform/select
	// probes) -- what matters here is CanvasV2App's own gate on editingId, not
	// how editingId got set.
	await act(async () => {
		ewDel.editor.apply({ type: 'CreateShape', shape: seedShape('shape:del-c', 440, 440) })
		ewDel.editor.apply({ type: 'SetSelection', ids: ['shape:del-c'] })
		ewDel.editor.apply({ type: 'BeginEdit', id: 'shape:del-c' })
	})
	assert.equal(ewDel.editor.get().editingId, 'shape:del-c', 'precondition: shape:del-c is being edited')
	await act(async () => {
		pressKey('Delete')
	})
	assert.ok(ewDel.doc.getShape('shape:del-c'), 'Delete while editingId!==null must NOT delete the shape being edited (TextEditor owns the keyboard)')
	assert.equal(ewDel.editor.get().editingId, 'shape:del-c', 'editingId is unchanged by the suppressed Delete')
	await act(async () => {
		pressKey('Backspace')
	})
	assert.ok(ewDel.doc.getShape('shape:del-c'), 'Backspace while editingId!==null must NOT delete the shape being edited either')
	console.log('ok: CanvasV2App — Delete and Backspace are both suppressed while editingId!==null (TextEditor owns the keyboard)')

	// Clean up: end the edit and delete shape:del-c through the same real
	// keyboard path, so the doc is back to its pre-(d) shape count (2) for the
	// unmount section's precondition below.
	await act(async () => {
		ewDel.editor.apply({ type: 'EndEdit' })
	})
	await act(async () => {
		pressKey('Delete')
	})
	assert.equal(ewDel.doc.getShape('shape:del-c'), undefined, 'shape:del-c is deleted once editingId is cleared (cleanup, also re-proving the un-suppressed path)')

	// ==========================================================================
	// (d3e) ESCAPE, PRIMARY PATH (Task B3): a real `Escape` keydown dispatched
	// on the FOCUSED VIEWPORT DIV (not a toolbar button — that's d4's fallback
	// path) drives the WHOLE primary chain end to end: Viewport.onKeyDown ->
	// keyEventToInput -> CanvasV2App.handleInput -> the shared
	// handleGlobalShortcut policy -> cancelAndReset -> the in-flight preview's
	// DeleteShapes. The other Escape integration case (d4) deliberately
	// bypasses handleInput (it dispatches on a focused sibling button, so only
	// the document-level listener sees it), so this is the ONLY test that
	// exercises handleInput's own keydown branch for Escape — and, after the
	// shared-gate refactor, the shared policy via that primary path. Nets zero
	// shapes (the preview is created then cancelled) so (e)'s pre-unmount count
	// precondition still holds.
	// ==========================================================================
	const geoBtnEsc = container.querySelector('[data-canvas-v2-tool="geo"]') as HTMLElement | null
	const selectBtnEsc = container.querySelector('[data-canvas-v2-tool="select"]') as HTMLElement | null
	assert.ok(geoBtnEsc && selectBtnEsc, `the geo and select toolbar buttons must exist — DOM: ${container.innerHTML}`)

	// Switch to the geo tool (real click) so a viewport drag creates a preview.
	await act(async () => {
		geoBtnEsc!.click()
	})

	const ewEsc = (globalThis as any).window.__ew as { doc: { listShapes(): Array<{ id: string }> } }
	const idsBeforeEscDrag = new Set(ewEsc.doc.listShapes().map((s) => s.id))

	// Focus the VIEWPORT DIV itself (not a toolbar button) — the primary path's
	// precondition. Then a real pointerdown + pointermove ON the viewport start
	// a geo create-drag crossing the threshold (mirrors tool-loop.test.ts's own
	// create-drag deltas).
	await act(async () => {
		viewportEl!.focus()
		viewportEl!.dispatchEvent(new (win as any).PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 21, clientX: 500, clientY: 500, buttons: 1 }))
		viewportEl!.dispatchEvent(new (win as any).PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 21, clientX: 560, clientY: 560, buttons: 1 }))
	})
	const escPreview = ewEsc.doc.listShapes().find((s) => !idsBeforeEscDrag.has(s.id))
	assert.ok(escPreview, `precondition: the geo drag created an in-flight preview shape — shapes: ${JSON.stringify(ewEsc.doc.listShapes())}`)
	assert.equal(document.activeElement, viewportEl, 'precondition: the VIEWPORT div holds focus (this is the primary onKeyDown path, not the toolbar fallback)')

	// The real primary-path Escape: dispatched ON the focused viewport div, so
	// it flows through Viewport.onKeyDown -> handleInput -> handleGlobalShortcut
	// (NOT the document-level fallback — the fallback's containment guard skips
	// any target inside the viewport container, so this is unambiguously the
	// primary path).
	await act(async () => {
		viewportEl!.dispatchEvent(new (win as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
	})
	assert.equal(
		ewEsc.doc.listShapes().find((s) => s.id === escPreview!.id),
		undefined,
		'a real Escape keydown on the FOCUSED VIEWPORT cancels the in-flight create-drag preview (handleInput -> shared handleGlobalShortcut -> cancelAndReset)',
	)
	console.log('ok: CanvasV2App — a real Escape keydown on the focused viewport cancels an in-flight gesture (primary handleInput path)')

	// Restore the select tool (cleanup) so d4 starts from the same state it did
	// before this case was inserted.
	await act(async () => {
		selectBtnEsc!.click()
	})

	// ==========================================================================
	// (d4) KEYBOARD DELIVERY SURVIVES A TOOLBAR CLICK (B3's CARRIED
	// CODE-QUALITY FIX): the v2 keydown listener lived on Viewport's own div;
	// the toolbar `<button>`s are DOM SIBLINGS of Viewport (see
	// CanvasV2App.tsx's JSX — the toolbar div and the viewport-wrapping div are
	// siblings under the outermost flex container), so a keydown dispatched to
	// a FOCUSED toolbar button never bubbles into Viewport's own onKeyDown at
	// all — before this fix, Escape/Delete/Backspace would silently no-op the
	// moment a toolbar button held focus (the real-browser default after a
	// click). This proves the NEW document-level fallback listener
	// (CanvasV2App.tsx's GLOBAL KEYBOARD-DELIVERY FALLBACK effect) closes that
	// gap: focus is moved to a toolbar button PROGRAMMATICALLY (`.focus()`, not
	// `.click()` — a click on a DIFFERENT tool button would itself trigger
	// `selectTool`'s own cancelAndReset via the tool-switch path, which is a
	// real but DIFFERENT trigger than the one under test here), then a real
	// bubbling keydown is dispatched on that FOCUSED BUTTON (not the viewport)
	// for both Escape (cancels an in-flight create-drag) and Delete (removes a
	// selected shape).
	// ==========================================================================
	const geoBtn = container.querySelector('[data-canvas-v2-tool="geo"]') as HTMLElement | null
	const selectBtn = container.querySelector('[data-canvas-v2-tool="select"]') as HTMLElement | null
	assert.ok(geoBtn && selectBtn, `both the geo and select toolbar buttons must exist in the DOM — DOM: ${container.innerHTML}`)

	// Switch to the geo (Shape) tool via a REAL click on its own button (this
	// is the ordinary tool-switch path, exercised here only to get an
	// in-flight create-drag gesture going below — not itself part of the
	// regression being proven).
	await act(async () => {
		geoBtn!.click()
	})

	const ewFocus = (globalThis as any).window.__ew as {
		editor: { get(): { selection: ReadonlySet<string> }; apply(intent: unknown): void; applyAll(intents: unknown[]): void }
		doc: { listShapes(): Array<{ id: string }> }
	}
	const shapeIdsBeforeDrag = new Set(ewFocus.doc.listShapes().map((s) => s.id))

	// A real pointerdown + pointermove ON THE VIEWPORT (not the toolbar) starts
	// a geo create-drag gesture crossing the drag threshold — mirrors
	// tool-loop.test.ts's own create-drag fixture deltas (500,500 -> 560,560).
	await act(async () => {
		viewportEl!.dispatchEvent(new (win as any).PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 11, clientX: 500, clientY: 500, buttons: 1 }))
		viewportEl!.dispatchEvent(new (win as any).PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 11, clientX: 560, clientY: 560, buttons: 1 }))
	})
	const previewShape = ewFocus.doc.listShapes().find((s) => !shapeIdsBeforeDrag.has(s.id))
	assert.ok(previewShape, `precondition: the geo drag must have created an in-flight preview shape — shapes: ${JSON.stringify(ewFocus.doc.listShapes())}`)

	// Move focus to a DIFFERENT toolbar button WITHOUT clicking it (no
	// tool-switch side effect) — simulates the real-browser "a button holds
	// focus after being clicked" default this fix targets.
	await act(async () => {
		selectBtn!.focus()
	})
	assert.equal(document.activeElement, selectBtn, 'precondition: the (different) select toolbar button holds focus, NOT the viewport')

	// The real regression: dispatch Escape on the FOCUSED BUTTON (not the
	// viewport) — before this fix, this event never reached CanvasV2App at all.
	await act(async () => {
		selectBtn!.dispatchEvent(new (win as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
	})
	assert.equal(
		ewFocus.doc.listShapes().find((s) => s.id === previewShape!.id),
		undefined,
		'an Escape keydown dispatched on a FOCUSED TOOLBAR BUTTON (not the viewport) still cancels the in-flight create-drag preview',
	)
	console.log('ok: CanvasV2App — Escape reaches cancelAndReset even while a toolbar button (a DOM sibling of Viewport) holds focus')

	// Same proof for Delete: select an existing shape, keep focus on the
	// toolbar button, dispatch Delete there instead of on the viewport.
	await act(async () => {
		ewFocus.editor.apply({ type: 'CreateShape', shape: seedShape('shape:toolbar-focus-del', 460, 460) })
		ewFocus.editor.apply({ type: 'SetSelection', ids: ['shape:toolbar-focus-del'] })
	})
	assert.ok(ewFocus.doc.listShapes().some((s) => s.id === 'shape:toolbar-focus-del'), 'precondition: shape:toolbar-focus-del exists and is selected')
	assert.equal(document.activeElement, selectBtn, 'precondition: focus is still on the toolbar button, not the viewport')
	await act(async () => {
		selectBtn!.dispatchEvent(new (win as any).KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
	})
	assert.equal(
		ewFocus.doc.listShapes().find((s) => s.id === 'shape:toolbar-focus-del'),
		undefined,
		'a Delete keydown dispatched on a FOCUSED TOOLBAR BUTTON (not the viewport) still deletes the selected shape',
	)
	console.log('ok: CanvasV2App — Delete reaches deleteSelectionIntents even while a toolbar button holds focus')

	// Restore the select tool as the active tool (cleanup — the geo tool
	// switch above is otherwise left active for the rest of the file).
	await act(async () => {
		selectBtn!.click()
	})

	// ==========================================================================
	// (f) CTRL+Z / CTRL+SHIFT+Z / CTRL+Y -> editor.undo()/redo() (Task B4),
	// through the SAME shared `handleGlobalShortcut` policy Escape/Delete/
	// Backspace use (see CanvasV2App.tsx's own doc comment on that function).
	// Every case here asserts a REAL doc effect (a shape appearing/
	// disappearing), never a mock of editor.undo()/redo() — proving the
	// keydown actually drove the real undo/redo stack, not just that some
	// function got called. Each case is designed to net ZERO shapes by its own
	// end (create then undo, or create+undo+redo+undo), so the doc is back to
	// its pre-(f) 2-shape state by the time (e)'s unmount precondition reads
	// it below.
	// ==========================================================================
	const ewUndo = (globalThis as any).window.__ew as {
		editor: {
			get(): { editingId: string | null }
			apply(intent: unknown): void
		}
		doc: { listShapes(): Array<{ id: string }>; getShape(id: string): unknown }
	}

	function dispatchKey(target: HTMLElement, opts: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): void {
		target.dispatchEvent(
			new (win as any).KeyboardEvent('keydown', {
				key: opts.key,
				ctrlKey: opts.ctrlKey ?? false,
				metaKey: opts.metaKey ?? false,
				shiftKey: opts.shiftKey ?? false,
				bubbles: true,
				cancelable: true,
			}),
		)
	}

	// (f1) PRIMARY PATH (viewport focus): Ctrl+Z undoes a CreateShape.
	await act(async () => {
		ewUndo.editor.apply({ type: 'CreateShape', shape: seedShape('shape:undo-a', 500, 500) })
	})
	assert.ok(ewUndo.doc.getShape('shape:undo-a'), 'precondition: shape:undo-a exists before Ctrl+Z')
	await act(async () => {
		viewportEl!.focus()
		dispatchKey(viewportEl!, { key: 'z', ctrlKey: true })
	})
	assert.equal(ewUndo.doc.getShape('shape:undo-a'), undefined, 'Ctrl+Z on the focused VIEWPORT drives editor.undo(), removing the just-created shape')
	console.log('ok: CanvasV2App — Ctrl+Z (viewport focus, primary handleInput path) drives editor.undo()')

	// (f2) Cmd+Z (metaKey) undoes too, and Ctrl+Shift+Z redoes it back —
	// ending with a second Ctrl+Z so this case nets zero shapes.
	await act(async () => {
		ewUndo.editor.apply({ type: 'CreateShape', shape: seedShape('shape:undo-b', 520, 520) })
	})
	assert.ok(ewUndo.doc.getShape('shape:undo-b'), 'precondition: shape:undo-b exists before Cmd+Z')
	await act(async () => {
		dispatchKey(viewportEl!, { key: 'z', metaKey: true })
	})
	assert.equal(ewUndo.doc.getShape('shape:undo-b'), undefined, 'Cmd+Z (metaKey, no ctrlKey) also drives editor.undo()')
	console.log('ok: CanvasV2App — Cmd+Z (metaKey) drives editor.undo()')
	await act(async () => {
		// key: 'Z' (uppercase) — a real browser reports the shifted letter this
		// way on some platforms; this proves the shared policy's
		// `key.toLowerCase()` comparison matches regardless of reported case.
		dispatchKey(viewportEl!, { key: 'Z', ctrlKey: true, shiftKey: true })
	})
	assert.ok(ewUndo.doc.getShape('shape:undo-b'), 'Ctrl+Shift+Z drives editor.redo(), restoring shape:undo-b')
	console.log('ok: CanvasV2App — Ctrl+Shift+Z drives editor.redo() (case-insensitive key match)')
	await act(async () => {
		dispatchKey(viewportEl!, { key: 'z', ctrlKey: true }) // cleanup: undo the redo so this case nets zero shapes
	})
	assert.equal(ewUndo.doc.getShape('shape:undo-b'), undefined, 'cleanup: shape:undo-b undone again')

	// (f3) Ctrl+Y is the other bound redo key.
	await act(async () => {
		ewUndo.editor.apply({ type: 'CreateShape', shape: seedShape('shape:undo-c', 540, 540) })
	})
	await act(async () => {
		dispatchKey(viewportEl!, { key: 'z', ctrlKey: true }) // undo the create
	})
	assert.equal(ewUndo.doc.getShape('shape:undo-c'), undefined, 'precondition: shape:undo-c undone before testing Ctrl+Y')
	await act(async () => {
		dispatchKey(viewportEl!, { key: 'y', ctrlKey: true })
	})
	assert.ok(ewUndo.doc.getShape('shape:undo-c'), 'Ctrl+Y drives editor.redo(), restoring shape:undo-c')
	console.log('ok: CanvasV2App — Ctrl+Y drives editor.redo()')
	await act(async () => {
		dispatchKey(viewportEl!, { key: 'z', ctrlKey: true }) // cleanup: nets this case to zero shapes
	})
	assert.equal(ewUndo.doc.getShape('shape:undo-c'), undefined, 'cleanup: shape:undo-c undone again')

	// (f4) SUPPRESSION while editingId !== null: TextEditor owns the keyboard
	// (its own undo, per the textarea's native undo stack), so the shared
	// policy's editingId gate must block Ctrl+Z here too, same as Escape/
	// Delete/Backspace above — the just-created shape must survive the
	// keypress. Ending the edit and re-issuing Ctrl+Z proves the SAME
	// CreateShape is still sitting on top of the undo stack (untouched by the
	// suppressed attempt), not merely that nothing visibly changed.
	await act(async () => {
		ewUndo.editor.apply({ type: 'CreateShape', shape: seedShape('shape:undo-d', 560, 560) })
		ewUndo.editor.apply({ type: 'SetSelection', ids: ['shape:undo-d'] })
		ewUndo.editor.apply({ type: 'BeginEdit', id: 'shape:undo-d' })
	})
	assert.equal(ewUndo.editor.get().editingId, 'shape:undo-d', 'precondition: shape:undo-d is being edited')
	await act(async () => {
		dispatchKey(viewportEl!, { key: 'z', ctrlKey: true })
	})
	assert.ok(ewUndo.doc.getShape('shape:undo-d'), 'Ctrl+Z is a no-op while editingId!==null — the shape being edited must NOT be undone away')
	assert.equal(ewUndo.editor.get().editingId, 'shape:undo-d', 'editingId is unchanged by the suppressed Ctrl+Z')
	console.log('ok: CanvasV2App — Ctrl+Z is suppressed while editingId!==null (TextEditor owns the keyboard)')
	await act(async () => {
		ewUndo.editor.apply({ type: 'EndEdit' })
	})
	await act(async () => {
		dispatchKey(viewportEl!, { key: 'z', ctrlKey: true }) // now un-suppressed: undoes the CreateShape, cleanup to net zero
	})
	assert.equal(ewUndo.doc.getShape('shape:undo-d'), undefined, "cleanup: shape:undo-d's CreateShape is undone once editingId is cleared")

	// (f5) FROM THE TOOLBAR-FOCUSED PATH (the document-level listener, not
	// handleInput): proves the shared gate delivers Ctrl+Z regardless of
	// focus — the payoff of B3's handleGlobalShortcut extraction. Moves focus
	// to a toolbar button WITHOUT clicking it (no tool-switch side effect),
	// same technique (d4) uses above.
	const selectBtnUndo = container.querySelector('[data-canvas-v2-tool="select"]') as HTMLElement | null
	assert.ok(selectBtnUndo, `the select toolbar button must exist — DOM: ${container.innerHTML}`)
	await act(async () => {
		ewUndo.editor.apply({ type: 'CreateShape', shape: seedShape('shape:undo-e', 580, 580) })
	})
	assert.ok(ewUndo.doc.getShape('shape:undo-e'), 'precondition: shape:undo-e exists before the toolbar-focused Ctrl+Z')
	await act(async () => {
		selectBtnUndo!.focus()
	})
	assert.equal(document.activeElement, selectBtnUndo, 'precondition: the toolbar button holds focus, NOT the viewport')
	await act(async () => {
		dispatchKey(selectBtnUndo!, { key: 'z', ctrlKey: true })
	})
	assert.equal(
		ewUndo.doc.getShape('shape:undo-e'),
		undefined,
		'Ctrl+Z dispatched on a FOCUSED TOOLBAR BUTTON (the document-listener path) still drives editor.undo() — same shared gate as the viewport path',
	)
	console.log('ok: CanvasV2App — Ctrl+Z reaches editor.undo() even while a toolbar button holds focus (document-listener path)')

	// ==========================================================================
	// (e) UNMOUNT DISPOSES CLEANLY: no more sync reaches the (now-torn-down)
	// client peer. `window.__ew.doc` was set once by CanvasV2App's boot
	// sequence (the design's E2E hook) — capture that SAME doc reference
	// before unmount, then prove a further server-side write never reaches it
	// afterward. This is the closest thing to a "dispose was called" proof
	// available without reaching into CanvasV2App's private Session state:
	// SyncClientPeer.close() closes the transport, and canvas-sync's
	// makePair() closes BOTH sides of the pair together (memory-transport.ts:
	// `close: () => { if (open) { open = false; aClose?.(); bClose?.() } }`),
	// which the server observes via its own `onClose` -> removal from
	// `this.clients` (server-peer.ts's `connect()`) — so a post-unmount
	// server commit's broadcast has nothing left to deliver to.
	// ==========================================================================
	const ew = (globalThis as any).window.__ew as { doc: { listShapes(): unknown[] } }
	assert.ok(ew?.doc, 'window.__ew.doc must be set by the mount (the design\'s E2E hook)')
	const shapesBeforeUnmount = ew.doc.listShapes().length
	assert.equal(shapesBeforeUnmount, 2, 'precondition: the client doc holds both shapes right before unmount')

	await act(async () => {
		root.unmount()
	})

	await act(async () => {
		server.doc.putShape(seedShape('shape:post-unmount', 300, 300))
		server.doc.commit()
		await new Promise((r) => setTimeout(r, 0))
	})

	assert.equal(
		ew.doc.listShapes().length,
		shapesBeforeUnmount,
		'a server-side write AFTER unmount must never reach the disposed client doc — proves close()/dispose() actually tore down the transport',
	)
	console.log('ok: CanvasV2App — unmount disposes cleanly (no further sync reaches the torn-down client peer)')

	// ==========================================================================
	// (g) TASK E1 — THE "DEAD DOGFOOD" CASE: `connect()` REJECTS (mirrors
	// production's `defaultConnect` when the socket errors/closes before ever
	// opening — wrong port, route absent, EW_CANVAS_SYNC unset server-side).
	// Before this task, that rejection reached only the internal
	// `boot().catch(...)` console.error and left the mount stuck silently on
	// "Connecting to canvas…" forever, with `session` never set and NOTHING
	// visible telling a developer the room is dead. Now the ConnectionBanner
	// must render the 'failed' message.
	// ==========================================================================
	{
		function connectFailing(): Promise<Transport> {
			return Promise.reject(new Error('simulated dead dogfood: route absent'))
		}

		const failContainer = document.createElement('div')
		document.body.appendChild(failContainer)
		const failRoot = createRoot(failContainer)

		await act(async () => {
			failRoot.render(
				createElement(
					StrictMode,
					null,
					createElement(CanvasV2App, { roomId: 'dogfood-fail', userId: 'test-user-fail', connect: connectFailing, settleMs: 0 }),
				),
			)
			await new Promise((r) => setTimeout(r, 0))
			await new Promise((r) => setTimeout(r, 0))
		})

		const banner = failContainer.querySelector('[data-canvas-v2-connection-banner]')
		assert.ok(banner, `a ConnectionBanner must render when connect() rejects — DOM: ${failContainer.innerHTML}`)
		assert.equal(
			banner!.getAttribute('data-connection-state'),
			'failed',
			"a connect() rejection (socket errored/closed before ever opening) must land the banner on 'failed', not stay silently 'connecting'",
		)
		console.log("ok: CanvasV2App — a connect() rejection (dead dogfood) renders a visible ConnectionBanner in the 'failed' state")

		await act(async () => {
			failRoot.unmount()
		})
	}

	// ==========================================================================
	// (h) TASK E1 — BANNER SHOWS ON A POST-OPEN CLOSE, HIDES ON RECOVERY: a
	// transport wrapping a REAL memory-transport pair (so the session actually
	// mounts and syncs, same as case (a)) plus this task's additive
	// getConnectionState/onConnectionStateChange accessors, driven manually
	// here to simulate the wsClientTransport state machine's own transitions
	// (ws-client-transport.test.ts proves those transitions in isolation;
	// this proves CanvasV2App's OWN reaction to them: banner mounts/unmounts
	// the DOM node as `connectionState` changes, never blocking the canvas
	// underneath — the shape seeded below stays rendered throughout).
	// ==========================================================================
	{
		const server2 = new SyncServerPeer({ peerId: 3n })
		server2.doc.putPage({ id: 'page:p', name: 'Canvas' })
		server2.doc.putShape(seedShape('shape:banner-seed', 5, 5))
		server2.doc.commit()

		let liveTransport: {
			getConnectionState(): string
			onConnectionStateChange(cb: (s: string) => void): void
			simulateState(s: 'connecting' | 'open' | 'reconnecting' | 'failed'): void
		} | null = null

		function connectStateful(): Promise<Transport> {
			const [serverSide, clientSide]: [Transport, Transport] = makePair()
			server2.connect(serverSide)
			let state: 'connecting' | 'open' | 'reconnecting' | 'failed' = 'open' // resolves post-"open", mirroring defaultConnect
			let onStateCb: ((s: string) => void) | null = null
			const wrapped = {
				send: (bytes: Uint8Array) => clientSide.send(bytes),
				onMessage: (cb: (bytes: Uint8Array) => void) => clientSide.onMessage(cb),
				onClose: (cb: () => void) => clientSide.onClose(cb),
				close: () => clientSide.close(),
				getConnectionState: () => state,
				onConnectionStateChange: (cb: (s: string) => void) => {
					onStateCb = cb
				},
				simulateState: (s: 'connecting' | 'open' | 'reconnecting' | 'failed') => {
					state = s
					onStateCb?.(s)
				},
			}
			liveTransport = wrapped
			return Promise.resolve(wrapped as unknown as Transport)
		}

		const bannerContainer = document.createElement('div')
		document.body.appendChild(bannerContainer)
		const bannerRoot = createRoot(bannerContainer)

		await act(async () => {
			bannerRoot.render(
				createElement(
					StrictMode,
					null,
					createElement(CanvasV2App, { roomId: 'dogfood-banner', userId: 'test-user-banner', connect: connectStateful, settleMs: 0 }),
				),
			)
			await new Promise((r) => setTimeout(r, 0))
			await new Promise((r) => setTimeout(r, 0))
		})

		assert.ok(
			bannerContainer.querySelector('[data-shape-id="shape:banner-seed"]'),
			`precondition: the session mounted and rendered the seeded shape — DOM: ${bannerContainer.innerHTML}`,
		)
		assert.equal(
			bannerContainer.querySelector('[data-canvas-v2-connection-banner]'),
			null,
			"the banner must NOT render while connectionState is 'open'",
		)
		console.log('ok: CanvasV2App — no ConnectionBanner renders while the transport reports open')

		await act(async () => {
			liveTransport!.simulateState('reconnecting')
		})
		const reconnectingBanner = bannerContainer.querySelector('[data-canvas-v2-connection-banner]')
		assert.ok(
			reconnectingBanner,
			`a post-open transition to 'reconnecting' must render a visible ConnectionBanner — DOM: ${bannerContainer.innerHTML}`,
		)
		assert.equal(reconnectingBanner!.getAttribute('data-connection-state'), 'reconnecting')
		assert.ok(
			bannerContainer.querySelector('[data-shape-id="shape:banner-seed"]'),
			"the canvas underneath must still render while 'reconnecting' — the banner is an overlay, not a replacement",
		)
		console.log("ok: CanvasV2App — a post-open transition to 'reconnecting' renders the banner without hiding the canvas underneath")

		await act(async () => {
			liveTransport!.simulateState('open')
		})
		assert.equal(
			bannerContainer.querySelector('[data-canvas-v2-connection-banner]'),
			null,
			"the banner must disappear once connectionState recovers back to 'open'",
		)
		console.log('ok: CanvasV2App — the ConnectionBanner disappears once the connection recovers')

		await act(async () => {
			bannerRoot.unmount()
		})
	}

	console.log('ok: CanvasV2App.test.ts — all cases passed')
}

main()
	.catch((err) => {
		console.error(err)
		process.exit(1)
	})
	.finally(() => {
		// House rule (embed-reconciler.test.ts's precedent): happy-dom's window
		// owns timers (and this test's own setTimeout(0) flushes) that can hold
		// the process open past the last assertion.
		process.exit(0)
	})
