/**
 * The session panel, rendered in tldraw's top-right SharePanel slot:
 *
 * - A docked "faces rail" beneath the panel: one circular video bubble per
 *   camera-on teammate (and yourself), kept off the canvas content so it never
 *   obscures the text people are reading. Pointing is conveyed by the native
 *   tldraw cursors (which carry names again — see App.tsx); a face only draws a
 *   leash to its cursor while that person is speaking or you hover their bubble.
 * - The spatial audio loop: every 150 ms, set each peer's GainNode from the
 *   canvas distance between my viewport centre and their cursor.
 * - The participant roster from tldraw presence, which remains available
 *   even when LiveKit is disabled.
 * - Mic / camera / standup-mode toggles + connection status.
 */
import { LocalTrack, RemoteTrack, Track } from 'livekit-client'
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor, useValue } from 'tldraw'
import { getRoomId } from '../identity'
import { updateScreenShareSubscriptions } from '../screenshare/subscriptions'
import { wm } from '../theme'
import { DEFAULT_SPATIAL_SETTINGS, distance, gainForDistance } from './spatial'
import { useLiveKitRoom } from './useLiveKitRoom'
import { type LatencySample, type VmStats, useSessionPulse } from './useSessionPulse'

// Faces-rail bubble sizes: base diameter, and the enlarged size while speaking.
const FACE = 56
const FACE_SPEAKING = 84

interface RailFaceData {
	id: string
	name: string
	color: string
	track: LocalTrack | RemoteTrack | null
	isLocal: boolean
	isSpeaking: boolean
}

interface Leash {
	id: string
	x1: number
	y1: number
	x2: number
	y2: number
	color: string
	strong: boolean
}

// The LiveKit participant identity is editor.user.getId() (raw, e.g. "abc123"),
// but tldraw presence stores userId as a prefixed TLUserId ("user:abc123").
// Normalise to the raw form on both sides so bubbles and spatial gain match.
function rawId(id: string): string {
	return id.replace(/^user:/, '')
}

