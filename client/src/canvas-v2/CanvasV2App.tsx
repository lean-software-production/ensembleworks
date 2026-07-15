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
 *   3. A bounded SETTLE window (`settleMs`, prop-injectable, default
 *      `SETTLE_MS_DEFAULT`) before deciding the room's page id — see
 *      bootstrap-page.ts's KNOWN RACE note for exactly what this trades off
 *      and why. Tests pass `settleMs: 0` since an injected memory-transport
 *      handshake is already synchronous by the time `connect()` resolves.
 *   4. `resolvePageId(peer.doc)` (bootstrap-page.ts) — adopts the room's
 *      existing page if any, else bootstraps the `page:p` convention.
 *   5. `new Editor({ doc: peer.doc, now, random, pageId })` — `now`/`random`
 *      are real (`performance.now`/crypto-seeded), injected HERE at the
 *      COMPOSITION EDGE: canvas-editor's own boundary rule forbids reading
 *      either directly inside the package (editor.ts's `EditorOpts` doc
 *      comment), but client app code is exactly the layer allowed to reach
 *      for a real clock/PRNG — this is that layer.
 *   6. `createToolContext(editor)` + `registerCanvasV2Shapes()` (idempotent
 *      guard already inside that function) + `createToolSet(toolContext)`
 *      (tool-loop.ts).
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
 * the key->action mapping lives in exactly ONE place and a future shortcut
 * (B4's Ctrl+Z) is a one-site addition; the document listener's own
 * containment guard keeps the two paths mutually exclusive (no
 * double-handling). See both functions' doc comments.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	Editor,
	applyWheel,
	createToolContext,
	type InputEvent,
	type KeyInputEvent,
	type ToolContext,
} from '@ensembleworks/canvas-editor'
import { PresenceStore, SyncClientPeer, type Transport } from '@ensembleworks/canvas-sync'
import {
	Cursors,
	EmbedLayer,
	Grid,
	Overlay,
	ShapeLayer,
	TextEditor,
	Viewport,
	WorldLayer,
	useDocSnapshot,
	useEditorState,
	type ViewportSize,
} from '@ensembleworks/canvas-react'
import { getIdentity, getRoomId } from '../identity.js'
import { wsClientTransport, type WebSocketLike } from './ws-client-transport.js'
import { resolvePageId } from './bootstrap-page.js'
import { adaptPresence, createPresencePublisher, type PresencePublisher } from './presence.js'
import { DevOverlay, shouldShowDevOverlayFromEnvironment, useCanvasMetrics } from './DevOverlay.js'
import { canvasV2EmbedLifecycles, registerCanvasV2Shapes } from './shapes/index.js'
import {
	cancelActiveTool,
	createInitialToolStates,
	createToolSet,
	currentSnapResult,
	deleteSelectionIntents,
	dispatchToActiveTool,
	type ToolId,
	type ToolSet,
	type ToolStates,
} from './tool-loop.js'

/** How long an embed (terminal/iframe/…) may sit off-screen before
 * EmbedLayer suspends it — see embedLifecycle.ts's `suspendAfterTicks` doc.
 * One tick = one second (the `tick` interval below), so 3 means "more than
 * 3 consecutive invisible seconds." Not exposed as a prop: this v1 mount has
 * one policy, not a per-caller-tunable one. */
const SUSPEND_AFTER_TICKS = 3

/** See CONSTRUCTION SEQUENCE step 3 / bootstrap-page.ts's KNOWN RACE note. */
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
	/** Test seam — see step 3 / bootstrap-page.ts's KNOWN RACE note.
	 * Production omits it (defaults to `SETTLE_MS_DEFAULT`); tests pass 0. */
	readonly settleMs?: number
}

