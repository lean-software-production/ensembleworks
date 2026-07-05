/**
 * The session panel orchestrator, rendered in tldraw's top-right SharePanel
 * slot. Derives the roster, rail faces and leashes from tldraw presence +
 * LiveKit state, runs the spatial-audio loop, and composes the pieces:
 * SessionPanel (roster/controls), FacesRail, LeashOverlay, TranscriptModal.
 * The screenshare subscription loop lives with the screenshare plugin.
 */
import { rawUserId } from '@ensembleworks/contracts'
import { useRef, useState } from 'react'
import { useEditor, useValue } from 'tldraw'
import { getRoomId } from '../identity'
import { wm } from '../theme'
import { LeashOverlay, useLeashes } from './leashes'
import { FacesRail, type RailFaceData } from './rail'
import { SessionPanel, type SessionParticipant } from './SessionPanel'
import { TranscriptModal } from './TranscriptModal'
import { useLiveKitRoom } from './useLiveKitRoom'
import { useSessionPulse } from './useSessionPulse'
import { useSpatialGainLoop } from './useSpatialGainLoop'

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
				editor.getCollaboratorsOnCurrentPage().map((c) => [rawUserId(c.userId), c.color])
			)
			const faces: RailFaceData[] = []
			if (lk.camEnabled && lk.localVideoTrack) {
				faces.push({
					id: rawUserId(identity),
					name,
					color,
					track: lk.localVideoTrack,
					isLocal: true,
					isSpeaking: lk.localSpeaking,
				})
			}
			for (const peer of lk.peers) {
				if (!peer.videoTrack) continue
				const id = rawUserId(peer.identity)
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
	const leashes = useLeashes(editor, lk.peers, hoveredId, faceRefs)

	// Spatial audio loop.
	useSpatialGainLoop(editor, lk, standupMode)

	const kickParticipant = async (participant: SessionParticipant) => {
		if (!window.confirm(`Kick ${participant.name} from this session?`)) return
		setKickError(null)
		setKickingId(participant.id)
		try {
			const response = await fetch('/api/kick', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ room: getRoomId(), userId: rawUserId(participant.id) }),
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
