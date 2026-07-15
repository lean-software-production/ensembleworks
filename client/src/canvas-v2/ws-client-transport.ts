/**
 * wsClientTransport — the browser twin of server/src/canvas-v2/ws-transport.ts
 * (which bridges a `ws`-package server socket to the same contract). This is
 * the ONLY file in the client bridging a real browser `WebSocket` to the
 * clean-room `@ensembleworks/canvas-sync` `Transport` contract (protocol.ts's
 * JSDoc) — every other canvas-v2 client file only ever sees `Transport`,
 * never a raw `WebSocket`.
 *
 * Contract obligations this adapter upholds (mirrors the server adapter's
 * doc comment, browser API differences noted inline below):
 *  - `close()` is idempotent.
 *  - `onClose` fires AT MOST ONCE per side, whichever of three triggers gets
 *    there first: the real ws `close` event, a real ws `error` event
 *    (treated as terminal — a browser WebSocket does not guarantee a `close`
 *    event follows an `error` promptly enough to depend on, same reasoning
 *    as the server adapter), or a local `close()` call. All three funnel
 *    through one `fireClose()` guarded by a `closed` flag, set BEFORE the
 *    callback runs — safe to `close()` reentrantly from inside `onClose`.
 *  - After close, `send()` is a silent no-op — guarded by OUR OWN `closed`
 *    flag, not `ws.readyState` alone: a local `close()` call kicks off the
 *    browser's async close handshake, during which `readyState` sits at
 *    CLOSING (2), not CLOSED (3), for a tick or more. Gating solely on
 *    `readyState` would let sends through during that window.
 *  - `onMessage`/`onClose` are single-listener, last-writer-wins — like the
 *    memory transport and the server ws adapter, NOT ordinary multi-listener
 *    EventEmitter semantics. Implemented here by assigning the browser
 *    WebSocket's own `onmessage`/`onclose`/`onerror` PROPERTIES (not
 *    `addEventListener`) — the DOM itself already gives property assignment
 *    single-slot, last-writer-wins semantics, so this adapter's own
 *    `onMessage`/`onClose` registration methods just store the CALLER's
 *    latest callback in a plain variable and dispatch to whatever is
 *    currently there, exactly like the server adapter's `onMessageCb`/
 *    `onCloseCb` pattern.
 *
 * BINARY MODE (load-bearing, not a default left alone): this adapter sets
 * `ws.binaryType = 'arraybuffer'` itself, synchronously, before wiring any
 * handler — canvas-sync's frames are raw Loro bytes (protocol.ts's `encode`/
 * `decode`), and the browser WebSocket's OTHER default binary representation
 * (`'blob'`) requires an async `Blob.arrayBuffer()` read before the bytes are
 * usable, which would turn `onMessage`'s dispatch into a Promise chain and
 * reorder frames relative to arrival (two same-tick messages could resolve
 * out of order). `'arraybuffer'` delivers `MessageEvent.data` as an
 * `ArrayBuffer` synchronously, matching the server adapter's synchronous
 * `Buffer`/`Uint8Array` normalization.
 *
 * PRODUCTION USAGE NOTE (not this adapter's problem, but load-bearing for
 * whoever constructs one — CanvasV2App): a `WebSocket`'s `send()` is a
 * silent no-op while `readyState` is CONNECTING/CLOSING/CLOSED — this
 * adapter's own `closed`-flag guard aside, the underlying browser socket
 * itself won't actually deliver anything until the `open` event fires. A
 * caller that constructs a `SyncClientPeer` over this transport BEFORE the
 * socket opens will have its constructor-time `requestSync()` silently
 * dropped (the Transport contract promises no delivery pre-open, not
 * buffering) — CanvasV2App is responsible for awaiting the socket's `open`
 * event before constructing the `SyncClientPeer`, exactly as it must await
 * DOM readiness for anything else it mounts.
 */
import type { Transport } from '@ensembleworks/canvas-sync'

