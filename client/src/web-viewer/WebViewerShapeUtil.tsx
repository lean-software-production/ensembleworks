/**
 * A file from the agent home, rendered as a sandboxed iframe portal — for
 * HTML reports, rendered markdown, and other static output an agent wants to
 * put on the canvas (see server/src/features/files.ts and
 * server/src/files-render.ts for the /files/* proxy this points at).
 *
 * Position/size and the current `rev` are shared via tldraw sync; the
 * iframe's *content* (scroll position, in-page state) is per-user. The
 * refresh button bumps `rev`, which every client applies via sync — so
 * "refresh" is a room-wide reload, not a local one (unlike the iframe
 * shape's dev-server reload, which only resets the local <iframe>.src).
 * Double-click to take control and interact — editing IS the baton (see
 * PresenterInfo): the token lives exactly as long as the local editing
 * session. It releases on edit-exit (deselect, click away, Escape, select
 * another shape — freezing the shape at the last view for everyone), on
 * yield (someone else takes control), or on presence expiry (disconnect).
 */
import { webViewerShapeProps } from '@ensembleworks/contracts'
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { sandboxFor, srcFor } from './devSource'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	TLBaseShape,
	TLResizeInfo,
	resizeBox,
	stopEventPropagation,
	useEditor,
	useValue,
} from 'tldraw'
import { wm } from '../theme'
import { getRoomId } from '../identity'
import { PRESENTER_FALLBACK_COLOR, presenterFor, type PresenterInfo } from './followLogic'
import { forwardPinchToCanvas, parsePinchMessage } from './pinchForward'
import { createPresentBroadcaster } from './presentBroadcast'
import { presentStore } from './presentStore'

// Code-split out: RrwebMirror eagerly pulls in rrweb's `Replayer` + its CSS
// (~40 kB gzip) — only needed once a mirror actually mounts (live or frozen),
// never for a web-viewer that's just sitting on the canvas unwatched. Keeping
// it out of the entry chunk is what the bundle-size CI gate enforces
// (client/scripts/bundle-size-check.ts).
const RrwebMirror = lazy(() => import('./RrwebMirror').then((m) => ({ default: m.RrwebMirror })))

export interface WebViewerShapeProps {
	w: number
	h: number
	// Source discriminator: 'file' renders a home-relative path via /files/*;
	// 'dev' renders a VM dev server via the injecting /dev/{port} proxy.
	// Optional so pre-migration records validate (treat missing as 'file').
	kind?: 'file' | 'dev'
	// kind 'file': path relative to the agent user's home. kind 'dev': the
	// in-app path under the dev server root (default '/').
	path: string
	title: string
	// kind 'dev' only: the localhost port the dev server listens on.
	port?: number
	// Bumped by POST /api/canvas/web-viewer refresh so every client reloads.
	rev?: number
	// Remote gateway id (future); optional so existing rooms need no migration.
	gateway?: string
}

declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		'web-viewer': WebViewerShapeProps
	}
}

export type WebViewerShape = TLBaseShape<'web-viewer', WebViewerShapeProps>

const HEADER_HEIGHT = 28

// DO NOT override canScroll() to true: pinch-forward (pinchForward.ts) relies
// on tldraw's onWheel NOT swallowing wheel events over this shape while it's
// being edited, which holds only while canScroll stays at ShapeUtil's default
// false. The iframe scrolls its own document; tldraw never needs to.
export class WebViewerShapeUtil extends BaseBoxShapeUtil<WebViewerShape> {
	static override type = 'web-viewer' as const
	static override props = webViewerShapeProps

	override getDefaultProps(): WebViewerShape['props'] {
		return { w: 720, h: 540, path: '', title: '', rev: 0 }
	}

	override canEdit() {
		return true
	}
	override hideRotateHandle() {
		return true
	}

	override onResize(shape: WebViewerShape, info: TLResizeInfo<WebViewerShape>) {
		return resizeBox(shape, info, { minWidth: 320, minHeight: 200 })
	}

	override component(shape: WebViewerShape) {
		return <WebViewerShapeComponent shape={shape} />
	}

