/**
 * A teammate's shared window/screen as a canvas tile (spec:
 * docs/superpowers/specs/2026-07-02-screenshare-tiles-design.md).
 *
 * Position + size are shared via tldraw sync; the PIXELS are per-viewer —
 * each client attaches the LiveKit track named in the props (store.ts). The
 * sharer attaches their own local track as a self-preview; everyone else
 * receives the remote track only while the tile is in or near their viewport
 * (the loop in AvOverlay). The tile is aspect-locked to the captured surface,
 * and the sharer's client updates `aspect` when the shared window is resized,
 * so the tile always has the window's true proportions.
 */

import { useEffect, useRef, useState } from 'react'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	T,
	TLBaseShape,
	TLResizeInfo,
	resizeBox,
	useEditor,
} from 'tldraw'
import { wm } from '../theme'
import { SCREENSHARE_DEFAULT_W, SCREENSHARE_HEADER_HEIGHT, lockScreenShareAspect, propsForAspect } from './helpers'
import { getScreenShareRoom, useScreenShareTrack } from './store'

// Pure constants + helpers live in helpers.ts (livekit-free so the unit test
// exits cleanly); re-exported here for consumers of the shape module.
export * from './helpers'

// Toolbar icon: a monitor with an outgoing arrow ("share out"). Single-colour
// silhouette rendered by tldraw as a CSS mask; registered via <Tldraw
// assetUrls> in App.tsx (same mechanism as the neko icon).
export const SCREENSHARE_ICON_NAME = 'screenshare'
const SCREENSHARE_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
	'fill="none" stroke="black" stroke-width="2" stroke-linejoin="round">' +
	'<rect x="2" y="4" width="20" height="13" rx="2"/>' +
	'<path d="M12 17v3M8 20h8" stroke-linecap="round"/>' +
	'<path d="M8.5 12 12 8.5 15.5 12M12 8.5V14" stroke-linecap="round"/></svg>'
