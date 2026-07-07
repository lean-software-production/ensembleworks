import { LocalTrack, RemoteTrack, Track } from 'livekit-client'
import { useEffect, useRef } from 'react'
import { stopEventPropagation } from 'tldraw'
import { wm } from '../theme'

// Faces-rail bubble sizes: base diameter, and the enlarged size while speaking.
const FACE = 56
const FACE_SPEAKING = 84

export interface RailFaceData {
	id: string
	name: string
	color: string
	track: LocalTrack | RemoteTrack | null
	isLocal: boolean
	isSpeaking: boolean
}

export function FacesRail({
	faces,
	hoveredId,
	onHover,
	faceRefs,
}: {
	faces: RailFaceData[]
	hoveredId: string | null
	onHover: (id: string | null) => void
	faceRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
}) {
	return (
		<div
			// Hovering a face leashes it, so the rail itself must take pointers.
			onPointerDown={stopEventPropagation}
			style={{
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				gap: 10,
				background: wm.bg,
				border: `1px solid ${wm.ruleStrong}`,
				borderRadius: 4,
				boxShadow: wm.shadowPaper,
				padding: 10,
				pointerEvents: 'auto',
				fontFamily: wm.sans,
			}}
		>
			<style>
				{'@keyframes faces-speaker-pulse { 0%, 100% { box-shadow: 0 0 0 0 var(--pulse); } 50% { box-shadow: 0 0 0 5px transparent; } }'}
			</style>
			{faces.map((face) => (
				<RailFace
					key={face.id}
					face={face}
					hovered={hoveredId === face.id}
					onHover={onHover}
					faceRefs={faceRefs}
				/>
			))}
		</div>
	)
}

function RailFace({
	face,
	hovered,
	onHover,
	faceRefs,
}: {
	face: RailFaceData
	hovered: boolean
	onHover: (id: string | null) => void
	faceRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
}) {
	const videoRef = useRef<HTMLDivElement>(null)
	const track = face.track
	const size = face.isSpeaking ? FACE_SPEAKING : FACE

	useEffect(() => {
		const el = videoRef.current
		if (!el || !track || track.kind !== Track.Kind.Video) return
		const video = track.attach()
		video.muted = true // audio goes through the spatial WebAudio pipeline
		Object.assign(video.style, { width: '100%', height: '100%', objectFit: 'cover' })
		el.appendChild(video)
		return () => {
			track.detach(video)
			video.remove()
		}
	}, [track])

	// Ring: the cursor colour normally; a brighter speaking ring that pulses;
	// dashed self-view so you can tell your own face from teammates'.
	const ringColor = face.isSpeaking ? wm.sealBlue : face.color
	const ringStyle = face.isLocal ? 'dashed' : 'solid'

	return (
		<div
			data-rail-face={face.id}
			onPointerEnter={() => onHover(face.id)}
			onPointerLeave={() => onHover(null)}
			style={{
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				gap: 3,
				cursor: 'default',
			}}
		>
			<div
				ref={(el) => {
					if (el) faceRefs.current.set(face.id, el)
					else faceRefs.current.delete(face.id)
				}}
				data-video-peer={face.id}
				style={{
					width: size,
					height: size,
					borderRadius: '50%',
					overflow: 'hidden',
					background: wm.ink,
					border: `3px ${ringStyle} ${hovered ? wm.sealBlue : ringColor}`,
					boxShadow: wm.shadowPaper,
					transition: 'width 140ms ease, height 140ms ease',
					// CSS var feeds the pulse keyframe its colour.
					...({ '--pulse': ringColor } as React.CSSProperties),
					animation: face.isSpeaking
						? 'faces-speaker-pulse 1.3s ease-in-out infinite'
						: undefined,
					display: 'grid',
					placeItems: 'center',
					color: wm.cream,
					fontSize: 22,
					fontWeight: 600,
				}}
			>
				<div ref={videoRef} style={{ width: '100%', height: '100%' }} />
				{!track && (face.name[0]?.toUpperCase() ?? '?')}
			</div>
			<div
				style={{
					maxWidth: FACE_SPEAKING + 12,
					textAlign: 'center',
					fontSize: 11,
					fontWeight: 700,
					color: wm.ink,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
				}}
			>
				{face.isLocal ? `${face.name} (you)` : face.name}
			</div>
		</div>
	)
}