export function AvOverlay() {
	const editor = useEditor()
	const identity = useValue('userId', () => editor.user.getId(), [editor])
	const name = useValue('userName', () => editor.user.getName() ?? 'teammate', [editor])
	const color = useValue('userColor', () => editor.user.getColor(), [editor])
	const lk = useLiveKitRoom(getRoomId(), identity, name)
	const pulse = useSessionPulse(getRoomId(), identity)
	const [standupMode, setStandupMode] = useState(true)
	const [transcriptOpen, setTranscriptOpen] = useState(false)
	const [kickError, setKickError] = useState<string | null>(null)
	const [kickingId, setKickingId] = useState<string | null>(null)
	const participants = useValue(
		'participants',
		() => {
			const pageNames = new Map(editor.getPages().map((page) => [page.id, page.name]))
			const currentPageId = editor.getCurrentPageId()
			return [
				{
					id: identity,
					name,
					color,
					isLocal: true,
					pageId: currentPageId,
					pageName: pageNames.get(currentPageId) ?? 'Unknown page',
				},
				...editor.getCollaborators().map((presence) => ({
					id: presence.userId,
					name: presence.userName?.trim() || 'Anonymous',
					color: presence.color,
					isLocal: false,
					pageId: presence.currentPageId,
					pageName: pageNames.get(presence.currentPageId) ?? 'Unknown page',
				})),
			]
		},
		[editor, identity, name, color]
	)

	// Subscribe-only LiveKit participants are bots, not teammates — currently
	// the transcriber scribe. They carry no tldraw presence, so they never land
	// in the page-grouped roster above; surface them on their own so the room
	// can see at a glance that it is being recorded.
	const scribes = lk.peers.filter((peer) => peer.readOnly)

	// The faces shown in the rail: yourself (when your camera is on) followed by
	// every camera-on teammate *on the page you're viewing*. Colours match each
	// person's cursor so a face reads as "that arrow over there"; scoping to the
	// current page keeps the rail showing only the people you're working beside.
	const railFaces = useValue<RailFaceData[]>(
		'railFaces',
		() => {
			const colorById = new Map(
				editor.getCollaboratorsOnCurrentPage().map((c) => [rawId(c.userId), c.color])
			)
			const faces: RailFaceData[] = []
			if (lk.camEnabled && lk.localVideoTrack) {
				faces.push({
					id: rawId(identity),
					name,
					color,
					track: lk.localVideoTrack,
					isLocal: true,
					isSpeaking: lk.localSpeaking,
				})
			}
			for (const peer of lk.peers) {
				if (!peer.videoTrack) continue
				const id = rawId(peer.identity)
				// On another page → not in this map → skip (you only see faces of
				// teammates sharing your current page).
				if (!colorById.has(id)) continue
				faces.push({
					id,
					name: peer.name,
					color: colorById.get(id) ?? wm.ink,
					track: peer.videoTrack,
					isLocal: false,
					isSpeaking: peer.isSpeaking,
				})
			}
			return faces
		},
		[editor, lk.peers, lk.camEnabled, lk.localVideoTrack, lk.localSpeaking, identity, name, color]
	)

	// Hovering a rail face leashes it to its cursor on demand (speakers leash
	// unconditionally). The leash anchors at the face's on-screen centre, so we
	// keep a live ref to each face element keyed by raw identity.
	const [hoveredId, setHoveredId] = useState<string | null>(null)
	const faceRefs = useRef(new Map<string, HTMLDivElement>())

	// Leashes from rail faces to their teammate's live cursor — drawn only for
	// the active speaker or the face you're hovering, and only when that cursor
	// is on the page you're viewing. Recomputes on camera pans and cursor moves.
	const leashes = useValue<Leash[]>(
		'leashes',
		() => {
			editor.getCamera() // subscribe to pan / zoom
			const collaborators = editor.getCollaboratorsOnCurrentPage()
			const out: Leash[] = []
			for (const peer of lk.peers) {
				const id = rawId(peer.identity)
				if (!peer.isSpeaking && hoveredId !== id) continue
				const presence = collaborators.find((c) => rawId(c.userId) === id)
				if (!presence?.cursor) continue
				const el = faceRefs.current.get(id)
				if (!el) continue
				const rect = el.getBoundingClientRect()
				const end = editor.pageToViewport({ x: presence.cursor.x, y: presence.cursor.y })
				out.push({
					id,
					x1: rect.left + rect.width / 2,
					y1: rect.top + rect.height / 2,
					x2: end.x,
					y2: end.y,
					color: presence.color,
					strong: peer.isSpeaking,
				})
			}
			return out
		},
		[editor, lk.peers, hoveredId]
	)

	// Spatial audio loop.
	const peersRef = useRef(lk.peers)
	peersRef.current = lk.peers
	const standupRef = useRef(standupMode)
	standupRef.current = standupMode
	useEffect(() => {
		const timer = setInterval(() => {
			const ctx = lk.audioContext
			if (!ctx) return
			const my = editor.getViewportPageBounds().center
			const collaborators = editor.getCollaboratorsOnCurrentPage()
			for (const peer of peersRef.current) {
				if (!peer.gain) continue
				const presence = collaborators.find((c) => rawId(c.userId) === rawId(peer.identity))
				const target = !presence
					? 0
					: standupRef.current
						? 1
						: presence.cursor
							? gainForDistance(
									distance(my.x, my.y, presence.cursor.x, presence.cursor.y),
									DEFAULT_SPATIAL_SETTINGS
								)
							: 1
				peer.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08)
			}
		}, 150)
		return () => clearInterval(timer)
	}, [editor, lk.audioContext])

	// Viewport-scoped screen-share delivery: only receive screen tracks whose
	// tile is in (or near) my viewport, with hysteresis so edge-panning doesn't
	// flap. Same 150 ms cadence as the spatial audio loop above; the shape/track
	// logic lives with the screenshare feature. Audio subscriptions untouched.
	useEffect(() => {
		const room = lk.room
		if (!room) return
		const timer = setInterval(() => updateScreenShareSubscriptions(editor, room), 150)
		return () => clearInterval(timer)
	}, [editor, lk.room])

	const kickParticipant = async (participant: SessionParticipant) => {
		if (!window.confirm(`Kick ${participant.name} from this session?`)) return
		setKickError(null)
		setKickingId(participant.id)
		try {
			const response = await fetch('/api/kick', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ room: getRoomId(), userId: rawId(participant.id) }),
			})
			const body = (await response.json()) as { error?: string }
			if (!response.ok) throw new Error(body.error || 'Kick failed')
		} catch (error) {
			setKickError(error instanceof Error ? error.message : 'Kick failed')
		} finally {
			setKickingId(null)
		}
	}

	return (
		<>
			<LeashOverlay leashes={leashes} />
			<div
				style={{
					display: 'flex',
					flexDirection: 'column',
					gap: 8,
					alignItems: 'flex-end',
					pointerEvents: 'none',
				}}
			>
				<SessionPanel
					status={lk.status}
					micEnabled={lk.micEnabled}
					camEnabled={lk.camEnabled}
					standupMode={standupMode}
					onMic={() => lk.setMicEnabled(!lk.micEnabled)}
					onCam={() => lk.setCamEnabled(!lk.camEnabled)}
					onStandup={() => setStandupMode((s) => !s)}
					participants={participants}
					vm={pulse.vm}
					latencies={pulse.latencies}
					latencyHistory={pulse.history}
					scribes={scribes.map((scribe) => ({ id: scribe.identity, name: scribe.name }))}
					onParticipantClick={(id) => editor.zoomToUser(id)}
					onParticipantKick={kickParticipant}
					onOpenTranscript={() => setTranscriptOpen(true)}
					kickingId={kickingId}
					kickError={kickError}
				/>
				{railFaces.length > 0 && (
					<FacesRail
						faces={railFaces}
						hoveredId={hoveredId}
						onHover={setHoveredId}
						faceRefs={faceRefs}
					/>
				)}
			</div>
			{transcriptOpen && (
				<TranscriptModal roomId={getRoomId()} onClose={() => setTranscriptOpen(false)} />
			)}
		</>
	)
}

