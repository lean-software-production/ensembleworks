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
} from 'tldraw'
import { wm } from '../theme'
import { useScreenShareTrack } from './store'

// ── Constants + pure helpers (unit-tested via screenshare.test.ts) ──────────

// Fixed header band on top of the video area, same height as the neko shape's.
export const SCREENSHARE_HEADER_HEIGHT = 28
// Default tile width in page units — readable text without dwarfing the canvas.
export const SCREENSHARE_DEFAULT_W = 1280

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

const FALLBACK_ASPECT = 16 / 9

// getDisplayMedia settings can be empty on some platforms; never let a bad
// aspect produce an Infinity/NaN-sized shape.
function safeAspect(aspect: number): number {
	return Number.isFinite(aspect) && aspect > 0 ? aspect : FALLBACK_ASPECT
}

/**
 * Lock a freely-resized box to the stream's aspect (no letterbox at rest).
 * Drives off whichever dimension the drag changed more, so corner and side
 * handles all feel responsive (same behaviour as lockNekoAspect, but the
 * ratio comes from the shape's props instead of a constant).
 */
export function lockScreenShareAspect(
	w: number,
	h: number,
	prevW: number,
	prevH: number,
	aspect: number
): { w: number; h: number } {
	const a = safeAspect(aspect)
	if (Math.abs(h - prevH) > Math.abs(w - prevW)) {
		return { w: (h - SCREENSHARE_HEADER_HEIGHT) * a, h }
	}
	return { w, h: w / a + SCREENSHARE_HEADER_HEIGHT }
}

/**
 * Height + aspect props for a tile of width `w` showing a surface with the
 * given aspect. Used at share time and again whenever the sharer's window is
 * resized (width is kept, height follows — the tile never drifts sideways).
 */
export function propsForAspect(w: number, aspect: number): { h: number; aspect: number } {
	const a = safeAspect(aspect)
	return { h: Math.round(w / a) + SCREENSHARE_HEADER_HEIGHT, aspect: a }
}

/**
 * Chrome labels capture tracks with opaque ids like "screen:0:0" or
 * "window:12345:0"; real window titles (some platforms provide them) pass
 * through as the tile title.
 */
export function titleFromTrackLabel(label: string): string {
	if (!label || /^(screen|window|web-contents-media-stream):/i.test(label)) return 'screen share'
	return label
}

/**
 * Tile title: who is sharing + what they're sharing. Baked into the synced
 * props at share time (not resolved from the room at render time) so a
 * tombstone tile still says whose window it was after the sharer leaves.
 */
export function shareTitle(sharerName: string, trackLabel: string): string {
	const who = sharerName.trim() || 'someone'
	return `${who} · ${titleFromTrackLabel(trackLabel)}`
}

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
	const { w, h, title, participantId, trackName } = shape.props
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
			// still holds its last decoded frame at detach time).
			if (video.videoWidth > 0) {
				try {
					const canvas = document.createElement('canvas')
					canvas.width = video.videoWidth
					canvas.height = video.videoHeight
					canvas.getContext('2d')?.drawImage(video, 0, 0)
					setLastFrame(canvas.toDataURL('image/jpeg', 0.7))
				} catch {
					/* draw failed — the text placeholder covers it */
				}
			}
			track.detach(video)
			video.remove()
		}
	}, [track])

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
				border: `1px solid ${wm.ruleStrong}`,
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
			<div ref={videoRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
				{state.kind !== 'live' && lastFrame && (
					<img
						src={lastFrame}
						alt="last shared frame"
						style={{
							position: 'absolute',
							inset: 0,
							width: '100%',
							height: '100%',
							objectFit: 'contain',
							background: '#000',
							// Ended tiles read as a still, not a live feed.
							filter: state.kind === 'ended' ? 'grayscale(0.5) brightness(0.8)' : undefined,
						}}
					/>
				)}
				{state.kind !== 'live' &&
					(lastFrame ? (
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
