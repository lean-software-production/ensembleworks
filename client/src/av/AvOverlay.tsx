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
import { useEffect, useRef, useState } from 'react'
import { DefaultColorStyle, stopEventPropagation, useEditor, useValue } from 'tldraw'
import { IDENTITY_COLORS, hexForColor, type IdentityColor } from '../colors'
import { getRoomId, setUserColor } from '../identity'
import { retintLocalShares } from '../screenshare/share'
import { wm } from '../theme'
import { LatencyPill, VmStrip } from './gauges'
import { AvIconButton } from './icons'
import { FacesRail, type RailFaceData } from './rail'
import { DEFAULT_SPATIAL_SETTINGS, distance, gainForDistance } from './spatial'
import { TranscriptModal } from './TranscriptModal'
import { useLiveKitRoom } from './useLiveKitRoom'
import { type LatencySample, type VmStats, useSessionPulse } from './useSessionPulse'

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
			<ColorDot color={participant.color} isLocal={participant.isLocal} />
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

// The roster colour dot. For remote users it's a static swatch. For the local
// user it's a button that opens a picker of the identity palette — one control
// that governs the user's whole colour identity (cursor, ring, roster dot, new
// stickies, next-drawn shapes, and screenshare borders). Lives on the roster
// (not the faces rail) so it's reachable even with the camera off.
function ColorDot({ color, isLocal }: { color: string; isLocal: boolean }) {
	const editor = useEditor()
	const [open, setOpen] = useState(false)

	const dotStyle: React.CSSProperties = {
		width: 8,
		height: 8,
		borderRadius: '50%',
		background: color,
		flex: '0 0 auto',
	}

	if (!isLocal) return <span style={dotStyle} />

	const pick = (key: IdentityColor) => {
		setUserColor(key)
		const hex = hexForColor(key, editor.user.getIsDarkMode())
		editor.user.updateUserPreferences({ color: hex })
		editor.setStyleForNextShapes(DefaultColorStyle, key)
		// Re-tint any windows I'm already sharing. ownerColor is a synced prop,
		// so updating it here recolours the tile for every viewer, not just me.
		retintLocalShares(editor, hex)
		setOpen(false)
	}

	return (
		<div style={{ position: 'relative', flex: '0 0 auto', display: 'flex' }}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				title="Change your colour"
				style={{
					...dotStyle,
					border: `1px solid ${wm.rule}`,
					padding: 0,
					cursor: 'pointer',
				}}
			/>
			{open && (
				<div
					style={{
						position: 'absolute',
						top: 14,
						left: 0,
						zIndex: 10,
						display: 'grid',
						gridTemplateColumns: 'repeat(5, 16px)',
						gap: 4,
						padding: 6,
						background: wm.panel,
						border: `1px solid ${wm.rule}`,
						borderRadius: 4,
						boxShadow: wm.shadowPaper,
					}}
				>
					{IDENTITY_COLORS.map((key) => {
						const hex = hexForColor(key, editor.user.getIsDarkMode())
						const selected = hex.toLowerCase() === color.toLowerCase()
						return (
							<button
								key={key}
								type="button"
								onClick={() => pick(key)}
								title={key}
								style={{
									width: 16,
									height: 16,
									borderRadius: '50%',
									background: hex,
									border: selected ? `2px solid ${wm.ink}` : `1px solid ${wm.rule}`,
									padding: 0,
									cursor: 'pointer',
								}}
							/>
						)
					})}
				</div>
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
