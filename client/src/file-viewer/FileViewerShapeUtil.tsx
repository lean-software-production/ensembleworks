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
 * Double-click to interact; click away to go back to canvas navigation.
 */
import { fileViewerShapeProps } from '@ensembleworks/contracts'
import { useEffect, useRef, useState } from 'react'
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
import { presenterFor, type PresenterInfo } from './followLogic'
import { forwardPinchToCanvas, parsePinchMessage } from './pinchForward'
import { presentStore } from './presentStore'

export interface FileViewerShapeProps {
	w: number
	h: number
	// Path relative to the agent user's home, e.g. "my-repo/docs/report.html".
	path: string
	title: string
	// Bumped by POST /api/canvas/file-viewer refresh so every client reloads.
	rev?: number
	// Remote gateway id (future); optional so existing rooms need no migration.
	gateway?: string
}

declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		'file-viewer': FileViewerShapeProps
	}
}

export type FileViewerShape = TLBaseShape<'file-viewer', FileViewerShapeProps>

const HEADER_HEIGHT = 28

export class FileViewerShapeUtil extends BaseBoxShapeUtil<FileViewerShape> {
	static override type = 'file-viewer' as const
	static override props = fileViewerShapeProps

	override getDefaultProps(): FileViewerShape['props'] {
		return { w: 720, h: 540, path: '', title: '', rev: 0 }
	}

	override canEdit() {
		return true
	}
	override hideRotateHandle() {
		return true
	}

	override onResize(shape: FileViewerShape, info: TLResizeInfo<FileViewerShape>) {
		return resizeBox(shape, info, { minWidth: 320, minHeight: 200 })
	}

	override component(shape: FileViewerShape) {
		return <FileViewerShapeComponent shape={shape} />
	}

