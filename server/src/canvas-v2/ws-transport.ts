/**
 * wsTransport — the ONLY file in this workspace bridging a real `ws`
 * WebSocket to the clean-room canvas-sync Transport contract (see
 * canvas-sync/src/protocol.ts's JSDoc, which every adapter — the reference
 * in-memory pair AND this one — is built to). Every other canvas-v2 file
 * only ever sees `Transport`, never `ws`.
 *
 * Contract obligations this adapter upholds:
 *  - `close()` is idempotent.
 *  - `onClose` fires AT MOST ONCE per side, whichever of three triggers gets
 *    there first: the real ws `'close'` event, a real ws `'error'` event
 *    (treated as terminal — ws does not guarantee a `'close'` event follows
 *    an `'error'` promptly enough to depend on, so error alone must be
 *    sufficient to release the peer/registry side), or a local `close()`
 *    call. All three funnel through one `fireClose()` guarded by a `closed`
 *    flag, set BEFORE the callback runs (mirrors the memory transport, and
 *    satisfies the contract's "safe to close() reentrantly from inside
 *    onClose" clause).
 *  - After close, `send()` is a silent no-op — guarded by OUR OWN `closed`
 *    flag, not `ws.readyState`: a local `close()` call kicks off `ws.close()`
 *    asynchronously (the real WS close handshake), during which
 *    `ws.readyState` sits at CLOSING, not CLOSED, for a tick or more. Gating
 *    solely on `readyState` would let sends through during that window.
 *  - `onMessage`/`onClose` are single-listener, last-writer-wins — like the
 *    memory transport (`makePair`), NOT ordinary multi-listener EventEmitter
 *    semantics. Each holds exactly one slot; a second registration replaces
 *    the first rather than adding a second delivery. One real `ws` listener
 *    per event is installed once, at adapter-construction time, and always
 *    dispatches to whatever is currently in the slot — so peers that (like
 *    every peer in this codebase) register exactly once behave identically
 *    to plain callbacks, but a stray re-registration can't leak/duplicate.
 *
 * Message normalization: `ws`'s `'message'` event delivers
 * `Buffer | ArrayBuffer | Buffer[]` (see `@types/ws`'s `WebSocket.RawData`) —
 * the exact shape depends on the socket's `binaryType` (default
 * `'nodebuffer'`) and fragmentation. This adapter never touches `binaryType`,
 * so under the default every non-degenerate frame arrives as a single
 * concatenated `Buffer` — the same assumption the existing tldraw `/sync`
 * path relies on implicitly (its message handlers elsewhere in this
 * workspace treat `data` as a `Buffer`). Still, `RawData`'s declared type is
 * a union, so `toBytes` below normalizes all three shapes defensively rather
 * than assuming: `Buffer`/`ArrayBuffer` convert directly to a `Uint8Array`
 * view, and a `Buffer[]` (only reachable if `binaryType` were set to
 * `'fragments'`, which nothing here does) is concatenated first.
 */
import type { Transport } from '@ensembleworks/canvas-sync'
import type { WebSocket } from 'ws'

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
	if (Array.isArray(data)) return toBytes(Buffer.concat(data))
	if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
	return new Uint8Array(data)
}

export function wsTransport(ws: WebSocket): Transport {
	let closed = false
	let onCloseCb: (() => void) | null = null
	let onMessageCb: ((bytes: Uint8Array) => void) | null = null

	const fireClose = () => {
		if (closed) return
		closed = true
		onCloseCb?.()
	}

	// Installed once, unconditionally — see the class-doc note on single-
	// listener last-writer-wins onMessage/onClose above.
	ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => onMessageCb?.(toBytes(data)))
	ws.once('close', fireClose)
	ws.once('error', fireClose)

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
			// callback runs, mirroring the memory transport) so a listener that
			// reentrantly calls close() sees `closed` already true. Real socket
			// teardown follows: ws.close() is the graceful handshake, which
			// resolves later via the 'close' listener above — fireClose's guard
			// makes that eventual event a no-op.
			fireClose()
			try {
				ws.close()
			} catch {
				ws.terminate()
			}
		},
	}
}
