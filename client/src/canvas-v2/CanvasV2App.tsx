/**
 * CanvasV2App — the dogfood mount: composes editor + renderer + shapes +
 * sync into a LIVE canvas behind `selectEngine` (engine.ts). Reachable ONLY
 * via main.tsx's engine branch (see that file) — never imported/rendered
 * outside that guard (Task G6's exposure audit pins this at the repo
 * level).
 *
 * CONSTRUCTION SEQUENCE (once per mount, StrictMode-safe — see the EmbedHost
 * lesson canvas-react/src/embed/EmbedHost.tsx names: construct lazily inside
 * an effect, tear down in that SAME effect's cleanup, never at module/render
 * scope):
 *   1. `connect()` (prop-injectable — see CanvasV2AppProps) resolves a
 *      canvas-sync `Transport`. The DEFAULT dials a real `WebSocket` at
 *      `${wsBase()}/sync/v2/${roomId}?userId=...` (mirrors how the legacy
 *      `<App/>`'s `useSync` builds its own sync URL — see App.tsx's
 *      `wsBase`/URI construction) wrapped in `wsClientTransport`, resolving
 *      once the socket's `open` event fires — see that module's PRODUCTION
 *      USAGE NOTE for why open-before-construct matters (a `SyncClientPeer`
 *      constructed too early has its handshake silently dropped).
 *   2. `new SyncClientPeer({ peerId: randomPeerId(), transport })` — a
 *      fresh, crypto-seeded 64-bit peer id per browser tab (never the
 *      server's fixed `1n`, see server/src/canvas-v2/actors.ts).
 *   3. Wait for sync readiness: race `peer.ready()` (resolves on the server's
 *      Frame.SyncDone, sent right after the backfill Update) against a bounded
 *      safety cap (`settleMs`, prop-injectable, default `SETTLE_MS_DEFAULT`),
 *      so boot proceeds the instant the room is caught up and the cap only
 *      bites if readiness never arrives. Tests pass `settleMs: 0`; over a
 *      synchronous memory transport ready() is already resolved by the time
 *      `connect()` resolves, so both settle instantly.
 *   4. `resolvePageId(peer.doc)` (bootstrap-page.ts) — adopts the room's
 *      existing page if any, else bootstraps the `page:p` convention.
 *   5. `new Editor({ doc: peer.doc, now, random, pageId })` — `now`/`random`
 *      are real (`performance.now`/crypto-seeded), injected HERE at the
 *      COMPOSITION EDGE: canvas-editor's own boundary rule forbids reading
 *      either directly inside the package (editor.ts's `EditorOpts` doc
 *      comment), but client app code is exactly the layer allowed to reach
 *      for a real clock/PRNG — this is that layer.
 *   6. `createToolContext(editor)` + `registerCanvasV2Shapes()` + `registerCoreShapes()`
 *      (both idempotently guarded inside their own function, order-independent —
 *      they populate the same process-wide canvas-react shapeRegistry Map)
 *      + `createToolSet(toolContext)` (tool-loop.ts).
 *   7. `window.__ew = { editor, doc: peer.doc, presencePublisher }` — the
 *      design's E2E debug hook (mirrors the legacy app's `window.__ewEditor`,
 *      App.tsx). `presencePublisher` (Task G4) lets a test drive this
 *      mount's own presence publishes without simulating real DOM events.
 * Disposal (effect cleanup): `toolContext.dispose()` then `peer.close()` —
 * see canvas-react's CALLER OBLIGATIONS note (index.ts) for why the
 * dispose() call is non-optional. A `cancelled` flag guards the async boot
 * sequence itself so an unmount that lands mid-connect (StrictMode's
 * simulated double-mount) tears down whatever got constructed instead of
 * leaking a dangling socket/peer that nothing will ever dispose.
 *
 * TOOL LOOP: `onInput` (Viewport's prop) dispatches to the currently active
 * tool (tool-loop.ts's `dispatchToActiveTool`) except `wheel`, which is
 * handled UNIFORMLY via `applyWheel` regardless of active tool — mirroring
 * the hand tool's own wheel-is-tool-independent policy (canvas-editor's
 * tools/hand.ts) at the mount level, since wheel-zoom/pan must work no
 * matter which tool button is pressed, not just while the hand tool is
 * active.
 *
 * ABANDONMENT-CANCEL WIRING: FOUR triggers all call `tool-loop.ts`'s
 * `cancelActiveTool` (via this component's `cancelAndReset` — see that
 * function's doc comment for exactly which tools' in-flight preview shapes
 * get deleted vs. merely reset to idle): `onViewportBlur` (Viewport's
 * designated hook — see its own module header), the toolbar's tool-switch
 * handler, `onViewportBlur`'s sibling `onPointerCancel` (Task B3 — Viewport's
 * own POINTERCANCEL note: the browser hands the pointer away mid-gesture
 * with no pointerup, e.g. a touch scroll reinterpreted as a page gesture),
 * and an Escape keydown (Task B3 — via the shared `handleGlobalShortcut`
 * policy, gated on `editingId === null` the same way Delete/Backspace is, so
 * TextEditor's own Escape-ends-editing keeps working).
 * `document.visibilitychange` (tab hidden while still focused) is NOT wired —
 * canvas-react's Viewport module header names it as "a documented, deferred
 * extension of the same hook," and this unit inherits that deferral rather
 * than closing it.
 *
 * GLOBAL KEYBOARD-DELIVERY FALLBACK (Task B3, carried from B2's review): the
 * app-global shortcuts (Escape/Delete/Backspace) reach TWO keydown entry
 * points — Viewport's onKeyDown -> `handleInput` (for viewport-focused
 * keydowns) AND a SECOND, document-level keydown listener (below, near the
 * toolbar JSX) that catches keydowns delivered to a focused toolbar
 * `<button>` — a DOM SIBLING of Viewport, not a descendant — whose keydown
 * never bubbles into Viewport's own listener. BOTH funnel through the single
 * `handleGlobalShortcut` policy (defined next to `cancelAndReset` below), so
 * the key->action mapping lives in exactly ONE place — B4's
 * Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y undo/redo branch was a one-site addition there
 * and works from both paths for exactly that reason; the document listener's
 * own containment guard keeps the two paths mutually exclusive (no
 * double-handling). See both functions' doc comments.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
// Task C6b — the tldraw handwriting/text webfonts (tldraw_draw/_sans/_serif/
// _mono), self-hosted from client/public/fonts/tldraw/ (see fonts.css's own
// header for the full why/licensing). Side-effect import, same pattern as
// canvas-v2/shapes/RoadmapShape.tsx's `roadmap.css` import: v1's `<Tldraw>`
// registers these fonts itself via its FontManager, but CanvasV2App never
// mounts that editor, so this is the ONLY place v2's real dogfood mount
// gets them from.
import './fonts.css'
import {
	Editor,
	applyWheel,
	createToolContext,
	duplicateSelectionIntents,
	pasteIntents,
	reorderSelectionIntents,
	type InputEvent,
	type Intent,
	type KeyInputEvent,
	type SetStyle,
	type ToolContext,
} from '@ensembleworks/canvas-editor'
import { encodeClipboard, serializeSelection } from '@ensembleworks/canvas-model'
import { PresenceStore, SyncClientPeer, type Transport } from '@ensembleworks/canvas-sync'
import {
	Cursors,
	EmbedLayer,
	Grid,
	Overlay,
	registerCoreShapes,
	ShapeLayer,
	TextEditor,
	Viewport,
	WorldLayer,
	useDocSnapshot,
	useEditorState,
	type ViewportSize,
} from '@ensembleworks/canvas-react'
import { getIdentity, getRoomId } from '../identity.js'
import { wsClientTransport, type ConnectionState, type WebSocketLike } from './ws-client-transport.js'
import { resolvePageId } from './bootstrap-page.js'
import { adaptPresence, createPresencePublisher, type PresencePublisher } from './presence.js'
import { EditingIndicators } from './EditingIndicators.js'
import { DevOverlay, shouldShowDevOverlayFromEnvironment, useCanvasMetrics } from './DevOverlay.js'
import { canvasV2EmbedLifecycles, registerCanvasV2Shapes } from './shapes/index.js'
import { presentStoreV2 } from './shapes/presentStoreV2.js'
import { StylePanel } from './StylePanel.js'
import type { StyleAxis, StyleValue } from './style-axes.js'
import {
	cancelActiveTool,
	createInitialToolStates,
	createToolSet,
	currentSnapResult,
	deleteSelectionIntents,
	dispatchToActiveTool,
	pruneDanglingSelectionIntents,
	type ToolId,
	type ToolSet,
	type ToolStates,
} from './tool-loop.js'
import { clipboardShortcut, readClipboardText, writeClipboardText } from './clipboard-dom.js'
import { reorderShortcut } from './reorder-dom.js'

/** How long an embed (terminal/iframe/…) may sit off-screen before
 * EmbedLayer suspends it — see embedLifecycle.ts's `suspendAfterTicks` doc.
 * One tick = one second (the `tick` interval below), so 3 means "more than
 * 3 consecutive invisible seconds." Not exposed as a prop: this v1 mount has
 * one policy, not a per-caller-tunable one. */