	override getIndicatorPath(shape: FileViewerShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function FileViewerShapeComponent({ shape }: { shape: FileViewerShape }) {
	const editor = useEditor()
	const isEditing = useValue(
		'isEditing',
		() => editor.getEditingShapeId() === shape.id,
		[editor, shape.id]
	)
	const { path, w, h, rev } = shape.props
	const displayTitle = shape.props.title || path || 'file viewer'

	const refresh = () => {
		editor.updateShape({
			id: shape.id,
			type: 'file-viewer',
			props: { rev: (shape.props.rev ?? 0) + 1 },
		})
	}

	// Scroll-follow (spec §5). All per-user; presenter token rides presence meta
	// via presentStore, followers read it off collaborator presence.
	const iframeRef = useRef<HTMLIFrameElement | null>(null)
	const lastFractionRef = useRef(0)
	// "stop" opts out of ONE presenter (their userId), not of following in
	// general — a gapless A→B handoff must still start following B.
	const [optOutId, setOptOutId] = useState<string | null>(null)

	// Am I presenting THIS shape? (presentStore wraps a tldraw atom → reactive.)
	const presenting = useValue('fvPresenting', () => presentStore.get(), [])
	const isPresentingThis = presenting?.shapeId === shape.id

	// A peer presenting this shape (never me — getCollaborators is remote-only,
	// but guard on userId too). Following is mutually exclusive with presenting.
	// The selector collapses to a PRIMITIVE key (userId\tuserName\tfraction) so
	// the useValue epoch only bumps when the presenter/fraction actually changes
	// — getCollaborators() returns a fresh array on every remote cursor move, and
	// an object return here would re-render every file-viewer for each of them.
	// presenterFor stays the single source of matching logic.
	const myId = useValue('fvUserId', () => editor.user.getId(), [editor])
	const presenterKey = useValue(
		'fvPresenterKey',
		() => {
			const p = presenterFor(editor.getCollaborators(), shape.id)
			return p ? `${p.userId}\t${p.userName}\t${p.fraction}` : null
		},
		[editor, shape.id]
	)
	let peer: PresenterInfo | null = null
	if (presenterKey !== null) {
		// fraction is the last field; join the middle back in case a userName
		// ever contains a tab (defensive — tldraw names are plain strings).
		const parts = presenterKey.split('\t')
		peer = {
			userId: parts[0],
			userName: parts.slice(1, -1).join('\t'),
			fraction: Number(parts[parts.length - 1]),
		}
	}
	const peerPresenter = peer && peer.userId !== myId ? peer : null
	const activePresenter: PresenterInfo | null =
		!isPresentingThis && peerPresenter && peerPresenter.userId !== optOutId ? peerPresenter : null

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

	// Bridge listener: accept ONLY this iframe's own messages (source check).
	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			if (e.source !== iframeRef.current?.contentWindow) return
			const d = e.data as { type?: unknown; fraction?: unknown } | null
			if (!d || typeof d !== 'object') return
			const pinch = parsePinchMessage(d)
			if (pinch) {
				// Pinch over the interactive viewer zooms the CANVAS (spec:
				// 2026-07-15-pinch-zoom-guard-design.md) — replay on the iframe
				// element so it bubbles into tldraw's own wheel/zoom path.
				if (iframeRef.current) forwardPinchToCanvas(iframeRef.current, pinch)
				return
			}
			if (d.type === 'ew-file-viewer-ready') {
				// Presenter's own refresh/rev reload → re-apply the last fraction so
				// the reloaded document lands where the presenter left it (spec §5).
				const mine = presentStore.get()
				if (mine && mine.shapeId === shape.id) {
					postScrollSet(mine.fraction)
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

	// A local "stop following" opt-out only lasts while someone is presenting —
	// once no presenter remains, reset so the next presentation is followed.
	// (An A→B handoff needs no reset: the opt-out is keyed to A's userId.)
	const hasPeerPresenter = peerPresenter !== null
	useEffect(() => {
		if (!hasPeerPresenter) setOptOutId(null)
	}, [hasPeerPresenter])

	const togglePresent = () => {
		if (isPresentingThis) presentStore.set(null)
		// Turning on overwrites any other presenter: followers resolve competing
		// tokens by the freshest ts (last-writer-wins, spec §5).
		else presentStore.set({ shapeId: shape.id, fraction: lastFractionRef.current, ts: Date.now() })
	}

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
					{path}
				</span>
				<span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'all' }}>
					{activePresenter && (
						<FollowingChip
							name={activePresenter.userName}
							onStop={() => setOptOutId(activePresenter.userId)}
						/>
					)}
					<HeaderButton label="↻" title="Refresh (reloads for everyone)" onClick={refresh} />
					<HeaderButton
						label={isPresentingThis ? 'Presenting — stop' : 'Present'}
						title={
							isPresentingThis
								? 'Stop presenting — others stop following your scroll'
								: 'Present — everyone follows your scroll position'
						}
						active={isPresentingThis}
						onClick={togglePresent}
					/>
				</span>
				{!isEditing && <span style={{ opacity: 0.6 }}>double-click to interact</span>}
			</div>
			{path ? (
				<iframe
					ref={iframeRef}
					// Per-segment encode so exotic names (#, ?, %) round-trip the
					// route's decode-once contract (features/files.ts re-encodes the
					// decoded express param the same way before hitting the file-server).
					src={`/files/${path.split('/').map(encodeURIComponent).join('/')}?rev=${rev ?? 0}`}
					title={displayTitle}
					style={{ flex: 1, minHeight: 0, border: 'none', width: '100%', pointerEvents: isEditing ? 'all' : 'none' }}
					// SECURITY: no `allow-same-origin`, ever. Without it the iframe's
					// document loads into an opaque (null) origin, so file-server
					// content can never read the canvas's cookies/localStorage or reach
					// the credentialed /api endpoints under the app's own origin — even
					// though it shares allow-scripts. Adding allow-same-origin back
					// would let an agent-authored file impersonate the signed-in user.
					sandbox="allow-scripts allow-forms allow-downloads"
				/>
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
					no file
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

// Shown while a peer is presenting this shape and you are tracking their scroll.
// "stop" opts out locally until their presentation ends (spec §5).
function FollowingChip(props: { name: string; onStop: () => void }) {
	return (
		<span
			onPointerDown={stopEventPropagation}
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 4,
				fontSize: 10,
				color: wm.inkMuted,
				whiteSpace: 'nowrap',
			}}
		>
			<span style={{ opacity: 0.85 }}>Following {props.name}</span>
			<button
				title="Stop following this presenter"
				onPointerDown={stopEventPropagation}
				onClick={props.onStop}
				style={{
					border: 'none',
					background: 'transparent',
					cursor: 'pointer',
					fontSize: 10,
					fontWeight: 700,
					color: wm.sealBlue,
					padding: '0 2px',
				}}
			>
				stop
			</button>
		</span>
	)
}
