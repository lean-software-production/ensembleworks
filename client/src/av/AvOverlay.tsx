/**
 * Headless A/V coordinator, rendered in tldraw's SharePanel slot (still
 * mounted there so the LiveKit connection, spatial-audio loop and leashes
 * stay alive — see av/plugin.ts). It renders no panel UI of its own: the
 * side panel (chrome/SidePanel.tsx, an App-level flex sibling outside tldraw
 * context) owns the roster, tiles, recording row and transcript modal. This
 * component owns the LiveKit room, the spatial-audio loop, the leash overlay,
 * and publishes A/V state + actions through av/bridge.ts for the panel to
 * consume.
 */
import { rawUserId } from '@ensembleworks/contracts'
import { useEffect, useRef, useState } from 'react'
import { useEditor, useValue } from 'tldraw'
import { getRoomId } from '../identity'
import { avSnapshotsEqual, getFaceEl, publishAvSnapshot, useHoveredFace, type AvPanelSnapshot } from './bridge'
import { LeashOverlay, useLeashes } from './leashes'
import { useLiveKitRoom } from './useLiveKitRoom'
import { useSessionPulse } from './useSessionPulse'
import { useSpatialGainLoop } from './useSpatialGainLoop'

export function AvOverlay() {
	const editor = useEditor()
	const identity = useValue('userId', () => editor.user.getId(), [editor])
	const name = useValue('userName', () => editor.user.getName() ?? 'teammate', [editor])
	const lk = useLiveKitRoom(getRoomId(), identity, name)
	const pulse = useSessionPulse(getRoomId(), identity)
	const [standupMode, setStandupMode] = useState(true)
	const [kickError, setKickError] = useState<string | null>(null)
	const [kickingId, setKickingId] = useState<string | null>(null)

	// Subscribe-only LiveKit participants are bots, not teammates — currently
	// the transcriber scribe. They carry no tldraw presence, so they never land
	// in the panel's page-grouped roster; surface them separately so the room
	// can see at a glance that it is being recorded.
	const scribes = lk.peers.filter((peer) => peer.readOnly)
	// The {id, name} projection the bridge snapshot takes (mirrors the panel's
	// recording row).
	const scribeInfos = scribes.map((scribe) => ({ id: scribe.identity, name: scribe.name }))

	// Hovering a panel tile leashes it to its cursor on demand (speakers leash
	// unconditionally). Both the hovered id and the tile's live DOM element
	// come from the bridge now — the panel tiles (chrome/PanelTile.tsx) are
	// the ones registering/hovering; this component only reads them.
	const hoveredId = useHoveredFace()

	// Leashes from panel tiles to their teammate's live cursor — drawn only for
	// the active speaker or the tile you're hovering, and only when that
	// cursor is on the page you're viewing (useLeashes' own
	// getCollaboratorsOnCurrentPage() scoping — unchanged — enforces the
	// "only leash faces on my current page" rule; no page-scoped face list
	// needs deriving here). Recomputes on camera pans and cursor moves.
	const leashes = useLeashes(editor, lk.peers, hoveredId, getFaceEl)

	// Spatial audio loop.
	useSpatialGainLoop(editor, lk, standupMode)

	// Takes (id, name) rather than a full participant object: those are the
	// only two fields it uses, and it doubles as the bridge's `actions.kick` —
	// which only has a raw id + display name to offer (panel tiles aren't
	// SessionParticipants).
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
	// tldraw context — see av/bridge.ts) on every real change. Scribes are
	// LiveKit-only (no tldraw presence) so they're excluded from `peers`.
	//
	// No dep array: useLiveKitRoom re-maps `peers` on every render, so deps
	// would never compare equal anyway. Instead the effect runs each render
	// and bails via content comparison against the last published snapshot
	// (actions excluded — see avSnapshotsEqual) so useAvSnapshot() consumers
	// only re-render when A/V state actually changed.
	const lastPublishedRef = useRef<AvPanelSnapshot | null>(null)
	useEffect(() => {
		const snap: AvPanelSnapshot = {
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
			scribes: scribeInfos,
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
		}
		if (lastPublishedRef.current && avSnapshotsEqual(lastPublishedRef.current, snap)) return
		lastPublishedRef.current = snap
		publishAvSnapshot(snap)
	})

	// Cleanup lives in its own mount-only effect so intermediate re-renders
	// (the effect above fires often) don't flash the panel back to null
	// between an old snapshot and the next one.
	useEffect(() => {
		return () => publishAvSnapshot(null)
	}, [])

	return <LeashOverlay leashes={leashes} />
}