const SUSPEND_AFTER_TICKS = 3

/** SAFETY CAP for the boot handshake: boot() races SyncClientPeer.ready()
 * (resolves the instant the server sends Frame.SyncDone after its backfill)
 * against this timer, so a healthy room proceeds as soon as sync completes and
 * only a transport that never signals readiness waits the full cap. See
 * CONSTRUCTION SEQUENCE step 3 / bootstrap-page.ts's note. */
const SETTLE_MS_DEFAULT = 400

/** True for a real text input/textarea/contentEditable element — see the
 * GLOBAL KEYBOARD-DELIVERY FALLBACK effect's own doc comment for why this
 * mount's document-level shortcut listener defers to one rather than
 * stealing its keydown. Duck-typed on `tagName` (NOT `node instanceof
 * Element`) deliberately: this module has no ambient DOM lib global of its
 * own (a real browser tab provides `Element` for free, but this house's
 * happy-dom-based tests only ever install `window`/`document` onto
 * `globalThis`, never `Element` itself — an `instanceof Element` check would
 * throw `ReferenceError: Element is not defined` there, silently killing
 * this whole listener). */
function isEditableTarget(node: Node | null): boolean {
	if (!node || typeof (node as { tagName?: unknown }).tagName !== 'string') return false
	const el = node as HTMLElement
	return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
}

function wsBase(): string {
	const proto = location.protocol === 'https:' ? 'wss' : 'ws'
	return `${proto}://${location.host}`
}

/** Real transport factory — dials `${wsBase()}/sync/v2/${roomId}` (mirrors
 * how App.tsx builds the legacy `/sync/${roomId}` URI) and resolves once the
 * socket is open. See the module header's CONSTRUCTION SEQUENCE step 1. */
function defaultConnect(roomId: string, userId: string): () => Promise<Transport> {
	return () =>
		new Promise<Transport>((resolve, reject) => {
			const url = `${wsBase()}/sync/v2/${roomId}?userId=${encodeURIComponent(userId)}`
			const ws = new WebSocket(url)
			// See ws-client-transport.ts's WebSocketLike doc comment ("NOT
			// SATISFIED BY A REAL WebSocket DIRECTLY") for why this cast is
			// needed and why it's safe: a real WebSocket satisfies every
			// runtime obligation the adapter relies on; only TS's
			// strictFunctionTypes variance check on the event-handler
			// properties objects.
			const transport = wsClientTransport(ws as unknown as WebSocketLike)
			const onOpen = () => {
				ws.removeEventListener('open', onOpen)
				ws.removeEventListener('error', onError)
				resolve(transport)
			}
			const onError = () => {
				ws.removeEventListener('open', onOpen)
				ws.removeEventListener('error', onError)
				reject(new Error(`canvas-v2 sync socket failed to open: ${url}`))
			}
			ws.addEventListener('open', onOpen)
			ws.addEventListener('error', onError)
		})
}

/** Feature-detects `wsClientTransport`'s additive connection-state accessors
 * (Task E1 — `ws-client-transport.ts`'s `TransportWithConnectionState`) on a
 * resolved `Transport`. Needed because `connect` is a test seam: production's
 * `defaultConnect` always hands back a transport carrying these, but the
 * integration test (CanvasV2App.test.ts) and any other injected `connect`
 * hand back a PLAIN `Transport` (a canvas-sync memory-transport pair) with no
 * such accessors — this mount must tolerate their absence rather than assume
 * every transport reports live connection state, falling back to the
 * boot-sequence-derived 'open' set at this function's one call site below. */
function hasConnectionState(
	t: Transport,
): t is Transport & { getConnectionState(): ConnectionState; onConnectionStateChange(cb: (state: ConnectionState) => void): void } {
	const maybe = t as { getConnectionState?: unknown; onConnectionStateChange?: unknown }
	return typeof maybe.getConnectionState === 'function' && typeof maybe.onConnectionStateChange === 'function'
}

/** Crypto-seeded [0, 1) float — the `random` canvas-editor's create/arrow
 * tools use for id generation (see canvas-editor/src/tools/create.ts's
 * `makeId` COLLISION PRECONDITION doc: real entropy is half of what closes
 * the cross-session id-collision gap it names; this is that half, injected
 * at the composition edge). */
function cryptoRandom(): number {
	return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32
}

/** A fresh, crypto-seeded 64-bit Loro peer id per mount. Never the server's
 * fixed `1n` (server/src/canvas-v2/actors.ts's `SERVER_PEER_ID`) or the
 * degenerate `0n` — astronomically unlikely to land on either from 64 real
 * random bits, but cheap to guard against explicitly rather than merely
 * trust the odds. */
function randomPeerId(): bigint {
	const bytes = crypto.getRandomValues(new Uint32Array(2))
	const value = (BigInt(bytes[0]!) << 32n) | BigInt(bytes[1]!)
	return value === 0n || value === 1n ? randomPeerId() : value
}

function delay(ms: number): Promise<void> {
	return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()
}

/** Task P4 — pure mapping from a StylePanel axis change to the `SetStyle`
 * intent E1 defines: `opacity` is an ENVELOPE field (`shape.opacity`, per
 * SetStyle's own interface — canvas-editor/src/intents.ts), so that axis
 * routes through `opacity`, NEVER `props.opacity` (E1's applyOne only ever
 * writes the envelope field from THIS key, and canvas-react's ShapeBody
 * only ever reads `shape.opacity` — a value parked in `props.opacity`
 * would silently never render). Every other axis is a `props` key patch.
 * Exported so this mapping is unit-testable in isolation, without booting a
 * session (see CanvasV2App.test.ts's style-panel wiring cases) — `ids` is
 * an explicit parameter (not read from `editor` here) so the test can pass
 * a plain array and assert the exact intent shape. */