export function CanvasV2App(props: CanvasV2AppProps) {
	const roomId = props.roomId ?? getRoomId()
	const userId = props.userId ?? getIdentity().id
	const [session, setSession] = useState<Session | null>(null)
	const sessionRef = useRef<Session | null>(null)

	useEffect(() => {
		let cancelled = false

		async function boot(): Promise<void> {
			const doConnect = props.connect ?? defaultConnect(roomId, userId)
			const transport = await doConnect()
			if (cancelled) {
				transport.close()
				return
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
			await delay(props.settleMs ?? SETTLE_MS_DEFAULT)
			if (cancelled) {
				presenceStore.destroy()
				peer.close()
				return
			}
			const pageId = resolvePageId(peer.doc)
			const editor = new Editor({ doc: peer.doc, now: () => performance.now(), random: cryptoRandom, pageId })
			const toolContext = createToolContext(editor)
			registerCanvasV2Shapes()
			const tools = createToolSet(toolContext)
			const presencePublisher = createPresencePublisher(presenceStore)
			const s: Session = { peer, editor, toolContext, tools, presenceStore, presencePublisher, selfKey: userId }
			sessionRef.current = s
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
			{!session ? <ConnectingPlaceholder /> : <CanvasV2Session session={session} />}
			{showDevOverlay && (
				<DevOverlay
					roomId={roomId}
					connectionState={session ? 'connected' : 'connecting'}
					client={{ repairCount: session?.peer.repairCount ?? 0, lastBackfillBytes: session?.peer.lastBackfillBytes ?? 0 }}
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

const TOOL_BUTTONS: ReadonlyArray<{ readonly id: ToolId; readonly label: string }> = [
	{ id: 'select', label: 'Select' },
	{ id: 'hand', label: 'Hand' },
	{ id: 'note', label: 'Note' },
	{ id: 'text', label: 'Text' },
	{ id: 'geo', label: 'Shape' },
	{ id: 'frame', label: 'Frame' },
	{ id: 'arrow', label: 'Arrow' },
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
		const id = setInterval(() => setPresenceTick((t) => t + 1), PRESENCE_POLL_MS)
		return () => clearInterval(id)
	}, [])

	const [activeToolId, setActiveToolId] = useState<ToolId>('select')
	const activeToolIdRef = useRef(activeToolId)
	activeToolIdRef.current = activeToolId

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
	useEffect(() => {
		const publish = () => {
			const camera = editor.get().camera
			const size = viewportSizeRef.current
			presencePublisher.setViewportAndRefreshCursor({ x: camera.x, y: camera.y, z: camera.z, w: size.width, h: size.height }, camera)
		}
		publish() // an initial viewport publish so peers see it before any camera change
		return editor.subscribe(publish)
	}, [editor, presencePublisher])

	// Defined BEFORE handleInput (not just before its own first use further
	// down) so the shared shortcut policy below can call it directly instead
	// of duplicating cancelActiveTool's own dispatch — see cancelAndReset's own
	// doc comment for what it does.
	const cancelAndReset = useCallback(() => {
		const { states, intents } = cancelActiveTool(tools, toolStatesRef.current, activeToolIdRef.current)
		if (intents.length > 0) editor.applyAll(intents)
		toolStatesRef.current = states
		setToolStates(states)
	}, [editor, tools])

	// THE single source of truth for "which keys are app-global shortcuts and
	// what each does" (Task B3 refactor). BOTH keydown entry points call it —
	// `handleInput` for keydowns whose DOM target is the viewport (or a
	// descendant), and `handleGlobalKeydown` (the document-level fallback
	// below) for keydowns delivered to a focused toolbar button, a DOM SIBLING
	// of the viewport whose keydown never bubbles into Viewport's own listener.
	// Having the policy HERE, once, is what keeps those two paths from
	// diverging: a future shortcut (B4's Ctrl+Z) is added in THIS function
	// alone and immediately works from both paths — add it to only one and it
	// would silently no-op under the other's focus condition.
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
			return false
		},
		[editor, cancelAndReset],
	)

	const handleInput = useCallback(
		(event: InputEvent) => {
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
			// shared policy speaks — carrying modifiers verbatim so a future
			// modifier-bearing shortcut (B4's Ctrl+Z) works from this path too,
			// not just the viewport one.
			const keyEvent: KeyInputEvent = {
				type: 'keydown',
				key: e.key,
				modifiers: { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey },
				t: e.timeStamp,
			}
			handleGlobalShortcut(keyEvent, editor.get().editingId)
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
						<ShapeLayer toolContext={toolContext} camera={editorState.camera} viewportSize={viewportSize} />
						<EmbedLayer
							toolContext={toolContext}
							camera={editorState.camera}
							viewportSize={viewportSize}
							tick={tick}
							suspendAfterTicks={SUSPEND_AFTER_TICKS}
							lifecycleFor={canvasV2EmbedLifecycles.lifecycleFor}
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
				</Viewport>
			</div>
		</div>
	)
}