// A full-viewport SVG that draws each active leash from a rail face to its
// teammate's cursor. Non-interactive; sits above the canvas but below the rail.
function LeashOverlay({ leashes }: { leashes: Leash[] }) {
	if (leashes.length === 0) return null
	return (
		<svg
			style={{
				position: 'fixed',
				inset: 0,
				width: '100%',
				height: '100%',
				pointerEvents: 'none',
				zIndex: 999,
			}}
		>
			{leashes.map((l) => (
				<line
					key={l.id}
					x1={l.x1}
					y1={l.y1}
					x2={l.x2}
					y2={l.y2}
					stroke={l.color}
					strokeWidth={l.strong ? 2.5 : 1.5}
					strokeDasharray={l.strong ? undefined : '4 4'}
					strokeLinecap="round"
					opacity={l.strong ? 0.9 : 0.6}
				/>
			))}
		</svg>
	)
}

function FacesRail({
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

interface SessionParticipant {
	id: string
	name: string
	color: string
	isLocal: boolean
	pageId: string
	pageName: string
}

function SessionPanel(props: {
	status: string
	micEnabled: boolean
	camEnabled: boolean
	standupMode: boolean
	participants: SessionParticipant[]
	vm: VmStats | null
	latencies: Record<string, LatencySample>
	latencyHistory: Record<string, number[]>
	scribes: { id: string; name: string }[]
	onMic: () => void
	onCam: () => void
	onStandup: () => void
	onParticipantClick: (id: string) => void
	onParticipantKick: (participant: SessionParticipant) => void
	onOpenTranscript: () => void
	kickingId: string | null
	kickError: string | null
}) {
	const avAvailable = props.status !== 'disabled' && props.status !== 'error'
	const participantGroups = new Map<string, SessionParticipant[]>()
	for (const participant of props.participants) {
		const group = participantGroups.get(participant.pageId) ?? []
		group.push(participant)
		participantGroups.set(participant.pageId, group)
	}
	return (
		<div
			// Keep clicks from reaching the canvas underneath.
			onPointerDown={stopEventPropagation}
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: 7,
				alignItems: 'stretch',
				minWidth: 220,
				maxWidth: 300,
				background: wm.bg,
				border: `1px solid ${wm.ruleStrong}`,
				borderRadius: 4,
				boxShadow: wm.shadowPaper,
				padding: 8,
				pointerEvents: 'auto',
				fontFamily: wm.sans,
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'baseline',
					justifyContent: 'space-between',
					gap: 12,
				}}
			>
				<strong
					style={{
						fontFamily: wm.mono,
						fontSize: 11,
						textTransform: 'uppercase',
						letterSpacing: 1,
					}}
				>
					In session
				</strong>
				<span style={{ fontSize: 11, color: wm.inkSubtle }}>
					{props.participants.length} {props.participants.length === 1 ? 'person' : 'people'}
				</span>
			</div>
			{props.vm && <VmStrip vm={props.vm} />}
			<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
				{[...participantGroups.entries()].map(([pageId, group]) => (
					<div key={pageId} data-roster-page={group[0]!.pageName}>
						<div
							style={{
								fontFamily: wm.mono,
								fontSize: 9,
								fontWeight: 700,
								textTransform: 'uppercase',
								letterSpacing: 0.9,
								color: wm.sealBlue,
								marginBottom: 3,
							}}
						>
							{group[0]!.pageName}
						</div>
						<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
							{group.map((participant) => (
								<ParticipantRow
									key={participant.id}
									participant={participant}
									latency={props.latencies[rawId(participant.id)] ?? null}
									latencyHistory={props.latencyHistory[rawId(participant.id)] ?? []}
									kicking={props.kickingId === participant.id}
									onClick={props.onParticipantClick}
									onKick={props.onParticipantKick}
									avControls={
										participant.isLocal
											? {
												available: avAvailable,
												micEnabled: props.micEnabled,
												camEnabled: props.camEnabled,
												spatialEnabled: !props.standupMode,
												onMic: props.onMic,
												onCam: props.onCam,
												onSpatial: props.onStandup,
											}
											: undefined
									}
								/>
							))}
						</div>
					</div>
				))}
			</div>
			{props.scribes.length > 0 && (
				<div data-roster-scribes>
					<style>
						{'@keyframes scribe-rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }'}
					</style>
					<div
						style={{
							fontFamily: wm.mono,
							fontSize: 9,
							fontWeight: 700,
							textTransform: 'uppercase',
							letterSpacing: 0.9,
							color: wm.crit,
							marginBottom: 3,
						}}
					>
						Recording
					</div>
					<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
						{props.scribes.map((scribe) => (
							<ScribeRow key={scribe.id} name={scribe.name} onOpenTranscript={props.onOpenTranscript} />
						))}
					</div>
				</div>
			)}
			{props.kickError && <span style={{ fontSize: 11, color: wm.crit }}>{props.kickError}</span>}
			{props.status !== 'connected' && (
				<span style={{ fontSize: 11, color: wm.inkSubtle }}>
					Audio/video: {props.status === 'disabled' ? 'unavailable' : props.status}
				</span>
			)}
		</div>
	)
}