export function buildSetStyleIntent(ids: readonly string[], axis: StyleAxis, value: StyleValue): SetStyle {
	return axis === 'opacity' ? { type: 'SetStyle', ids, opacity: Number(value) } : { type: 'SetStyle', ids, props: { [axis]: value } }
}

interface Session {
	readonly peer: SyncClientPeer
	readonly editor: Editor
	readonly toolContext: ToolContext
	readonly tools: ToolSet
	/** This mount's OWN presence store — injected into `peer` at construction
	 * (see CONSTRUCTION SEQUENCE step 2) so `peer` forwards local publishes
	 * over the wire and applies inbound Presence frames into it. Owned here
	 * (not by SyncClientPeer — see its own doc comment on the injected
	 * option) so disposal calls `.destroy()` on it directly (the WASM expiry-
	 * timer caveat — canvas-sync/src/presence.ts's own `destroy()` doc
	 * comment: "Peers do NOT call this from their close()... callers that own
	 * a PresenceStore's lifecycle... should call this to release it"). */
	readonly presenceStore: PresenceStore
	readonly presencePublisher: PresencePublisher
	/** The presence map's own key for THIS peer (== the mount's userId) —
	 * carried alongside presenceStore so CanvasV2Session can pass it to
	 * Cursors' required `selfKey` prop without re-deriving identity. */
	readonly selfKey: string
}

export interface CanvasV2AppProps {
	readonly roomId?: string
	readonly userId?: string
	/** Test seam — see the module header's CONSTRUCTION SEQUENCE step 1.
	 * Production omits it (defaults to `defaultConnect`); the integration
	 * test injects a memory-transport pair wired to an in-process
	 * `SyncServerPeer` instead of a real socket. */
	readonly connect?: () => Promise<Transport>
	/** Test seam — the boot readiness safety cap (see step 3 / SETTLE_MS_DEFAULT).
	 * Production omits it (defaults to `SETTLE_MS_DEFAULT`); tests pass 0. */
	readonly settleMs?: number
}

export function CanvasV2App(props: CanvasV2AppProps) {
	const roomId = props.roomId ?? getRoomId()
	const userId = props.userId ?? getIdentity().id
	const [session, setSession] = useState<Session | null>(null)
	const sessionRef = useRef<Session | null>(null)
	// Task E1 — the REAL connection-state signal (see ws-client-transport.ts's
	// ConnectionState), driving ConnectionBanner below. Starts 'connecting'
	// (the initial dial, before `connect()` has settled either way) rather
	// than the old naive `session ? 'connected' : 'connecting'` derivation,
	// which could never observe a pre-session failure at all — the "dead
	// dogfood" bug this task exists to fix.
	const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')

	useEffect(() => {
		let cancelled = false

		async function boot(): Promise<void> {
			const doConnect = props.connect ?? defaultConnect(roomId, userId)
			let transport: Transport
			try {
				transport = await doConnect()
			} catch (err) {
				// The "dead dogfood" case (EW_CANVAS_SYNC unset server-side, wrong
				// port, route absent, …): `defaultConnect`'s promise REJECTS when the
				// socket errors before ever opening, and — before this task — that
				// rejection only ever reached the outer `boot().catch(...)` below,
				// leaving `session` null forever and the mount stuck silently on
				// "Connecting to canvas…" with no visible signal anything was wrong.
				// Surface it here, then rethrow so the existing console.error logging
				// (and any future caller of boot()'s own promise) is unchanged.
				if (!cancelled) setConnectionState('failed')
				throw err
			}
			if (cancelled) {
				transport.close()
				return
			}
			// Once connected, prefer the transport's OWN live connection-state
			// signal (production's wsClientTransport — see hasConnectionState's own
			// doc comment for why this is feature-detected rather than assumed):
			// seed the current value immediately, then subscribe for LATER
			// transitions (a post-open close/error lands on 'reconnecting', not
			// tracked by anything else in this mount — see that state's own
			// inferred-not-a-real-retry doc comment on ConnectionState). A test
			// seam's plain Transport (no such accessors) falls back to a flat
			// 'open' — the resolved promise already means "connected" for it.
			if (hasConnectionState(transport)) {
				setConnectionState(transport.getConnectionState())
				transport.onConnectionStateChange((s) => {
					if (!cancelled) setConnectionState(s)
				})
			} else {
				setConnectionState('open')
			}
			// PresenceStore (Task G4): `selfKey` = this mount's userId — the SAME
			// identity value the wire URL's `?userId=` and `randomPeerId()`'s Loro
			// peer id both derive from, but a DIFFERENT namespace than either (a
			// plain string key into the presence map, not a Loro peer id) — see
			// presence.ts's adaptPresence doc comment for what a caller reads back
			// out of `PresenceStore.all()` keyed by this same string.
			const presenceStore = new PresenceStore(userId)
			if (cancelled) {
				presenceStore.destroy()
				transport.close()
				return
			}
			const peer = new SyncClientPeer({ peerId: randomPeerId(), transport, presence: presenceStore })
			// Proceed the instant the server signals sync-complete: peer.ready()
			// resolves on Frame.SyncDone (sent right after the backfill Update), so
			// existing shapes are already imported by the time we resolve the page
			// id and build the Editor. The settle timer is now only a SAFETY CAP for
			// a pathological transport that never signals readiness — not a fixed
			// tax on every boot. Over a synchronous memory transport (tests) ready()
			// is already resolved here and delay(0) is an immediate Promise.resolve,
			// so both settle instantly; settleMs:0 semantics are unchanged.
			await Promise.race([peer.ready(), delay(props.settleMs ?? SETTLE_MS_DEFAULT)])
			if (cancelled) {
				presenceStore.destroy()
				peer.close()
				return
			}
			const pageId = resolvePageId(peer.doc)
			const editor = new Editor({ doc: peer.doc, now: () => performance.now(), random: cryptoRandom, pageId })
			const toolContext = createToolContext(editor)
			registerCanvasV2Shapes()
			registerCoreShapes()
			const tools = createToolSet(toolContext)
			const presencePublisher = createPresencePublisher(presenceStore)
			const s: Session = { peer, editor, toolContext, tools, presenceStore, presencePublisher, selfKey: userId }
			sessionRef.current = s
			// Task D5: hands this mount's live publisher to the shared
			// presentStoreV2 singleton, so a shape body (FileViewerShape's own
			// presenting toggle/scroll) can ride this SAME combined-write
			// channel — see presentStoreV2.ts's PUBLISHER HANDLE doc comment.
			presentStoreV2.setPublisher(presencePublisher)
			// The design's E2E debug hook (mirrors the legacy app's
			// window.__ewEditor — App.tsx's handleMount). `presencePublisher` rides
			// along so an E2E/integration test can drive this mount's OWN presence
			// publishes (cursor/viewport) without simulating real pointer/wheel DOM
			// events — see CanvasV2App.test.ts's presence case.
			;(window as unknown as { __ew?: { editor: Editor; doc: SyncClientPeer['doc']; presencePublisher: PresencePublisher } }).__ew = {
				editor,
				doc: peer.doc,
				presencePublisher,
			}
			setSession(s)
		}

		boot().catch((err) => {
			console.error('[canvas-v2] CanvasV2App failed to connect:', err)
		})

		return () => {
			cancelled = true
			const s = sessionRef.current
			sessionRef.current = null
			setSession(null)
			if (s) {
				s.toolContext.dispose()
				s.peer.close()
				// destroy() releases the PresenceStore's WASM expiry timer — see the
				// Session interface's doc comment on why THIS mount (not
				// SyncClientPeer) owns that call.
				s.presenceStore.destroy()
				// Task D5: this mount's publisher no longer exists — clear the
				// shared handle so a FileViewerShape body rendered after teardown
				// (or in the next mount's brief pre-boot window) finds `null`
				// rather than a stale, destroyed-store publisher. Clear the peers
				// cache too (FIX 3) so a next-session FileViewerShape in the
				// pre-first-poll window can't resolve `presenterFor` against the
				// previous session's stale peers.
				presentStoreV2.setPublisher(null)
				presentStoreV2.setPeers({}, '')
			}
		}
		// roomId/userId identify the WHOLE session — a change remounts it
		// fresh (transport, doc, editor, everything) rather than migrating an
		// existing Editor to a new room, same "different key = a different
		// session" posture TerminalShape.tsx documents for its own
		// sessionId-keyed remount.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [roomId, userId])

	// Dev overlay (Task G5) — computed once per mount (doesn't need to react
	// to a mid-session URL edit); gated a SECOND time here beyond "this is
	// canvas-v2 at all" per DevOverlay.tsx's own GATING note.
	const [showDevOverlay] = useState(shouldShowDevOverlayFromEnvironment)
	// Called UNCONDITIONALLY (rules of hooks) — `enabled: showDevOverlay`
	// skips the actual fetch/interval entirely when the overlay is hidden
	// (see useCanvasMetrics's own doc comment).
	const metrics = useCanvasMetrics(showDevOverlay)

	return (
		<>
			{/* Task E1 — an OVERLAY, not a replacement: rendered unconditionally
			    (it self-hides once `connectionState === 'open'`) so a room that
			    lost its connection AFTER establishing a session keeps showing the
			    last-known canvas underneath, per this task's own "don't block the
			    canvas" requirement. */}
			<ConnectionBanner state={connectionState} />
			{!session ? <ConnectingPlaceholder /> : <CanvasV2Session session={session} />}
			{showDevOverlay && (
				<DevOverlay
					roomId={roomId}
					connectionState={session ? 'connected' : 'connecting'}
					client={{ repairCount: session?.peer.repairCount ?? 0, lastBackfillBytes: session?.peer.lastBackfillBytes ?? 0, invalidWriteCount: session?.peer.doc.invalidWriteCount ?? 0 }}
					metrics={metrics}
				/>
			)}
		</>
	)
}

function ConnectingPlaceholder() {
	return (
		<div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', fontFamily: 'system-ui, sans-serif', color: '#6b7280' }}>
			Connecting to canvas…
		</div>
	)
}

/** Task E1 — a small fixed overlay strip surfacing `connectionState` whenever
 * it is anything other than 'open', so a half-configured/dead dogfood room
 * (EW_CANVAS_SYNC unset server-side, wrong port, route absent — the socket
 * errors/closes before ever opening, landing on 'failed') is visibly
 * signaled instead of rendering a silent dead canvas. Hides itself entirely
 * once state recovers to 'open' — see the call site's own doc comment for why
 * this is unconditionally mounted rather than gated by `session`. */
function ConnectionBanner({ state }: { readonly state: ConnectionState }) {
	if (state === 'open') return null
	// The internal state NAMES (`reconnecting`/`failed`) are honestly
	// documented (ws-client-transport.ts's ConnectionState), but the
	// USER-FACING copy must NOT imply an auto-retry that doesn't exist: there
	// is no auto-reconnect loop (SyncClientPeer.reconnect is manual-only — see
	// the plan's carried E1 follow-up), so a dropped/never-established
	// connection stays down until the user reloads. Tell them that plainly
	// rather than "reconnecting…", which would have them waiting for a retry
	// that never comes.
	const message =
		state === 'connecting'
			? 'Connecting to canvas…' // it IS actively dialing — honest
			: state === 'reconnecting'
				? 'Connection lost — reload to reconnect.'
				: 'Can’t connect to the canvas server — check the room or reload.'
	return (
		<div
			data-canvas-v2-connection-banner
			data-connection-state={state}
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				zIndex: 10000,
				padding: '6px 12px',
				textAlign: 'center',
				fontFamily: 'system-ui, sans-serif',
				fontSize: 13,
				color: '#fff',
				background: state === 'failed' ? '#b91c1c' : '#b45309',
			}}
		>
			{message}
		</div>
	)
}