/** The minimal structural surface this adapter needs off a WebSocket — a
 * real DOM `WebSocket` instance satisfies it for free (assigning to
 * `binaryType`/`onmessage`/`onclose`/`onerror` and calling `send`/`close` are
 * all real `WebSocket` operations); ws-client-transport.test.ts fabricates a
 * plain object literal instead (no jsdom/real-socket dependency), the same
 * "structural parameter type" pattern canvas-react's dom-events.ts documents
 * for its own event mappers. `OPEN` is read off the instance (browsers
 * expose `WebSocket.prototype.OPEN === 1`, so a real socket satisfies this
 * for free) rather than hardcoded, mirroring the server adapter's own
 * `ws.OPEN` read and its test fake's explicit `OPEN` field.
 *
 * NOT SATISFIED BY A REAL `WebSocket` DIRECTLY (a deliberate, narrow gap):
 * the DOM's own `WebSocket.onmessage`/`onclose`/`onerror` property types are
 * declared against the specific `MessageEvent`/`CloseEvent`/`Event` classes,
 * which — being richer than this interface's `{ data: unknown }`/
 * no-argument shapes — fail `strictFunctionTypes`' contravariant parameter
 * check against these narrower structural types. The one real call site
 * (CanvasV2App.tsx's `defaultConnect`) casts explicitly
 * (`wsClientTransport(ws as unknown as WebSocketLike)`) rather than loosening
 * this interface to `any` — a real `WebSocket` instance satisfies every
 * runtime obligation this adapter actually relies on (assignability to
 * `onmessage`/`onclose`/`onerror`, a numeric `readyState`, a `send`/`close`
 * pair), the cast is papering over TS's variance strictness, not a real
 * behavioral mismatch. ws-client-transport.test.ts's fabricated `FakeWs`
 * satisfies this interface exactly, with no cast needed, since it declares
 * its fields against this SAME narrower shape. */
export interface WebSocketLike {
	readyState: number
	readonly OPEN: number
	binaryType: string
	send(data: Uint8Array): void
	close(): void
	onmessage: ((ev: { readonly data: unknown }) => void) | null
	onclose: (() => void) | null
	onerror: (() => void) | null
}

/** Normalize a `MessageEvent.data` value to `Uint8Array`. Under
 * `binaryType: 'arraybuffer'` (which this adapter always sets — see the
 * module header) a real browser delivers `ArrayBuffer`; a `Uint8Array` is
 * accepted too purely for test-fabrication convenience (a fake `WebSocketLike`
 * emitting one directly, with no `ArrayBuffer` round-trip). Anything else
 * (a stray string frame, a `Blob` from a caller that reset `binaryType`
 * after construction — not a scenario this adapter's own construction path
 * can produce) is dropped rather than thrown: a malformed/unexpected inbound
 * shape must not crash the socket's message dispatch, matching this
 * codebase's house tolerance posture (e.g. SyncClientPeer.onFrame's
 * malformed-frame catch-and-log). */
function toBytes(data: unknown): Uint8Array | null {
	if (data instanceof Uint8Array) return data
	if (data instanceof ArrayBuffer) return new Uint8Array(data)
	return null
}

export function wsClientTransport(ws: WebSocketLike): Transport {
	let closed = false
	let onCloseCb: (() => void) | null = null
	let onMessageCb: ((bytes: Uint8Array) => void) | null = null

	const fireClose = (): void => {
		if (closed) return
		closed = true
		onCloseCb?.()
	}

	// Set BEFORE any handler is wired — see the module header's BINARY MODE
	// note. Synchronous: no message can arrive before this line runs (the
	// caller hands us an already-constructed-but-maybe-not-yet-open socket).
	ws.binaryType = 'arraybuffer'
	ws.onmessage = (ev) => {
		const bytes = toBytes(ev.data)
		if (bytes) onMessageCb?.(bytes)
	}
	ws.onclose = fireClose
	ws.onerror = fireClose

	return {
		send(bytes) {
			if (closed) return
			if (ws.readyState === ws.OPEN) ws.send(bytes)
		},
		onMessage(cb) {
			onMessageCb = cb
		},
		onClose(cb) {
			onCloseCb = cb
		},
		close() {
			if (closed) return
			// Fire the app-level callback first (closed flag set before the
			// callback runs, mirroring the server adapter) so a listener that
			// reentrantly calls close() sees `closed` already true. Real socket
			// teardown follows: ws.close() is the graceful handshake, which
			// resolves later via the 'close'/onclose assignment above —
			// fireClose's guard makes that eventual event a no-op. No
			// try/catch-then-terminate fallback here (unlike the server
			// adapter's `ws.terminate()`): a browser WebSocket has no forceful
			// `terminate()` escape hatch, and `close()` on an already-
			// closing/closed browser socket is itself a documented no-op, not a
			// throw.
			fireClose()
			ws.close()
		},
	}
}