function ParticipantRow(props: {
	participant: SessionParticipant
	latency: LatencySample | null
	latencyHistory: number[]
	kicking: boolean
	onClick: (id: string) => void
	onKick: (participant: SessionParticipant) => void
	avControls?: {
		available: boolean
		micEnabled: boolean
		camEnabled: boolean
		spatialEnabled: boolean
		onMic: () => void
		onCam: () => void
		onSpatial: () => void
	}
}) {
	const participant = props.participant
	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 4,
				border: `1px solid ${wm.rule}`,
				borderRadius: 2,
				background: wm.panel,
				padding: 3,
			}}
		>
			<button
				type="button"
				disabled={participant.isLocal}
				onClick={() => props.onClick(participant.id)}
				title={participant.isLocal ? 'You' : `Find ${participant.name} on the canvas`}
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 6,
					minWidth: 0,
					flex: 1,
					border: 0,
					background: 'transparent',
					color: wm.ink,
					padding: '2px 3px',
					fontFamily: wm.sans,
					fontSize: 12,
					cursor: participant.isLocal ? 'default' : 'pointer',
				}}
			>
				<span
					style={{
						width: 8,
						height: 8,
						borderRadius: '50%',
						background: participant.color,
						flex: '0 0 auto',
					}}
				/>
				<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{participant.name}{participant.isLocal ? ' (you)' : ''}
				</span>
			</button>
			<LatencyPill latency={props.latency} history={props.latencyHistory} />
			{props.avControls && (
				<div style={{ display: 'flex', gap: 3, flex: '0 0 auto' }}>
					<AvIconButton
						kind="mic"
						enabled={props.avControls.micEnabled}
						available={props.avControls.available}
						onClick={props.avControls.onMic}
					/>
					<AvIconButton
						kind="camera"
						enabled={props.avControls.camEnabled}
						available={props.avControls.available}
						onClick={props.avControls.onCam}
					/>
					<AvIconButton
						kind="spatial"
						enabled={props.avControls.spatialEnabled}
						available={props.avControls.available}
						onClick={props.avControls.onSpatial}
					/>
				</div>
			)}
			{!participant.isLocal && (
				<button
					type="button"
					disabled={props.kicking}
					onClick={() => props.onKick(participant)}
					aria-label={`Kick ${participant.name}`}
					style={{
						border: `1px solid ${wm.ruleStrong}`,
						borderRadius: 2,
						background: 'transparent',
						color: wm.crit,
						padding: '3px 5px',
						fontFamily: wm.mono,
						fontSize: 9,
						textTransform: 'uppercase',
						cursor: 'pointer',
					}}
				>
					{props.kicking ? 'Kicking' : 'Kick'}
				</button>
			)}
		</div>
	)
}

