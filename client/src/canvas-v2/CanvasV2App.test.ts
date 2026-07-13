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
	// (d) UNMOUNT DISPOSES CLEANLY: no more sync reaches the (now-torn-down)
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