const TOOL_BUTTONS: ReadonlyArray<{ readonly id: ToolId; readonly label: string }> = [
	{ id: 'select', label: 'Select' },
	{ id: 'hand', label: 'Hand' },
	{ id: 'note', label: 'Note' },
	{ id: 'text', label: 'Text' },
	{ id: 'geo', label: 'Shape' },
	{ id: 'frame', label: 'Frame' },
	{ id: 'arrow', label: 'Arrow' },
	{ id: 'draw', label: 'Draw' },
	{ id: 'line', label: 'Line' },
]

/** Cursors.tsx has no push-based "a remote peer's presence changed" hook —
 * canvas-sync's PresenceStore only exposes `onLocalUpdate` (fires for THIS
 * peer's OWN publishes, not inbound ones applied via SyncClientPeer's
 * `presence.apply()`). A cheap polling re-render, same shape as EmbedLayer's
 * existing `tick` cadence just above (1s), is the pragmatic v1 choice here:
 * fast enough that a remote cursor feels reasonably live, cheap enough
 * (`presenceStore.all()` is an in-memory map read, not a wire round-trip)
 * that polling every 150ms costs nothing measurable. A push-based
 * subscription is a documented, deferred upgrade (would need a small
 * canvas-sync addition — EphemeralStore has no generic "any change" hook
 * exposed by the PresenceStore wrapper today). */
const PRESENCE_POLL_MS = 150