// A roster row for a subscribe-only bot (the transcriber scribe). Unlike a
// ParticipantRow it isn't clickable (no cursor to zoom to) or kickable — it's
// session infrastructure, shown purely so people know they're being recorded.
function ScribeRow({ name, onOpenTranscript }: { name: string; onOpenTranscript: () => void }) {
	return (
		<div
			title="Transcribing the session into the live minutes"
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 6,
				border: `1px solid ${wm.rule}`,
				borderRadius: 2,
				background: wm.panel,
				padding: '4px 5px',
				fontFamily: wm.sans,
				fontSize: 12,
				color: wm.ink,
			}}
		>
			<span
				aria-hidden="true"
				style={{
					width: 8,
					height: 8,
					borderRadius: '50%',
					background: wm.crit,
					flex: '0 0 auto',
					animation: 'scribe-rec-blink 1.4s ease-in-out infinite',
				}}
			/>
			<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
				{name}
			</span>
			<button
				type="button"
				onClick={onOpenTranscript}
				title="Show the live transcript"
				style={{
					marginLeft: 'auto',
					border: `1px solid ${wm.ruleStrong}`,
					borderRadius: 2,
					background: 'transparent',
					color: wm.sealBlue,
					padding: '3px 6px',
					fontFamily: wm.mono,
					fontSize: 9,
					textTransform: 'uppercase',
					letterSpacing: 0.9,
					cursor: 'pointer',
					flex: '0 0 auto',
				}}
			>
				Transcript
			</button>
		</div>
	)
}

// The shape of a transcript entry as served by GET /api/transcript. Mirrors the
// server's TranscriptEntry; only the fields the modal renders are typed here.
interface TranscriptLine {
	id: string
	t: number
	name: string
	text: string
	frame: { name: string; dist: number } | null
}