	override getIndicatorPath(shape: WebViewerShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function WebViewerShapeComponent({ shape }: { shape: WebViewerShape }) {
	const editor = useEditor()
	const isEditing = useValue(
		'isEditing',
		() => editor.getEditingShapeId() === shape.id,
		[editor, shape.id]
	)
	const { path, w, h, rev, kind, port } = shape.props
	const displayTitle = shape.props.title || (kind === 'dev' ? `:${port}` : path) || 'web viewer'
	const hasSource = kind === 'dev' ? port != null : Boolean(path)

	const [devErrors, setDevErrors] = useState<{ kind: string; detail: string }[]>([])
	useEffect(() => {
		setDevErrors([])
	}, [rev]) // refresh clears the slate

	const refresh = () => {
		editor.updateShape({
			id: shape.id,
			type: 'web-viewer',
			props: { rev: (shape.props.rev ?? 0) + 1 },
		})
	}

	// Scroll-follow (spec §5). All per-user; presenter token rides presence meta
	// via presentStore, followers read it off collaborator presence.
	const iframeRef = useRef<HTMLIFrameElement | null>(null)
	const lastFractionRef = useRef(0)

	// Am I presenting THIS shape? (presentStore wraps a tldraw atom → reactive.)
	const presenting = useValue('fvPresenting', () => presentStore.get(), [])
	const isPresentingThis = presenting?.shapeId === shape.id

	// rrweb broadcast (spec: 2026-07-27-file-viewer-rrweb-broadcast-design.md).
	// Presenter: start the in-iframe recorder + batcher while presenting this
	// shape. rrwebDegraded → presenter silently reverts to fraction-only.
	const broadcasterRef = useRef<ReturnType<typeof createPresentBroadcaster> | null>(null)
	const [rrwebDegraded, setRrwebDegraded] = useState(false)
	// Follower: mirror fallback — flipped by RrwebMirror when no stream appears.
	const [mirrorFallback, setMirrorFallback] = useState(false)

	useEffect(() => {
		if (!isPresentingThis) {
			// Lost the baton (edit-exit release, yielded to a stealer, presence
			// expired) or unmount below: stop the recorder + POST present-stop.
			// present-stop is a no-op server-side now (spec: relay retention) —
			// it does NOT delete the relay log, so the frozen mirror still has
			// something to seed from after we release.
			if (broadcasterRef.current) {
				iframeRef.current?.contentWindow?.postMessage({ type: 'ew-present-stop' }, '*')
				void broadcasterRef.current.stop()
				broadcasterRef.current = null
			}
			setRrwebDegraded(false)
			return
		}
		const presentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
		const broadcaster = createPresentBroadcaster({
			roomId: getRoomId(),
			shapeId: shape.id,
			presentId,
			onDegrade: () => setRrwebDegraded(true),
		})
		broadcasterRef.current = broadcaster
		iframeRef.current?.contentWindow?.postMessage({ type: 'ew-present-start' }, '*')
		return () => {
			iframeRef.current?.contentWindow?.postMessage({ type: 'ew-present-stop' }, '*')
			void broadcaster.stop()
			broadcasterRef.current = null
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isPresentingThis, shape.id])

	// A peer presenting this shape (never me — getCollaborators is remote-only,
	// but guard on userId too). Following is mutually exclusive with presenting.
	// The selector collapses to a PRIMITIVE key (userId\tuserName\tfraction) so
	// the useValue epoch only bumps when the presenter/fraction actually changes
	// — getCollaborators() returns a fresh array on every remote cursor move, and
	// an object return here would re-render every web-viewer for each of them.
	// presenterFor stays the single source of matching logic.
	const myId = useValue('fvUserId', () => editor.user.getId(), [editor])
	const presenterKey = useValue(
		'fvPresenterKey',
		() => {
			const p = presenterFor(editor.getCollaborators(), shape.id)
			return p ? `${p.userId}\t${p.userName}\t${p.color}\t${p.fraction}\t${p.ts}` : null
		},
		[editor, shape.id]
	)
	let peer: PresenterInfo | null = null
	if (presenterKey !== null) {
		// ts/fraction/color are the last three fields; join the middle back in case a
		// userName ever contains a tab (defensive — tldraw names are plain strings).
		const parts = presenterKey.split('\t')
		peer = {
			userId: parts[0],
			userName: parts.slice(1, -3).join('\t'),
			color: parts[parts.length - 3],
			fraction: Number(parts[parts.length - 2]),
			ts: Number(parts[parts.length - 1]),
		}
	}
	const peerPresenter = peer && peer.userId !== myId ? peer : null
	const activePresenter: PresenterInfo | null = !isPresentingThis && peerPresenter ? peerPresenter : null

	// targetOrigin '*' is REQUIRED: the sandboxed document loads at an opaque
	// (null) origin (no allow-same-origin), so no concrete origin can ever match.
	// The payload is only a scroll fraction — nothing sensitive leaves the room.
	const postScrollSet = (fraction: number) => {
		iframeRef.current?.contentWindow?.postMessage({ type: 'ew-scroll-set', fraction }, '*')
	}

	// Latest follow target for the (stable) message listener to read without
	// re-subscribing on every fraction change.
	const activePresenterRef = useRef<PresenterInfo | null>(activePresenter)
	activePresenterRef.current = activePresenter

	// Audience row: everyone in the room is a follower by definition now — one
	// dot per person while a presentation is live: ringed = controller, solid =
	// watching. Same primitive-key pattern as presenterKey (collaborator arrays
	// churn per cursor move; a string only bumps the epoch when membership/
	// state actually changes).
	const audienceKey = useValue(
		'fvAudienceKey',
		() => {
			const winner = presenterFor(editor.getCollaborators(), shape.id)
			const mineTok = presentStore.get()
			const presenterId = mineTok?.shapeId === shape.id ? editor.user.getId() : winner?.userId
			if (!presenterId) return null
			const rows = new Map<string, string>()
			const add = (id: string, name: string, color: string, state: string) => {
				if (!rows.has(id)) rows.set(id, [id, name, color, state].join(''))
			}
			const selfId = editor.user.getId()
			add(
				selfId,
				`${editor.user.getName()} (you)`,
				editor.user.getColor(),
				presenterId === selfId ? 'presenting' : 'watching'
			)
			for (const c of editor.getCollaborators()) {
				add(c.userId, c.userName, c.color ?? '#3b82f6', c.userId === presenterId ? 'presenting' : 'watching')
			}
			return [...rows.values()].join('')
		},
		[editor, shape.id]
	)

	// Bridge listener: accept ONLY this iframe's own messages (source check).
	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			if (e.source !== iframeRef.current?.contentWindow) return
			const d = e.data as { type?: unknown; fraction?: unknown; event?: unknown } | null
			if (!d || typeof d !== 'object') return
			if (d.type === 'ew-dev-error' && typeof (d as any).detail === 'string') {
				setDevErrors((prev) => (prev.length >= 50 ? prev : [...prev, { kind: String((d as any).kind), detail: (d as any).detail }]))
				return
			}
			const pinch = parsePinchMessage(d)
			if (pinch) {
				// Pinch over the interactive viewer zooms the CANVAS (spec:
				// 2026-07-15-pinch-zoom-guard-design.md) — replay on the iframe
				// element so it bubbles into tldraw's own wheel/zoom path.
				if (iframeRef.current) forwardPinchToCanvas(iframeRef.current, pinch)
				return
			}
			if (d.type === 'ew-rrweb-event') {
				broadcasterRef.current?.push((d as { event: unknown }).event)
				return
			}
			if (d.type === 'ew-file-viewer-ready') {
				// Presenter's own refresh/rev reload → re-apply the last fraction so
				// the reloaded document lands where the presenter left it (spec §5).
				const mine = presentStore.get()
				if (mine && mine.shapeId === shape.id) {
					postScrollSet(mine.fraction)
					// Reloaded mid-presentation → restart the recorder; rrweb emits a
					// fresh Meta+FullSnapshot which followers splice by seq as usual.
					if (broadcasterRef.current) {
						iframeRef.current?.contentWindow?.postMessage({ type: 'ew-present-start' }, '*')
					}
				} else if (activePresenterRef.current) {
					// Follower mid-presentation reload → re-apply the presenter's spot.
					postScrollSet(activePresenterRef.current.fraction)
				}
			} else if (d.type === 'ew-scroll' && typeof d.fraction === 'number') {
				lastFractionRef.current = d.fraction
				const mine = presentStore.get()
				if (mine && mine.shapeId === shape.id) {
					// PRESERVE the toggle-time ts: if scrolling re-stamped it, an
					// incumbent who keeps scrolling could never be stolen from
					// (their token would perpetually out-stamp the stealer's).
					presentStore.set({ shapeId: shape.id, fraction: d.fraction, ts: mine.ts })
				}
			}
		}
		window.addEventListener('message', onMessage)
		return () => window.removeEventListener('message', onMessage)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [shape.id])

	// Follower: drive the iframe whenever the presenter's fraction (or identity)
	// changes. Guarded so the presenter never feeds their own loop back in.
	useEffect(() => {
		if (activePresenter) postScrollSet(activePresenter.fraction)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activePresenter?.fraction, activePresenter?.userId])

	// A new presenter (or handoff) means any prior mirror-fallback no longer
	// applies — give the incoming presentation its own shot at the mirror.
	useEffect(() => {
		setMirrorFallback(false)
	}, [activePresenter?.userId])

	// Editing IS controlling (force-follow spec): the local token lives
	// exactly as long as the editing session. Starting to edit grabs the
	// baton; the edit session ending — deselect, click away, Escape, select
	// another shape — releases it, freezing the shape at our last view for
	// everyone (including us: our own iframe hides behind the frozen mirror
	// once the token clears, and our canvas cursor un-hides — see
	// hideControllerCursor.ts). Idempotent against the yield-on-steal effect
	// below: if a steal already cleared our token (and forced isEditing
	// false) before this runs, `isPresentingThis` is already false here, so
	// the release branch is a no-op — presentStore is local-only, clearing an
	// already-null token never clobbers whoever just stole it.
	useEffect(() => {
		if (isEditing) {
			if (!isPresentingThis) {
				presentStore.set({ shapeId: shape.id, fraction: lastFractionRef.current, ts: Date.now() })
			}
		} else if (isPresentingThis) {
			presentStore.set(null)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isEditing])

	// Someone else took control (their token out-stamps ours): yield — clear our
	// token and exit editing so our iframe hides behind their mirror.
	const myTs = presenting?.shapeId === shape.id ? presenting.ts : null
	useEffect(() => {
		if (myTs !== null && peerPresenter && peerPresenter.ts > myTs) {
			presentStore.set(null)
			if (editor.getEditingShapeId() === shape.id) editor.setEditingShape(null)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [myTs, peerPresenter?.ts, peerPresenter?.userId])

	// Frozen last view: no controller → the mirror replays the backlog and sits
	// still. mirrorFallback (no backlog / old server) reveals the plain iframe.
	const anyController = isPresentingThis || peerPresenter !== null
	const showFrozen = !anyController && !mirrorFallback && !isEditing

	// Reset any stale fallback whenever control changes hands (or is dropped
	// entirely) or the doc refreshes — a new presentation/refresh may
	// repopulate the backlog, so give it its own shot at the mirror.
	useEffect(() => {
		setMirrorFallback(false)
	}, [anyController, rev])

	return (
		<HTMLContainer
			style={{
				display: 'flex',
				flexDirection: 'column',
				width: w,
				height: h,
				borderRadius: 4,
				overflow: 'hidden',
				background: '#fff',
				border: isEditing ? `2px solid ${wm.sealBlue}` : `1px solid ${wm.ruleStrong}`,
				boxShadow: wm.shadowPaper,
				pointerEvents: isEditing ? 'all' : 'none',
			}}
		>
			<div
				onPointerDown={isEditing ? stopEventPropagation : undefined}
				style={{
					height: HEADER_HEIGHT,
					flexShrink: 0,
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					padding: '0 10px',
					background: wm.panel,
					color: wm.inkMuted,
					fontFamily: wm.mono,
					fontSize: 10,
					borderBottom: `1px solid ${wm.rule}`,
					userSelect: 'none',
				}}
			>
				<span
					style={{
						color: wm.ink,
						fontWeight: 700,
						textTransform: 'uppercase',
						letterSpacing: 1.5,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
				>
					{displayTitle}
				</span>
				<span style={{ opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{kind === 'dev' ? `localhost:${port}${path}` : path}
				</span>
				<span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'all' }}>
					{audienceKey && <AudienceRow audienceKey={audienceKey} />}
					{activePresenter && <span style={{ opacity: 0.85 }}>{activePresenter.userName} has control</span>}
					{isPresentingThis && <span style={{ opacity: 0.85 }}>You have control</span>}
					{devErrors.length > 0 && (
						<span
							title={devErrors
								.slice(-10)
								.map((e) => `${e.kind === 'resource' || e.kind === 'request' ? 'proxy/asset' : 'app'}: ${e.detail}`)
								.join('\n')}
							style={{ color: '#b91c1c', fontWeight: 700, pointerEvents: 'all', cursor: 'help' }}
						>
							⚠ {devErrors.length}
						</span>
					)}
					<HeaderButton label="↻" title="Refresh (reloads for everyone)" onClick={refresh} />
				</span>
				{!isEditing && (
					<span style={{ opacity: 0.6 }}>
						{showFrozen ? 'last presented view — double-click to take control' : 'double-click to take control'}
					</span>
				)}
			</div>
			{hasSource ? (
				<>
					{(activePresenter && !mirrorFallback) || showFrozen ? (
						// Suspense fallback null is fine here: RrwebMirror's own
						// FALLBACK_MS logic (plus the frozen-mode instant-bail on an
						// empty backlog) already covers "nothing to show yet" — a brief
						// blank while the lazy chunk itself loads is the same class of
						// gap, not a new one.
						<Suspense fallback={null}>
							<RrwebMirror
								roomId={getRoomId()}
								shapeId={shape.id}
								width={w}
								height={h - HEADER_HEIGHT}
								presenterName={showFrozen ? '' : (activePresenter?.userName ?? '')}
								presenterColor={
									showFrozen ? PRESENTER_FALLBACK_COLOR : (activePresenter?.color ?? PRESENTER_FALLBACK_COLOR)
								}
								onFallback={() => setMirrorFallback(true)}
								frozen={showFrozen}
							/>
						</Suspense>
					) : null}
					<iframe
						ref={iframeRef}
						// src/sandbox derivation (incl. the file-vs-dev SECURITY tradeoff)
						// lives in devSource.ts, ONLY there.
						src={srcFor(shape.props)}
						title={displayTitle}
						style={{
							flex: 1,
							minHeight: 0,
							border: 'none',
							width: '100%',
							pointerEvents: isEditing ? 'all' : 'none',
							display: (activePresenter && !mirrorFallback) || showFrozen ? 'none' : undefined,
						}}
						sandbox={sandboxFor(kind ?? 'file')}
					/>
				</>
			) : (
				<div
					style={{
						flex: 1,
						minHeight: 0,
						display: 'grid',
						placeItems: 'center',
						color: wm.inkSubtle,
						fontFamily: wm.mono,
						fontSize: 11,
					}}
				>
					no source
				</div>
			)}
		</HTMLContainer>
	)
}

function HeaderButton(props: {
	label: string
	title: string
	onClick: () => void
	disabled?: boolean
	active?: boolean
}) {
	return (
		<button
			title={props.title}
			disabled={props.disabled}
			onPointerDown={stopEventPropagation}
			onClick={props.onClick}
			style={{
				border: 'none',
				background: props.active ? wm.sealBlue : 'transparent',
				borderRadius: 3,
				cursor: props.disabled ? 'not-allowed' : 'pointer',
				fontSize: 11,
				fontWeight: props.active ? 700 : 400,
				color: props.active ? '#fff' : props.disabled ? wm.inkSubtle : wm.inkMuted,
				opacity: props.disabled ? 0.5 : 1,
				padding: '2px 6px',
				whiteSpace: 'nowrap',
			}}
		>
			{props.label}
		</button>
	)
}

// One dot per person while a presentation is live: ringed = the controller,
// solid = watching (everyone else, by definition). Colours match canvas
// cursors. audienceKey format: rows joined by , fields by 
// (userId, name, color, state) — built by the fvAudienceKey selector.
function AudienceRow(props: { audienceKey: string }) {
	const rows = props.audienceKey.split('').map((row) => {
		const [userId, name, color, state] = row.split('')
		return { userId, name, color, state }
	})
	return (
		<span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
			{rows.map((r) => (
				<span
					key={r.userId}
					title={r.state === 'presenting' ? `${r.name} — presenting` : `${r.name} — watching`}
					style={{
						width: 8,
						height: 8,
						borderRadius: '50%',
						background: r.color,
						boxShadow: r.state === 'presenting' ? `0 0 0 1.5px ${wm.panel}, 0 0 0 3px ${r.color}` : 'none',
						flexShrink: 0,
					}}
				/>
			))}
		</span>
	)
}
