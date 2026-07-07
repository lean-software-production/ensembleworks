/**
 * The session panel orchestrator, rendered in tldraw's top-right SharePanel
 * slot. Derives the roster, rail faces and leashes from tldraw presence +
 * LiveKit state, runs the spatial-audio loop, and composes the pieces:
 * SessionPanel (roster/controls), FacesRail, LeashOverlay, TranscriptModal.
 * The screenshare subscription loop lives with the screenshare plugin.
 */
import { rawUserId } from '@ensembleworks/contracts'
import { useEffect, useRef, useState } from 'react'
import { useEditor, useValue } from 'tldraw'
import { getRoomId } from '../identity'
import { wm } from '../theme'
import { publishAvSnapshot } from './bridge'
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

	// Takes (id, name) rather than a full SessionParticipant: those are the only
	// two fields it uses, and it doubles as the bridge's `actions.kick` — which
	// only has a raw id + display name to offer (the panel tile isn't a
	// SessionParticipant).
	const kickParticipant = async (id: string, name: string) => {
		if (!window.confirm(`Kick ${name} from this session?`)) return
		setKickError(null)
		setKickingId(id)
		try {
			const response = await fetch('/api/av/kick', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ room: getRoomId(), userId: rawUserId(id) }),
			})
			const body = (await response.json()) as { error?: string }
			if (!response.ok) throw new Error(body.error || 'Kick failed')
		} catch (error) {
			setKickError(error instanceof Error ? error.message : 'Kick failed')
		} finally {
			setKickingId(null)
		}
	}

	// Publish A/V state for the side panel (an App-level flex sibling outside
	// tldraw context — see av/bridge.ts) on every relevant change. Scribes are
	// LiveKit-only (no tldraw presence) so they're excluded from `peers`.
	useEffect(() => {
		publishAvSnapshot({
			status: lk.status,
			micEnabled: lk.micEnabled,
			camEnabled: lk.camEnabled,
			standupMode,
			localVideoTrack: lk.localVideoTrack,
			localSpeaking: lk.localSpeaking,
			peers: lk.peers
				.filter((peer) => !peer.readOnly)
				.map((peer) => ({
					id: rawUserId(peer.identity),
					name: peer.name,
					videoTrack: peer.videoTrack,
					isSpeaking: peer.isSpeaking,
				})),
			scribes: scribes.map((scribe) => ({ id: scribe.identity, name: scribe.name })),
			vm: pulse.vm,
			latencies: pulse.latencies,
			latencyHistory: pulse.history,
			kickingId,
			kickError,
			actions: {
				onMic: () => lk.setMicEnabled(!lk.micEnabled),
				onCam: () => lk.setCamEnabled(!lk.camEnabled),
				onStandup: () => setStandupMode((s) => !s),
				kick: kickParticipant,
			},
		})
	}, [
		lk.status,
		lk.micEnabled,
		lk.camEnabled,
		standupMode,
		lk.localVideoTrack,
		lk.localSpeaking,
		lk.peers,
		scribes,
		pulse.vm,
		pulse.latencies,
		pulse.history,
		kickingId,
		kickError,
	])

	// Cleanup lives in its own mount-only effect so intermediate re-renders
	// (the effect above fires often) don't flash the panel back to null
	// between an old snapshot and the next one.
	useEffect(() => {
		return () => publishAvSnapshot(null)
	}, [])

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
					onParticipantKick={(participant) => kickParticipant(participant.id, participant.name)}
					onOpenTranscript={() => setTranscriptOpen(true)}
					kickingId={kickingId}
					kickError={kickError}
				/>
				{railFaces.length > 0 && (
					// Dim (don't clear) the rail while the link is degraded — frozen
					// faded faces read as "my connection is bad", not "everyone left".
					<div
						style={{
							opacity: lk.status === 'reconnecting' || lk.status === 'retrying' ? 0.45 : 1,
							transition: 'opacity 0.3s',
						}}
					>
						<FacesRail
							faces={railFaces}
							hoveredId={hoveredId}
							onHover={setHoveredId}
							faceRefs={faceRefs}
						/>
					</div>
				)}
			</div>
			{transcriptOpen && (
				<TranscriptModal roomId={getRoomId()} onClose={() => setTranscriptOpen(false)} />
			)}
		</>
	)
}
