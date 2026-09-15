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
 *      + `createToolSet(toolContext)` (canvas-editor's session/tool-loop.ts).
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
 * SESSION (canvas-ui's `useCanvasSession` + `CanvasSurface`): the tool loop,
 * wheel pan/zoom, abandonment cancel (viewport blur, pointercancel, tool
 * switch, Escape), and every keyboard shortcut — via the Viewport's own
 * onKeyDown AND a document-level fallback for keydowns delivered to a focused
 * toolbar button or the body, both funnelling through canvas-editor's single
 * `resolveShortcut` — live in the shared session layer the bb Canvas plugin
 * mounts too. This mount supplies only the host port (DOM clipboard, a
 * console notice, cursor presence) and its own world/overlay content
 * (embeds, collaborator cursors, editing indicators).
 * `document.visibilitychange` (tab hidden while still focused) is NOT wired —
 * canvas-react's Viewport module header names it as "a documented, deferred
 * extension of the same hook."
 *
 * TODO(canvas-v2 locked-shape-affordance): the v1 engine shows a padlock chip
 * on hovered/selected locked shapes (client/src/chrome/LockedShapeBadge.tsx,
 * spec docs/superpowers/specs/2026-07-23-locked-shape-affordance-design.md
 * §8). v2 inherits none of it — it needs both the `selectLockedShapes`
 * equivalent in its OWN hit-testing (a locked shape excluded from hover can
 * never surface a badge) and the badge itself, before v2 becomes the live
 * engine. Without it, v2 reintroduces the silent-dead-shape bug this fixed.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
// Visual chrome fidelity (polish/visual-chrome) — defines the `--canvas-*`
// custom properties canvas-react's overlay falls back on (see that file's
// own header): bridges them to this app's `--wm-*` brand tokens without
// canvas-react ever importing/hardcoding a brand value itself.
import './canvas-v2.css'
import { Editor, createToolContext, createToolSet, screenToWorld, type ToolContext, type ToolSet } from '@ensembleworks/canvas-editor'
import { PresenceStore, SyncClientPeer, type Transport } from '@ensembleworks/canvas-sync'
import { Cursors, EmbedLayer, registerCoreShapes, useDocSnapshot, useEditorState, type ViewportSize } from '@ensembleworks/canvas-react'
import { getRoomId, identityOnce } from '../identity.js'
import { wsClientTransport, type ConnectionState, type WebSocketLike } from './ws-client-transport.js'
import { resolvePageId } from './bootstrap-page.js'
import { adaptPresence, createPresencePublisher, type PresencePublisher } from './presence.js'
import { EditingIndicators } from './EditingIndicators.js'
import { DevOverlay, shouldShowDevOverlayFromEnvironment, useCanvasMetrics } from './DevOverlay.js'
import { canvasV2EmbedLifecycles, registerCanvasV2Shapes } from './shapes/index.js'
import { presentStoreV2 } from './shapes/presentStoreV2.js'
import { CanvasFonts, CanvasSurface, Toolbar, isEditableTarget, useCanvasSession, type CanvasHost } from '@ensembleworks/canvas-ui'
import { readClipboardText, writeClipboardText } from './clipboard-dom.js'
import { extractImageFiles } from './image-drop.js'
import { extractImageBlobs } from './image-paste.js'
import { createImageFromBlob } from './image-create.js'
import { PageSwitcher } from './PageSwitcher.js'

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
	const userId = props.userId ?? identityOnce().id
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
			// TODO(canvas-v2 connection-health): v2 does not use tldraw's useSync, so
			// the connection-health probe cannot read store.status here. Before v2
			// becomes the live engine, expose this peer's connection state (open /
			// closed / reconnecting) in the shape useConnectionHealth expects for the
			// canvas transport, then mount useCanvasAvailability + CanvasBlockerModal
			// the way App.tsx does.
			// See docs/plans/2026-07-22-connection-health-modal-design.md §7.
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

function CanvasV2Session({ session: mount }: { readonly session: Session }) {
	const { editor, toolContext, tools, presenceStore, presencePublisher, selfKey } = mount
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

	// The shared session (canvas-ui's useCanvasSession): active tool, tool FSM
	// states, the StylePanel gesture flag, every keyboard shortcut (from the
	// viewport and, via its document-level fallback, from a focused toolbar
	// button or the body), clipboard, and the style callbacks. This mount only
	// supplies the host port: the DOM clipboard, a console notice for clipboard
	// failures, and cursor presence (the screen point is recorded so a later
	// camera-only change can re-derive the world cursor — see the CURSOR
	// REFRESH note on the effect above).
	const rootRef = useRef<HTMLDivElement | null>(null)
	const host = useMemo<CanvasHost>(
		() => ({
			clipboard: { read: readClipboardText, write: writeClipboardText },
			notify: (message) => console.warn(`[canvas-v2] ${message}`),
			onCursorScreen: (point) => presencePublisher.setCursorFromScreen(point, editor.get().camera),
		}),
		[editor, presencePublisher],
	)
	const session = useCanvasSession({ editor, toolContext, tools, host, keyboardScopeRef: rootRef, viewportContainerRef: containerRef })

	// Task W1 (docs/plans/2026-07-22-canvas-v2-assets-image.md, D-7) — the
	// drop surface. onDragOver MUST call preventDefault: a browser div is
	// NOT a drop target by default, so with no listener (or one that never
	// preventDefaults) the browser refuses to fire `drop` at all and instead
	// runs its own "navigate to/open the file" default — the wheel
	// listener's own non-passive-preventDefault note (Viewport.tsx's module
	// header) is the same shape of problem for a different native default.
	const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
		e.preventDefault()
	}, [])

	// onDrop: preventDefault (stop the browser's own file-open navigation),
	// extract image Files (image-drop.ts's extractImageFiles — DOM-free,
	// unit-tested; non-image files in a mixed drop are silently ignored),
	// convert the drop's CLIENT point to WORLD via the SAME
	// `clientX/clientY - rect.left/top` -> `screenToWorld` recipe every
	// other pointer event uses (canvas-react's dom-events.ts
	// `pointerEventToInput`, fed by Viewport.tsx's own
	// `getBoundingClientRect()` call) — `e.currentTarget` here is this same
	// `data-canvas-v2-viewport` container, so the math is identical. Fires
	// one `createImageFromBlob` per file (D-7: MVP stacks multiple files at
	// the same world point — acceptable per plan); each call is
	// independently async/fire-and-forget (`createImageFromBlob` itself
	// swallows a failed upload — see image-create.ts).
	const handleDrop = useCallback(
		(e: DragEvent<HTMLDivElement>) => {
			e.preventDefault()
			const files = extractImageFiles(e.dataTransfer.files)
			if (files.length === 0) return
			const rect = e.currentTarget.getBoundingClientRect()
			const local = { x: e.clientX - rect.left, y: e.clientY - rect.top }
			const world = screenToWorld(editor.get().camera, local)
			for (const file of files) {
				void createImageFromBlob(editor, file, world, editor.get().currentPageId)
			}
		},
		[editor],
	)

	// Task W2 (docs/plans/2026-07-22-canvas-v2-assets-image.md, D-7) — the
	// paste-image surface. A SEPARATE document-level `paste` listener, NOT
	// an extension of the Ctrl+V -> readClipboardText path above (which is
	// TEXT-only and stays untouched — see canvas-ui's useCanvasSession 'paste'
	// branch). extractImageBlobs (image-paste.ts, DOM-free/unit-tested)
	// finds nothing on a text-only clipboard (an EW shape-copy's clipboard
	// TEXT, or an ordinary text copy), so this listener no-ops and the
	// existing Ctrl+V keydown path (already gated behind its own handler)
	// is what fires; conversely an externally-copied/dragged-in IMAGE puts
	// no EW-clipboard text on the clipboard, so `pasteIntents` — were it to
	// run — would see an undecodable payload and no-op. The two paths
	// handle disjoint clipboard content, so a single paste event never
	// double-fires both (D-7's no-double-handling reasoning).
	//
	// preventDefault ONLY when an image was actually found: an
	// unconditional preventDefault here would swallow every ordinary text
	// paste's native/Ctrl+V-path behavior even on a clipboard this listener
	// has nothing to do with — the mirror image of Task D1's clipboard
	// keydown fallback, which likewise only preventDefaults the four keys
	// `clipboardShortcut` actually recognizes.
	//
	// isEditableTarget guard: skip when the paste's target is a real text
	// input/textarea/contentEditable (TextEditor's own textarea while
	// editing shape text) — same guard the session's document keydown listener
	// applies to keydowns, so an image paste while mid text-edit never
	// hijacks the native (text-only) paste TextEditor's textarea handles
	// itself.
	useEffect(() => {
		function handlePaste(e: ClipboardEvent): void {
			if (isEditableTarget(e.target)) return
			const clipboardData = e.clipboardData
			if (!clipboardData) return
			const blobs = extractImageBlobs(clipboardData)
			if (blobs.length === 0) return
			e.preventDefault()
			// No pointer position on a paste — drop at the viewport's CURRENT
			// center in world space (plan D-7), same
			// `screenToWorld(camera, {x,y})` convention as the drop handler
			// above, just fed the viewport's midpoint instead of a client
			// event's coordinates.
			const size = viewportSizeRef.current
			const center = screenToWorld(editor.get().camera, { x: size.width / 2, y: size.height / 2 })
			for (const blob of blobs) {
				void createImageFromBlob(editor, blob, center, editor.get().currentPageId)
			}
		}
		document.addEventListener('paste', handlePaste)
		return () => document.removeEventListener('paste', handlePaste)
	}, [editor])

	return (
		<div ref={rootRef} style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif' }}>
			{/* The tldraw handwriting/text webfonts, self-hosted from
			    client/public/fonts/tldraw/ (OFL licences alongside them). v1's
			    <Tldraw> registers these itself; v2 never mounts it, so this is
			    the only place the dogfood mount gets them. */}
			<CanvasFonts baseUrl="/fonts/tldraw" />
			<PageSwitcher editor={editor} snapshot={snapshot} currentPageId={editorState.currentPageId} />
			{/* Visual chrome fidelity (polish/visual-chrome, gap 1): v1's canvas
			    surface is the warm brand paper (theme.css's `.tl-theme__light`
			    sets `--tl-color-background: var(--wm-bg-warm)`) — this container
			    is v2's equivalent surface (Viewport/Grid paint nothing of their
			    own; Grid.tsx is dots-only, transparent everywhere else), so it's
			    the one place v2 needs an explicit background to stop reading as
			    browser-default white. Consumes the SAME `--wm-bg-warm` token
			    theme.css already defines — no second hex hardcoded here. */}
			<div ref={containerRef} data-canvas-v2-viewport onDragOver={handleDragOver} onDrop={handleDrop} style={{ position: 'relative', flex: 1, minWidth: 0, background: 'var(--wm-bg-warm)' }}>
				{/* Embeds ride the world-layer slot; collaborator cursors (Task G4)
				    and peer editing indicators (Task F4) ride the screen-space
				    overlay slot, painted above the selection overlay and below the
				    style panel. `presenceStore.all()` is re-read every
				    PRESENCE_POLL_MS tick (see that constant's doc comment).
				    EditingIndicators reads the raw store (not `adaptPresence`'s
				    Cursors-shaped narrowing) — it needs `Presence.editing`. */}
				<CanvasSurface
					session={session}
					editorState={editorState}
					snapshot={snapshot}
					viewportSize={viewportSize}
					worldLayers={
						<EmbedLayer
							toolContext={toolContext}
							camera={editorState.camera}
							viewportSize={viewportSize}
							tick={tick}
							suspendAfterTicks={SUSPEND_AFTER_TICKS}
							lifecycleFor={canvasV2EmbedLifecycles.lifecycleFor}
							dispatch={session.dispatch}
						/>
					}
					overlays={
						<>
							<Cursors presence={adaptPresence(presenceStore.all())} selfKey={selfKey} camera={editorState.camera} viewportSize={viewportSize} />
							<EditingIndicators presence={presenceStore.all()} selfKey={selfKey} snapshot={snapshot} camera={editorState.camera} viewportSize={viewportSize} />
						</>
					}
				/>
			</div>
			{/* A left rail over the canvas, in the fixed root rather than the
			    viewport container: the session's keydown listener ignores targets
			    inside that container, so a focused rail button there would stop
			    forwarding shortcuts. */}
			<Toolbar
				orientation="vertical"
				activeToolId={session.activeToolId}
				onSelectTool={session.selectTool}
				nextShapeStyle={editorState.nextShapeStyle}
				onArmStyle={session.onArmStyle}
				style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', zIndex: 600, boxShadow: 'var(--canvas-ui-shadow, 0 2px 10px rgba(15,23,42,0.18))' }}
			/>
		</div>
	)
}