function CanvasV2Session({ session }: { readonly session: Session }) {
	const { editor, toolContext, tools, presenceStore, presencePublisher, selfKey } = session
	const editorState = useEditorState(editor)
	const snapshot = useDocSnapshot(toolContext)

	// See PRESENCE_POLL_MS's doc comment above.
	const [, setPresenceTick] = useState(0)
	useEffect(() => {
		const id = setInterval(() => {
			// Task D5: refresh the shared peers-cache singleton BEFORE bumping
			// the tick, so a FileViewerShape body re-rendered by this same tick
			// (see setPresenceTick below) reads a peers snapshot no staler than
			// what Cursors itself renders from a few lines down.
			presentStoreV2.setPeers(presenceStore.all(), selfKey)
			setPresenceTick((t) => t + 1)
		}, PRESENCE_POLL_MS)
		return () => clearInterval(id)
	}, [presenceStore, selfKey])

	const [activeToolId, setActiveToolId] = useState<ToolId>('select')
	const activeToolIdRef = useRef(activeToolId)
	activeToolIdRef.current = activeToolId

	// Task P2 — StylePanel's `isGesturing` flag: true from pointerdown until
	// pointerup/cancel, so the panel disappears mid-drag instead of trailing
	// it (mirrors v1 ContextualStylePanel's own `useMidGesture`). Set/cleared
	// in `handleInput` below on the raw pointerdown/pointerup events (not
	// derived from tool state — a flag this simple doesn't need per-tool
	// FSM plumbing) and force-cleared by `cancelAndReset` for every
	// abandonment path (Escape, blur, pointercancel, tool switch) that never
	// delivers a pointerup at all.
	const [isGesturing, setIsGesturing] = useState(false)

	const [toolStates, setToolStates] = useState<ToolStates>(() => createInitialToolStates(tools))
	const toolStatesRef = useRef(toolStates)
	toolStatesRef.current = toolStates

	const containerRef = useRef<HTMLDivElement | null>(null)
	// Initial guess from the WINDOW (not the container, which isn't mounted
	// yet at first render) — avoids a same-tick "nothing visible" flash
	// (queryViewport against a degenerate {0,0} rect culls every shape) before
	// the mount effect below can measure the real container.
	const [viewportSize, setViewportSize] = useState<ViewportSize>(() => ({
		width: typeof window !== 'undefined' ? window.innerWidth : 1024,
		height: typeof window !== 'undefined' ? window.innerHeight : 768,
	}))
	const viewportSizeRef = useRef(viewportSize)
	viewportSizeRef.current = viewportSize

	useEffect(() => {
		const el = containerRef.current
		if (!el) return
		// Immediate synchronous measurement, not just the ResizeObserver below:
		// a real browser's first RO callback can lag a frame, and — load-
		// bearing for this unit's own integration test — happy-dom implements
		// NO real layout at all, so ResizeObserver never invokes its callback
		// there; without this synchronous read the test DOM would stay stuck
		// at the window-size guess above forever (harmless for that
		// particular size, but this measurement is what makes a real
		// browser's actual container size take effect at all).
		setViewportSize({ width: el.clientWidth || window.innerWidth, height: el.clientHeight || window.innerHeight })
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (!entry) return
			setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height })
		})
		observer.observe(el)
		return () => observer.disconnect()
	}, [])

	// Embed suspend/resume cadence — see EmbedLayer.tsx's `tick` prop doc:
	// "the client mount (Seam G3) bumps it on its own ~1s cadence."
	const [tick, setTick] = useState(0)
	useEffect(() => {
		const id = setInterval(() => setTick((t) => t + 1), 1000)
		return () => clearInterval(id)
	}, [])

	// Presence: publish this peer's viewport on every camera (or other editor
	// state) change — editor.subscribe() fires for ANY EditorState change
	// (camera/selection/hover/editingId, see editor.ts's applyOne), not just
	// SetCamera, so this republishes slightly more often than strictly
	// necessary; presencePublisher's own throttle absorbs that (Task G4).
	// viewportSizeRef (not the viewportSize closure value) so this effect
	// subscribes ONCE per session rather than re-subscribing on every resize.
	//
	// CURSOR REFRESH ON CAMERA CHANGE (quality-review fix round): the SAME
	// subscription re-derives the published WORLD cursor from the last
	// recorded SCREEN point + the new camera — a wheel pan/zoom with a
	// stationary mouse changes the world point under the (unmoved) screen
	// cursor, and without this the published cursor stayed frozen at the
	// pre-pan world spot while only the viewport publish updated: peers saw
	// the cursor stuck. Viewport + refreshed cursor go out as ONE combined
	// store write (setViewportAndRefreshCursor) — see that method's doc
	// comment for the probe-established EphemeralStore same-millisecond LWW
	// tie that makes two separate writes silently lose the second one on the
	// remote side.
	//
	// EDITING (Task F4, pilot 5 — F1 owner decision: Option 1, indicator
	// only): this SAME subscription already fires on an `editingId` change
	// (BeginEdit/EndEdit apply through the ordinary EditorState-change path,
	// same as selection/hover) — so `editor.get().editingId` rides the SAME
	// combined write setViewportAndRefreshCursor already makes, as its third
	// argument. NOT a second setter call: see that method's own doc comment
	// for the deterministic same-tick drop a separate `setEditing()` call
	// here would hit (probe-confirmed while building this fix) — the shared
	// throttle channel flushes only ONE of two synchronous same-handler
	// calls, so BeginEdit's `editing` value would silently never reach the
	// wire until some unrelated LATER EditorState change happened to flush
	// it. Folding it into this one write makes delivery unconditional.
	useEffect(() => {
		const publish = () => {
			const camera = editor.get().camera
			const size = viewportSizeRef.current
			presencePublisher.setViewportAndRefreshCursor(
				{ x: camera.x, y: camera.y, z: camera.z, w: size.width, h: size.height },
				camera,
				editor.get().editingId,
			)
		}
		publish() // an initial viewport publish so peers see it before any camera change
		return editor.subscribe(publish)
	}, [editor, presencePublisher])

	// Defined BEFORE handleInput (not just before its own first use further
	// down) so the shared shortcut policy below can call it directly instead
	// of duplicating cancelActiveTool's own dispatch — see cancelAndReset's own
	// doc comment for what it does.
	const cancelAndReset = useCallback(() => {
		const { states, intents } = cancelActiveTool(tools, toolStatesRef.current, activeToolIdRef.current, editor)
		if (intents.length > 0) editor.applyAll(intents)
		toolStatesRef.current = states
		setToolStates(states)
		// Every abandonment path this function covers (Escape, blur,
		// pointercancel, tool switch) is a case where a plain pointerup may
		// never arrive — clear the StylePanel gesture flag here too, not just
		// on pointerup in handleInput below, so the panel doesn't stay hidden
		// forever after an abandoned gesture.
		setIsGesturing(false)
	}, [editor, tools])

	// THE single source of truth for "which keys are app-global shortcuts and
	// what each does" (Task B3 refactor). BOTH keydown entry points call it —
	// `handleInput` for keydowns whose DOM target is the viewport (or a
	// descendant), and `handleGlobalKeydown` (the document-level fallback
	// below) for keydowns delivered to a focused toolbar button, a DOM SIBLING
	// of the viewport whose keydown never bubbles into Viewport's own listener.
	// Having the policy HERE, once, is what keeps those two paths from
	// diverging: B4's Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y undo/redo branch was added in
	// THIS function alone and immediately works from both paths — had it gone
	// into only one caller it would silently no-op under the other's focus
	// condition.
	//
	// Returns true IFF it CONSUMED the event; each caller must then NOT forward
	// it onward (handleInput returns before dispatchToActiveTool; the document
	// listener simply stops). The `editingId === null` gate lives HERE (not in
	// either caller) so it, too, can never diverge: while a shape is being
	// text-edited, TextEditor's own textarea owns Escape/Delete/Backspace
	// (TextEditor.tsx's handleEditorKeyDown — Escape -> onEndEdit(); Delete/
	// Backspace edit the CHARACTER), and neither stopPropagations, so the same
	// event still reaches here; this policy must fully DEFER (return false =
	// "not my key right now") rather than cancel a tool gesture or delete the
	// shape being edited out from under the user. `editingId` is passed by the
	// caller (both read `editor.get().editingId` once per event); all OTHER
	// live state — the selection behind deleteSelectionIntents, the tool refs
	// behind cancelAndReset — is read fresh inside the actions themselves, so
	// there are no stale closures. Delete/Backspace count as CONSUMED even when
	// the selection is empty (deleteSelectionIntents returns []): the key is
	// still "an app shortcut, handled here, not forwarded to a tool" — matching
	// the pre-refactor branch's own unconditional early return.
	const handleGlobalShortcut = useCallback(
		(event: KeyInputEvent, editingId: string | null): boolean => {
			if (editingId !== null) return false // TextEditor owns the keyboard while editing
			if (event.key === 'Escape') {
				cancelAndReset()
				return true
			}
			if (event.key === 'Delete' || event.key === 'Backspace') {
				const intents = deleteSelectionIntents(editor)
				if (intents.length > 0) editor.applyAll(intents)
				return true
			}
			// Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (Task B4) — the ONE site both entry
			// points funnel through (see this function's own doc comment above),
			// so undo/redo work identically whether the viewport or a toolbar
			// button holds focus. `key.toLowerCase()` because a real browser
			// reports the shifted letter's case differently across platforms
			// (observed: 'z' unshifted, 'Z' shifted) — comparing case-
			// insensitively means Ctrl+Shift+Z matches regardless of which case
			// the DOM handed back, rather than silently failing on one platform.
			// No preventDefault: this mount never focuses a native
			// input/textarea/contentEditable while these fire (the editingId
			// gate above already routes text-editing elsewhere), so there's no
			// competing native undo to suppress — consistent with Escape/Delete/
			// Backspace just above, which don't call it either.
			//
			// REDO KEY SCOPING (correctness): the z-branch (undo) and the
			// shift-z alternative (redo) accept EITHER ctrl or meta — Ctrl+Z is
			// the Windows/Linux undo and Cmd+Shift+Z the Mac-native redo. But
			// the 'y' redo alternative requires `ctrl` SPECIFICALLY, never meta:
			// Ctrl+Y is the Windows redo convention, whereas Cmd+Y on Safari is
			// the native "Show All History" shortcut — and since nothing here
			// calls preventDefault, binding meta+y would fire redo AND pop
			// Safari's history window. Mac users get redo via Cmd+Shift+Z (the
			// z-branch), so dropping meta+y costs them nothing.
			const key = event.key.toLowerCase()
			const withModifier = event.modifiers.ctrl || event.modifiers.meta
			// pruneDanglingSelectionIntents (Task D1's undo-selection-cleanup
			// carry-forward, tool-loop.ts's own doc comment on that function):
			// `SetSelection` is a view intent with no inverse (editor.ts's
			// undo()/redo() never touch EditorState), so undoing a
			// duplicateSelectionIntents/pasteIntents batch removes the newly
			// minted shapes but leaves `selection` still naming them — a
			// dangling reference. Applying the pruned result (when non-empty) is
			// itself a pure state-only intent, so it never pushes a new undo
			// entry or clears the redo stack (editor.ts's applyAll only moves
			// those on `docMutated`), and it's a no-op whenever undo/redo didn't
			// touch anything selection cared about (e.g. undoing a translate).
			if (withModifier && key === 'z' && !event.modifiers.shift) {
				editor.undo()
				const prune = pruneDanglingSelectionIntents(editor)
				if (prune.length > 0) editor.applyAll(prune)
				return true
			}
			if ((withModifier && key === 'z' && event.modifiers.shift) || (event.modifiers.ctrl && key === 'y')) {
				editor.redo()
				const prune = pruneDanglingSelectionIntents(editor)
				if (prune.length > 0) editor.applyAll(prune)
				return true
			}
			// Ctrl/Cmd+C/X/V/D (Task D1) — copy/cut/paste/duplicate. The
			// editingId===null gate already happened above (this function's
			// first line), so `clipboardShortcut` here is the pure key->action
			// mapping only (also independently unit-tested DOM-free in
			// clipboard-dom.test.ts). D-7's cut ordering (write the clipboard
			// FIRST, delete only once that write resolves — a failed write must
			// never lose shapes) and D-6's "selection after paste/duplicate =
			// the new root ids" are already baked into pasteIntents/
			// duplicateSelectionIntents (canvas-editor's clipboard-intents.ts);
			// this branch only decides WHEN to call them and where the
			// `navigator.clipboard` I/O (async, isolated in clipboard-dom.ts)
			// sits relative to it.
			const clip = clipboardShortcut(event, editingId)
			if (clip) {
				if (clip.action === 'copy') {
					const selection = [...editor.get().selection]
					if (selection.length > 0) {
						const payload = serializeSelection(editor.doc.listShapes(), editor.doc.listBindings(), selection)
						void writeClipboardText(encodeClipboard(payload)).catch(() => {
							// A failed/denied clipboard write is a no-op copy — the
							// selection/doc are untouched either way, so there is
							// nothing to roll back.
						})
					}
				} else if (clip.action === 'cut') {
					const selection = [...editor.get().selection]
					if (selection.length > 0) {
						const payload = serializeSelection(editor.doc.listShapes(), editor.doc.listBindings(), selection)
						// ATOMIC CAPTURE (fixes a cut TOCTOU a review caught):
						// deleteSelectionIntents reads the LIVE selection
						// (tool-loop.ts), so if it were called fresh INSIDE the
						// .then() below — after the async writeClipboardText
						// resolves — a selection change during that (real, if
						// brief) microtask window could make cut delete a
						// DIFFERENT set than the one just serialized above. The
						// dangerous direction: selection GROWS during the write
						// -> cut deletes a shape that was never placed on the
						// clipboard -> data lost with no clipboard copy of it.
						// Capturing the delete intents HERE, synchronously, from
						// the SAME selection just serialized, guarantees cut
						// deletes EXACTLY what it copied, regardless of any
						// selection change before the write resolves.
						const deleteIntents = deleteSelectionIntents(editor)
						void writeClipboardText(encodeClipboard(payload))
							.then(() => {
								// D-7: only APPLY the captured delete AFTER the
								// write resolves — never before, so a failed
								// write can't lose shapes.
								if (deleteIntents.length > 0) editor.applyAll(deleteIntents)
							})
							.catch(() => {
								// The write itself failed/was denied: intentionally
								// do NOT delete. The selection survives untouched.
							})
					}
				} else if (clip.action === 'paste') {
					void readClipboardText()
						.then((text) => {
							const intents = pasteIntents(editor, text)
							if (intents.length > 0) editor.applyAll(intents)
						})
						.catch(() => {
							// A failed/denied clipboard read is a no-op paste, never
							// a crash — mirrors decodeClipboard's own total-function,
							// never-throws contract for hostile/malformed text.
						})
				} else {
					// 'duplicate' — no clipboard I/O at all, purely synchronous.
					const intents = duplicateSelectionIntents(editor)
					if (intents.length > 0) editor.applyAll(intents)
				}
				return true
			}
			// Bracket-key Arrange shortcuts (Task D1, D-6) — bring-forward/
			// send-backward/bring-to-front/send-to-back. The editingId===null
			// gate already happened above, so `reorderShortcut` here is the pure
			// key->op mapping only (also independently unit-tested DOM-free in
			// reorder-dom.test.ts). `reorderSelectionIntents` (canvas-editor's
			// E2) computes the whole batch; applying it via a single
			// `editor.applyAll` is what makes one reorder ONE commit / ONE undo
			// entry (E1/E2's own doc comments). No `preventDefault`: bare
			// brackets have no competing native canvas action when
			// editingId===null, consistent with Delete/Escape/undo/clipboard
			// just above.
			const reorder = reorderShortcut(event, editingId)
			if (reorder) {
				const intents = reorderSelectionIntents(editor, reorder.op)
				if (intents.length > 0) editor.applyAll(intents)
				return true
			}
			return false
		},
		[editor, cancelAndReset],
	)

	const handleInput = useCallback(
		(event: InputEvent) => {
			// StylePanel gesture flag (Task P2) — raw pointerdown/pointerup,
			// independent of which tool is active or what it does with the
			// event; the panel just needs to know a drag is in flight.
			if (event.type === 'pointerdown') setIsGesturing(true)
			if (event.type === 'pointerup') setIsGesturing(false)
			if (event.type === 'pointermove') {
				// Presence: publish the WORLD-space cursor position (Task G4) —
				// unconditional (not tool-gated), mirroring wheel's own
				// "handled uniformly regardless of active tool" policy just below.
				// setCursorFromScreen (NOT setCursor + a local screenToWorld):
				// the publisher records the SCREEN point so a later camera-only
				// change can re-derive the world cursor — see the CURSOR REFRESH
				// note on the effect above.
				presencePublisher.setCursorFromScreen({ x: event.x, y: event.y }, editor.get().camera)
			}
			if (event.type === 'wheel') {
				const next = applyWheel(editor.get().camera, event)
				editor.apply({ type: 'SetCamera', ...next })
				return
			}
			// App-global shortcuts (Delete/Backspace -> Task B2; Escape -> Task B3)
			// go through the SHARED policy above so this viewport-focused path and
			// the document-level fallback below never diverge. If it consumed the
			// event, it's fully handled — do NOT also forward it to the active
			// tool (no tool handles keydown, so this is belt-and-suspenders, but
			// it keeps the "consumed here, never forwarded" contract explicit).
			if (event.type === 'keydown' && handleGlobalShortcut(event, editor.get().editingId)) {
				return
			}
			const next = dispatchToActiveTool(tools, toolStatesRef.current, activeToolIdRef.current, editor, event)
			toolStatesRef.current = next
			setToolStates(next)
		},
		[editor, tools, presencePublisher, handleGlobalShortcut],
	)

	// Abandonment-gap cancel — see the module header's ABANDONMENT-CANCEL
	// WIRING note. Viewport's designated hook (canvas-react/src/Viewport.tsx).
	const handleViewportBlur = cancelAndReset

	const selectTool = useCallback(
		(id: ToolId) => {
			// Cancel whatever the tool being LEFT has in flight before switching
			// away from it — a toolbar click mid-drag is the same abandonment
			// case Viewport's blur hook covers, just triggered explicitly instead
			// of by focus loss.
			cancelAndReset()
			setActiveToolId(id)
		},
		[cancelAndReset],
	)

	const handleTextChange = useCallback((id: string, text: string) => editor.apply({ type: 'SetText', id, text }), [editor])
	const handleEndEdit = useCallback(() => editor.apply({ type: 'EndEdit' }), [editor])

	// Task D2 — the write handle threaded to shape bodies (canvas-react's
	// ShapeBodyProps.dispatch) so D3-D5's embeds (roadmap/file-viewer/…) can
	// persist their own changes the same way a tool does, without being
	// handed the whole Editor. STABLE for the whole session — `editor`
	// itself never changes identity across this component's lifetime (it's
	// constructed once in the mount effect above and lives in `session`
	// state) — built with `useCallback` rather than an inline arrow so
	// EmbedHost's content-memo comparator (`embedBodyPropsEqual`,
	// canvas-react's EmbedHost.tsx) never sees a spurious "prop changed"
	// from dispatch's own identity churning every render; that comparator
	// deliberately EXCLUDES dispatch from its comparison anyway (dispatch is
	// a write handle, not content), but keeping this reference stable is
	// still the documented contract, not an accident this happens to rely
	// on either side alone to uphold.
	const dispatch = useCallback((intents: Intent[]) => editor.applyAll(intents), [editor])

	// Task P4 — wires StylePanel's onStyleChange to SetStyle over the WHOLE
	// current selection (E1 is batch — one intent, one commit, one undo entry
	// for however many shapes are selected; see buildSetStyleIntent's own doc
	// comment for the opacity-vs-props split). Reads `editor.get().selection`
	// FRESH on every call (not a stale closure over `editorState`) so a
	// selection change between renders can never leave this dispatching
	// against a stale set of ids. An empty selection is a defensive no-op —
	// StylePanel renders nothing (and so never fires this) once its own
	// `relevantAxes` sees an empty selection, but this guards the callback
	// itself against ever dispatching a body-less SetStyle.
	const onStyleChange = useCallback(
		(axis: StyleAxis, value: StyleValue) => {
			const ids = Array.from(editor.get().selection)
			if (ids.length === 0) return
			dispatch([buildSetStyleIntent(ids, axis, value)])
		},
		[editor, dispatch],
	)

	// Task AS3 — StylePanel's ARMED-mode counterpart to `onStyleChange` above:
	// dispatches `SetNextStyle` (a view intent — no doc mutation, no undo
	// entry, AS1's `applyOne` case) instead of `SetStyle`. Kept as a
	// SEPARATE callback (not a branch inside `onStyleChange`) so StylePanel
	// itself picks which one to call by MODE — see StylePanel.tsx's
	// `onArmStyle` prop doc comment for why that's deliberate, not
	// incidental. `SetNextStyle.props` shallow-merges (editor.ts's
	// `applyOne`), so arming color then arming size accumulates both rather
	// than clobbering — same semantics `nextShapeStyle` already documents.
	const onArmStyle = useCallback(
		(axis: StyleAxis, value: StyleValue) => {
			dispatch([{ type: 'SetNextStyle', props: { [axis]: value } }])
		},
		[dispatch],
	)

	// GLOBAL KEYBOARD-DELIVERY FALLBACK (B3's carried code-quality fix — see
	// this task's own notes): Viewport's onKeyDown only fires for a keydown
	// whose DOM target is Viewport's own div OR ONE OF ITS DESCENDANTS. The
	// toolbar buttons rendered just below are DOM SIBLINGS of the
	// <Viewport>-wrapping container (not descendants of it), and a real
	// browser focuses a <button> on click by default — so clicking a toolbar
	// button and then pressing Escape (or Delete/Backspace) delivers that
	// keydown to the FOCUSED BUTTON, which never bubbles into Viewport's own
	// listener at all: the shortcut silently no-ops. A document-level listener
	// is the fix — it sees every keydown in the document regardless of which
	// element currently holds focus.
	//
	// NOT double-handling: this listener explicitly SKIPS any keydown whose
	// target already lives inside the viewport container (`containerRef`) —
	// that case is already handled by Viewport's own onKeyDown -> handleInput
	// path above (including its own editingId gate for TextEditor, which
	// mounts INSIDE the viewport container per Viewport.tsx's STACKING
	// CONTRACT), so letting it through here too would fire cancelAndReset /
	// deleteSelectionIntents a second time for the exact same keypress. This
	// listener exists ONLY to reach the shortcuts when focus is OUTSIDE the
	// viewport (a toolbar button, or nothing focused at all).
	//
	// isEditableTarget is a second, independent guard: even outside the
	// viewport, never steal a key meant for a real text input/textarea/
	// contentEditable element — none exist in this mount today (the toolbar
	// is all buttons), but a future addition (a room-name field, a search
	// box) shouldn't silently break because this listener swallowed its
	// Escape/Delete first.
	//
	// The two guards below (containment + isEditableTarget) are THIS listener's
	// OWN concern — deciding whether a keydown is even eligible for the global
	// path. The key->action POLICY itself is NOT here: once eligible, the event
	// is handed to the SAME `handleGlobalShortcut` the viewport path uses, so
	// the two paths can't diverge (see that function's own doc comment). The
	// containment guard is exactly what keeps the two mutually exclusive: a
	// keydown whose target is inside the viewport was already handled by
	// Viewport's onKeyDown -> handleInput -> handleGlobalShortcut, so this
	// listener bails before calling it a second time.
	useEffect(() => {
		function handleGlobalKeydown(e: KeyboardEvent): void {
			const container = containerRef.current
			if (!container) return
			const target = e.target as Node | null
			if (target && container.contains(target)) return // already handled by Viewport's own onKeyDown -> handleInput
			if (isEditableTarget(target)) return
			// Rewrite the raw DOM event into the normalized KeyInputEvent the
			// shared policy speaks — carrying modifiers verbatim so the
			// modifier-bearing shortcuts (B4's Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y) work
			// from this path too, not just the viewport one.
			const keyEvent: KeyInputEvent = {
				type: 'keydown',
				key: e.key,
				modifiers: { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey },
				t: e.timeStamp,
			}
			const editingId = editor.get().editingId
			handleGlobalShortcut(keyEvent, editingId)
			// Task D1: Ctrl/Cmd+C/X/V/D DO have competing native browser behavior
			// (Ctrl+D bookmarks the page, Ctrl+P — N/A here, but Ctrl+V may paste
			// into a focused field, Ctrl+C may copy a text selection) that
			// Escape/Delete/undo never had to guard against, so this path calls
			// preventDefault when — and only when — `clipboardShortcut` itself
			// says this keydown IS one of the four (same pure decision
			// `handleGlobalShortcut` just consumed above; re-deriving it here,
			// rather than having `handleGlobalShortcut` return WHICH action it
			// took, keeps its return type the plain `boolean` every other branch
			// already relies on). Deliberately NOT called for editingId!==null —
			// TextEditor's native copy/cut/paste must keep working untouched.
			// KNOWN GAP (ground-truth correction to the plan): this `e` is only
			// reachable from THIS document-level fallback listener. The PRIMARY
			// path — Viewport's own onKeyDown -> canvas-react's `keyEventToInput`
			// -> `handleInput` above — normalizes the raw KeyboardEvent into a
			// DOM-free `KeyInputEvent` (Viewport.tsx's `handleKey`) and never
			// retains or forwards the original event, so there is no hook to call
			// preventDefault from there without changing canvas-react's
			// logic-free Viewport component (out of this task's file list). In
			// practice the viewport is a plain non-input `<div>`, so the browser
			// has no default "paste into this element" action to suppress there,
			// and Ctrl+D/Ctrl+P are OS/browser-reserved shortcuts most browsers
			// ignore preventDefault for regardless of where it's called from.
			if (clipboardShortcut(keyEvent, editingId)) e.preventDefault()
		}
		document.addEventListener('keydown', handleGlobalKeydown)
		return () => document.removeEventListener('keydown', handleGlobalKeydown)
	}, [editor, handleGlobalShortcut])

	return (
		<div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif' }}>
			<div style={{ display: 'flex', gap: 4, padding: 6, borderBottom: '1px solid rgba(15,23,42,0.12)', background: '#fafaf7' }}>
				{TOOL_BUTTONS.map((btn) => (
					<button
						key={btn.id}
						type="button"
						data-canvas-v2-tool={btn.id}
						aria-pressed={activeToolId === btn.id}
						onClick={() => selectTool(btn.id)}
						style={{
							padding: '4px 10px',
							borderRadius: 4,
							border: activeToolId === btn.id ? '1px solid #004990' : '1px solid rgba(15,23,42,0.22)',
							background: activeToolId === btn.id ? '#004990' : 'transparent',
							color: activeToolId === btn.id ? '#fafaf7' : '#0f172a',
							fontSize: 12,
							cursor: 'pointer',
						}}
					>
						{btn.label}
					</button>
				))}
			</div>
			<div ref={containerRef} data-canvas-v2-viewport style={{ position: 'relative', flex: 1, minWidth: 0 }}>
				<Viewport onInput={handleInput} onViewportBlur={handleViewportBlur} onPointerCancel={cancelAndReset} style={{ position: 'absolute', inset: 0 }}>
					<Grid camera={editorState.camera} />
					<WorldLayer camera={editorState.camera}>
						<ShapeLayer toolContext={toolContext} camera={editorState.camera} viewportSize={viewportSize} dispatch={dispatch} />
						<EmbedLayer
							toolContext={toolContext}
							camera={editorState.camera}
							viewportSize={viewportSize}
							tick={tick}
							suspendAfterTicks={SUSPEND_AFTER_TICKS}
							lifecycleFor={canvasV2EmbedLifecycles.lifecycleFor}
							dispatch={dispatch}
						/>
						<TextEditor toolContext={toolContext} onTextChange={handleTextChange} onEndEdit={handleEndEdit} />
					</WorldLayer>
					<Overlay
						editorState={editorState}
						snapshot={snapshot}
						camera={editorState.camera}
						viewportSize={viewportSize}
						index={toolContext.index()}
						snapResult={currentSnapResult(toolStates, activeToolId)}
					/>
					{/* Collaborator cursors (Task G4) — a separate full-viewport SVG
					    sibling, painted topmost (Viewport.tsx's STACKING CONTRACT: later
					    DOM siblings paint over earlier ones). `presenceStore.all()` is
					    re-read every PRESENCE_POLL_MS tick (see that constant's doc
					    comment) via the `presenceTick` state dependency below. */}
					<Cursors presence={adaptPresence(presenceStore.all())} selfKey={selfKey} camera={editorState.camera} viewportSize={viewportSize} />
					{/* Pilot 5 (Task F4) — peer editing indicators. SCREEN-space,
					    the same Cursors idiom directly above (camera + viewportSize,
					    worldToScreen inside), rendered OUTSIDE WorldLayer so the badge
					    stays constant-size and legible at every zoom, and painted after
					    everything else (same STACKING CONTRACT) so no shape body ever
					    occludes it. Reads `presenceStore.all()` directly (not
					    `adaptPresence`'s Cursors-shaped narrowing) — see
					    EditingIndicators.tsx's own module header for why it needs
					    canvas-sync's raw `Presence.editing` field. */}
					<EditingIndicators presence={presenceStore.all()} selfKey={selfKey} snapshot={snapshot} camera={editorState.camera} viewportSize={viewportSize} />
					{/* Task P2 — contextual style panel, painted topmost (same STACKING
					    CONTRACT as Cursors/EditingIndicators above: later DOM siblings
					    paint over earlier ones). WIRED (Task P4): `onStyleChange` above
					    dispatches a `SetStyle` intent over the whole selection — see its
					    own doc comment and StylePanel.tsx's module header for the
					    RED-then-GREEN history. Task AS3 adds `activeToolId`/
					    `nextShapeStyle`/`onArmStyle` for the armed (empty-selection)
					    mode — see StylePanel.tsx's own module header. */}
					<StylePanel
						selection={editorState.selection}
						snapshot={snapshot}
						camera={editorState.camera}
						viewportSize={viewportSize}
						isGesturing={isGesturing}
						activeToolId={activeToolId}
						nextShapeStyle={editorState.nextShapeStyle}
						onStyleChange={onStyleChange}
						onArmStyle={onArmStyle}
					/>
				</Viewport>
			</div>
		</div>
	)
}