export const SCREENSHARE_TOOLBAR_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(SCREENSHARE_ICON_SVG)}`

// ── Shape ────────────────────────────────────────────────────────────────────

export interface ScreenShareShapeProps {
	w: number
	h: number
	// LiveKit participant identity of the sharer + their track name — the join
	// key between this shape and the media plane. Never route by source.
	participantId: string
	trackName: string
	title: string
	// Captured surface width/height ratio; the sharer's client rewrites it
	// when the shared window is resized, and everyone's aspect lock follows.
	aspect: number
	// /uploads URL of the final frame, stamped by the sharer's client when the
	// share ends, so the tombstone still survives viewer refreshes and reaches
	// people who never saw the stream. Optional: live shares don't have one,
	// and existing rooms need no migration.
	stillUrl?: string
	// Hex of the sharer's identity colour, stamped at creation (share.ts) so
	// every viewer's tile shows the same owner-coloured border. Optional: live
	// shares stamp it, existing rooms need no migration.
	ownerColor?: string
}

declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		screenshare: ScreenShareShapeProps
	}
}

export type ScreenShareShape = TLBaseShape<'screenshare', ScreenShareShapeProps>

export class ScreenShareShapeUtil extends BaseBoxShapeUtil<ScreenShareShape> {
	static override type = 'screenshare' as const
	// Keep in sync with server/src/schema.ts
	static override props = {
		w: T.number,
		h: T.number,
		participantId: T.string,
		trackName: T.string,
		title: T.string,
		aspect: T.number,
		stillUrl: T.string.optional(),
		ownerColor: T.string.optional(),
	}

	override getDefaultProps(): ScreenShareShape['props'] {
		return {
			w: SCREENSHARE_DEFAULT_W,
			...propsForAspect(SCREENSHARE_DEFAULT_W, 16 / 9),
			participantId: '',
			trackName: '',
			title: 'screen share',
		}
	}

	// Locked to the captured surface's proportions — a screen tile with dead
	// letterbox bars invites annotating empty space.
	override isAspectRatioLocked() {
		return true
	}

	override hideRotateHandle() {
		return true
	}

	override onResize(shape: ScreenShareShape, info: TLResizeInfo<ScreenShareShape>) {
		const next = resizeBox(shape, info, { minWidth: 320, minHeight: 200 })
		const locked = lockScreenShareAspect(
			next.props.w,
			next.props.h,
			shape.props.w,
			shape.props.h,
			shape.props.aspect
		)
		return { ...next, props: { ...next.props, ...locked } }
	}

	override component(shape: ScreenShareShape) {
		return <ScreenShareComponent shape={shape} />
	}

	override getIndicatorPath(shape: ScreenShareShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function ScreenShareComponent({ shape }: { shape: ScreenShareShape }) {
	const { w, h, title, participantId, trackName, stillUrl, ownerColor } = shape.props
	const editor = useEditor()
	const state = useScreenShareTrack(participantId, trackName)
	// Keyed on the track object (stable per publication) so version bumps that
	// don't change the track never re-attach the video element.
	const track = state.kind === 'live' ? state.track : null
	const videoRef = useRef<HTMLDivElement>(null)
	// Still of the last frame this viewer saw, captured as the track detaches.
	// Shown while the tile is not live: a stopped share stays on the canvas as
	// an annotatable artifact instead of a blank placeholder. Per-viewer and
	// in-memory only — someone who never saw the stream gets the text fallback.
	const [lastFrame, setLastFrame] = useState<string | null>(null)

	useEffect(() => {
		const el = videoRef.current
		if (!el || !track) return
		const video = track.attach() as HTMLVideoElement
		// No track audio in v1 (video-only capture) — muted also keeps
		// autoplay policies out of the way.
		video.muted = true
		// contain, not cover: during a source-window resize the aspect prop
		// lags the pixels by up to a second — letterbox briefly, never distort.
		Object.assign(video.style, {
			width: '100%',
			height: '100%',
			objectFit: 'contain',
			background: '#000',
		})
		el.appendChild(video)
		return () => {
			// Freeze the final frame before the element goes away (the video
			// still holds its last decoded frame at detach time). Downscale to
			// the tile's default width — a full 1080p+ data URL is hundreds of
			// KB of base64 held in state per tombstone; 1280 keeps text legible
			// under zoom at a fraction of that.
			if (video.videoWidth > 0) {
				try {
					const scale = Math.min(1, 1280 / video.videoWidth)
					const canvas = document.createElement('canvas')
					canvas.width = Math.round(video.videoWidth * scale)
					canvas.height = Math.round(video.videoHeight * scale)
					canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
					setLastFrame(canvas.toDataURL('image/jpeg', 0.7))
				} catch {
					/* draw failed — the text placeholder covers it */
				}
			}
			track.detach(video)
			video.remove()
		}
	}, [track])

	// Persist the tombstone across refreshes: when a share ends, the SHARER's
	// client (the one guaranteed to have captured the final frame) uploads it
	// once via the same /uploads path as dropped images and stamps the URL into
	// the synced props. One bounded ≤1280w JPEG per stopped share, stored
	// server-side — never inline in the sync document. Viewers who never saw
	// the stream (or who reload) render this instead of their in-memory frame.
	useEffect(() => {
		if (state.kind !== 'ended' || !lastFrame || stillUrl) return
		if (getScreenShareRoom()?.localParticipant.identity !== participantId) return
		let cancelled = false
		;(async () => {
			try {
				const blob = await (await fetch(lastFrame)).blob()
				// No file extension: the server's sanitizeId allows [a-zA-Z0-9_-]
				// only; browsers sniff the JPEG fine in an <img> context.
				const id = `screenstill-${trackName.slice('screen:'.length)}`
				const res = await fetch(`/uploads/${id}`, { method: 'PUT', body: blob })
				if (!res.ok || cancelled || !editor.getShape(shape.id)) return
				editor.updateShape({
					id: shape.id,
					type: 'screenshare',
					props: { stillUrl: `/uploads/${id}` },
				})
			} catch {
				/* best-effort — this viewer's in-memory frame still shows */
			}
		})()
		return () => {
			cancelled = true
		}
	}, [state.kind, lastFrame, stillUrl, participantId, trackName, shape.id, editor])

	const statusColor =
		state.kind === 'live' ? wm.ok : state.kind === 'connecting' ? wm.warn : wm.inkSubtle

	return (
		<HTMLContainer
			data-screenshare={trackName}
			data-screenshare-state={state.kind}
			style={{
				display: 'flex',
				flexDirection: 'column',
				width: w,
				height: h,
				borderRadius: 4,
				overflow: 'hidden',
				background: '#000',
				border: `2px solid ${ownerColor || wm.ruleStrong}`,
				boxShadow: wm.shadowPaper,
				// Display-only tile: all interaction is tldraw's (move/resize/
				// annotate). No edit mode, unlike neko — there's nothing to drive.
				pointerEvents: 'none',
			}}
		>
			<div
				style={{
					height: SCREENSHARE_HEADER_HEIGHT,
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
				title="A minimized or fully covered source window may freeze — keep it visible on the sharer's machine"
			>
				<span
					style={{
						width: 8,
						height: 8,
						borderRadius: '50%',
						background: statusColor,
						flex: '0 0 auto',
					}}
				/>
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
					{title}
				</span>
				<span style={{ opacity: 0.6, whiteSpace: 'nowrap', marginLeft: 'auto' }}>
					screen share · {state.kind}
				</span>
			</div>
			{/* Prefer this session's in-memory capture; fall back to the synced
			    upload so refreshed/late viewers still see the final frame. */}
			<div ref={videoRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
				{state.kind !== 'live' &&
					(lastFrame || stillUrl ? (
						<>
							<img
								src={lastFrame ?? stillUrl}
								alt="last shared frame"
								style={{
									position: 'absolute',
									inset: 0,
									width: '100%',
									height: '100%',
									objectFit: 'contain',
									background: '#000',
									// Ended tiles read as a still, not a live feed.
									filter:
										state.kind === 'ended' ? 'grayscale(0.5) brightness(0.8)' : undefined,
								}}
							/>
							<span
								style={{
									position: 'absolute',
									top: 8,
									left: 8,
									padding: '2px 8px',
									borderRadius: 3,
									background: 'rgba(17,17,17,0.75)',
									color: wm.cream,
									fontFamily: wm.mono,
									fontSize: 10,
									textTransform: 'uppercase',
									letterSpacing: 0.8,
								}}
							>
								{state.kind === 'ended' ? 'share ended' : 'paused'}
							</span>
						</>
					) : (
						<div
							style={{
								position: 'absolute',
								inset: 0,
								display: 'grid',
								placeItems: 'center',
								color: wm.inkMuted,
								fontFamily: wm.mono,
								fontSize: 12,
								background: '#111',
							}}
						>
							{state.kind === 'connecting'
								? 'connecting…'
								: 'share ended — safe to delete this tile'}
						</div>
					))}
			</div>
		</HTMLContainer>
	)
}