// A read-only popup over the canvas showing the session's running transcript.
// Polls every 4s so it stays live while the scribe is recording, and sticks to
// the newest line unless the reader has scrolled up into the history.
function TranscriptModal({ roomId, onClose }: { roomId: string; onClose: () => void }) {
	const [entries, setEntries] = useState<TranscriptLine[]>([])
	const [error, setError] = useState<string | null>(null)
	const [loaded, setLoaded] = useState(false)
	const scrollRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		let cancelled = false
		const load = async () => {
			try {
				const res = await fetch(`/api/transcript?room=${encodeURIComponent(roomId)}&limit=500`)
				const body = (await res.json()) as { entries?: TranscriptLine[]; error?: string }
				if (cancelled) return
				if (!res.ok) throw new Error(body.error || 'Failed to load transcript')
				setEntries(body.entries ?? [])
				setError(null)
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load transcript')
			} finally {
				if (!cancelled) setLoaded(true)
			}
		}
		load()
		const timer = setInterval(load, 4000)
		return () => {
			cancelled = true
			clearInterval(timer)
		}
	}, [roomId])

	// Follow the tail on new lines, but leave the scroll alone if the reader has
	// scrolled up to revisit earlier turns.
	useEffect(() => {
		const el = scrollRef.current
		if (!el) return
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight
	}, [entries])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose])

	return (
		<div
			// Click the backdrop (but not the panel) to dismiss.
			onPointerDown={(e) => {
				stopEventPropagation(e)
				onClose()
			}}
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 1000,
				display: 'grid',
				placeItems: 'center',
				background: 'rgba(0, 0, 0, 0.35)',
				pointerEvents: 'auto',
			}}
		>
			<div
				onPointerDown={stopEventPropagation}
				style={{
					display: 'flex',
					flexDirection: 'column',
					width: 'min(560px, 90vw)',
					maxHeight: '80vh',
					background: wm.bg,
					border: `1px solid ${wm.ruleStrong}`,
					borderRadius: 4,
					boxShadow: wm.shadowPaper,
					fontFamily: wm.sans,
				}}
			>
				<div
					style={{
						display: 'flex',
						alignItems: 'baseline',
						justifyContent: 'space-between',
						gap: 12,
						padding: '10px 12px',
						borderBottom: `1px solid ${wm.rule}`,
					}}
				>
					<strong
						style={{
							fontFamily: wm.mono,
							fontSize: 11,
							textTransform: 'uppercase',
							letterSpacing: 1,
						}}
					>
						Session transcript
					</strong>
					<span style={{ fontSize: 11, color: wm.inkSubtle }}>
						{entries.length} {entries.length === 1 ? 'line' : 'lines'}
					</span>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close transcript"
						style={{
							border: `1px solid ${wm.ruleStrong}`,
							borderRadius: 2,
							background: 'transparent',
							color: wm.ink,
							padding: '2px 8px',
							fontFamily: wm.mono,
							fontSize: 12,
							cursor: 'pointer',
						}}
					>
						✕
					</button>
				</div>
				<div
					ref={scrollRef}
					style={{
						overflowY: 'auto',
						padding: '10px 12px',
						display: 'flex',
						flexDirection: 'column',
						gap: 10,
					}}
				>
					{error && <span style={{ fontSize: 12, color: wm.crit }}>{error}</span>}
					{!error && !loaded && (
						<span style={{ fontSize: 12, color: wm.inkSubtle }}>Loading…</span>
					)}
					{!error && loaded && entries.length === 0 && (
						<span style={{ fontSize: 12, color: wm.inkSubtle }}>
							No transcript yet — say something and it'll appear here.
						</span>
					)}
					{entries.map((entry) => (
						<div key={entry.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
							<div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
								<span style={{ fontFamily: wm.mono, fontSize: 10, color: wm.inkSubtle }}>
									{new Date(entry.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
								</span>
								<span style={{ fontSize: 12, fontWeight: 700, color: wm.ink }}>{entry.name}</span>
								{entry.frame && (
									<span
										style={{
											fontFamily: wm.mono,
											fontSize: 9,
											textTransform: 'uppercase',
											letterSpacing: 0.6,
											color: wm.sealBlue,
										}}
									>
										{entry.frame.name}
									</span>
								)}
							</div>
							<div style={{ fontSize: 13, lineHeight: 1.4, color: wm.ink }}>{entry.text}</div>
						</div>
					))}
				</div>
			</div>
		</div>
	)
}

// Green/amber/red by threshold — shared by the VM bars and the latency pills so
// "amber" means the same kind of "getting tight" everywhere in the panel.
function gradeColor(value: number, warn: number, crit: number): string {
	if (value >= crit) return wm.crit
	if (value >= warn) return wm.warn
	return wm.ok
}

function fmtBytes(n: number): string {
	if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)}G`
	if (n >= 1 << 20) return `${Math.round(n / (1 << 20))}M`
	return `${Math.round(n / 1024)}K`
}

// The VM-pressure strip: two compact bars (CPU then MEM) reading the one shared
// box everyone's terminals run on. MEM tracks the cgroup slice — the thing that
// OOM-kills the box — so its amber line sits at memory.high. Tooltips carry the
// raw load average, PSI stall %, and byte figures.
function VmStrip({ vm }: { vm: VmStats }) {
	const cpuTip =
		`CPU load ${vm.cpu.load1} on ${vm.cpu.cores} core${vm.cpu.cores === 1 ? '' : 's'}` +
		(vm.cpu.pressure != null ? ` · stall ${vm.cpu.pressure}%/10s` : '')
	const memHighPct =
		vm.mem.limitBytes && vm.mem.highBytes ? (vm.mem.highBytes / vm.mem.limitBytes) * 100 : null
	const memTip =
		`Memory ${fmtBytes(vm.mem.usedBytes)}${vm.mem.limitBytes ? ` / ${fmtBytes(vm.mem.limitBytes)}` : ''}` +
		` (${vm.mem.source})` +
		(vm.mem.pressure != null ? ` · stall ${vm.mem.pressure}%/10s` : '')
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 3 }} data-vm-strip>
			<VmBar
				label="LOAD"
				pct={vm.cpu.pct}
				color={gradeColor(vm.cpu.pct, 60, 85)}
				caption={`${Math.round(vm.cpu.pct)}%`}
				title={cpuTip}
			/>
			<VmBar
				label="MEM"
				pct={vm.mem.usedPct}
				color={gradeColor(vm.mem.usedPct, memHighPct ?? 70, 90)}
				caption={`${Math.round(vm.mem.usedPct)}%`}
				title={memTip}
				mark={memHighPct}
			/>
		</div>
	)
}

function VmBar(props: {
	label: string
	pct: number
	color: string
	caption: string
	title: string
	// Optional amber tick drawn at this percent (the memory.high throttle line).
	mark?: number | null
}) {
	return (
		<div title={props.title} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
			<span
				style={{
					fontFamily: wm.mono,
					fontSize: 8,
					fontWeight: 700,
					letterSpacing: 0.6,
					color: wm.inkMuted,
					width: 26,
					flex: '0 0 auto',
				}}
			>
				{props.label}
			</span>
			<div
				style={{
					position: 'relative',
					flex: 1,
					height: 6,
					borderRadius: 3,
					background: wm.panelWarm,
					overflow: 'hidden',
				}}
			>
				<div
					style={{
						width: `${Math.min(100, Math.max(0, props.pct))}%`,
						height: '100%',
						background: props.color,
						transition: 'width 600ms ease, background 600ms ease',
					}}
				/>
				{props.mark != null && (
					<div
						style={{
							position: 'absolute',
							top: 0,
							bottom: 0,
							left: `${Math.min(100, Math.max(0, props.mark))}%`,
							width: 1,
							background: wm.ink,
							opacity: 0.45,
						}}
					/>
				)}
			</div>
			<span
				style={{
					fontFamily: wm.mono,
					fontSize: 9,
					color: wm.inkMuted,
					width: 30,
					textAlign: 'right',
					flex: '0 0 auto',
				}}
			>
				{props.caption}
			</span>
		</div>
	)
}

// A small round-trip badge per participant row: a tiny line graph of the recent
// round-trips, with the numbers (min/max/latest) tucked into the hover tooltip.
// Normalised over its own min/max so the shape fills the box. Fewer than two
// samples can't draw a line, so it reads as a muted dash until the trail fills.
function LatencyPill({ latency, history }: { latency: LatencySample | null; history: number[] }) {
	const known = latency != null
	const ms = latency?.rtt ?? 0
	const color = known ? gradeColor(ms, 120, 300) : wm.inkSubtle
	const w = 36
	const h = 11
	const min = history.length ? Math.min(...history) : 0
	const max = history.length ? Math.max(...history) : 0
	const title = known
		? `Round-trip to the server — now ${ms} ms, min ${min} ms, max ${max} ms (last ${history.length})`
		: 'No recent latency sample'

	if (history.length < 2) {
		return (
			<span
				title={title}
				style={{
					display: 'inline-flex',
					alignItems: 'center',
					justifyContent: 'center',
					width: w,
					flex: '0 0 auto',
					fontFamily: wm.mono,
					fontSize: 9,
					color: wm.inkSubtle,
				}}
			>
				—
			</span>
		)
	}

	const span = max - min || 1
	const stepX = w / (history.length - 1)
	// SVG y grows downward, so a higher rtt sits nearer the top (1px inset).
	const coords = history
		.map((p, i) => `${(i * stepX).toFixed(1)},${(1 + (1 - (p - min) / span) * (h - 2)).toFixed(1)}`)
		.join(' ')
	return (
		<svg
			width={w}
			height={h}
			viewBox={`0 0 ${w} ${h}`}
			style={{ flex: '0 0 auto', display: 'block' }}
		>
			<title>{title}</title>
			<polyline
				points={coords}
				fill="none"
				stroke={color}
				strokeWidth={1}
				strokeLinejoin="round"
				strokeLinecap="round"
			/>
		</svg>
	)
}

type AvIconKind = 'mic' | 'camera' | 'spatial'

function AvIconButton(props: {
	kind: AvIconKind
	enabled: boolean
	available: boolean
	onClick: () => void
}) {
	const names: Record<AvIconKind, string> = {
		mic: 'microphone',
		camera: 'camera',
		spatial: 'spatial audio',
	}
	const label = `${names[props.kind]} ${props.enabled ? 'on' : 'off'}`
	return (
		<button
			type="button"
			disabled={!props.available}
			onClick={props.onClick}
			aria-label={label}
			title={props.available ? label : `${names[props.kind]} unavailable`}
			style={{
				width: 25,
				height: 25,
				display: 'grid',
				placeItems: 'center',
				border: `1px solid ${props.enabled ? wm.sealBlue : wm.ruleStrong}`,
				borderRadius: 2,
				padding: 3,
				background: props.enabled ? wm.sealBlue : 'transparent',
				color: props.enabled ? wm.cream : wm.inkMuted,
				cursor: props.available ? 'pointer' : 'not-allowed',
				opacity: props.available ? 1 : 0.4,
			}}
		>
			<AvIcon kind={props.kind} crossedOut={!props.enabled} />
		</button>
	)
}

function AvIcon({ kind, crossedOut }: { kind: AvIconKind; crossedOut: boolean }) {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			{kind === 'mic' && (
				<>
					<rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="2" />
					<path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
				</>
			)}
			{kind === 'camera' && (
				<>
					<rect x="3" y="7" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
					<path d="m16 11 5-3v9l-5-3" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
				</>
			)}
			{kind === 'spatial' && (
				<>
					<circle cx="12" cy="12" r="2" fill="currentColor" />
					<path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
				</>
			)}
			{crossedOut && <path d="M4 4 20 20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />}
		</svg>
	)
}
