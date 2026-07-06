/**
 * LiveKit room lifecycle + the per-participant WebAudio pipeline.
 *
 * Remote audio is deliberately NOT played via track.attach(): each track is
 * routed MediaStream → MediaStreamAudioSourceNode → GainNode → destination,
 * and the gain is driven from canvas distance by the spatial loop in
 * AvOverlay. (A muted <audio> element is still attached to each stream —
 * Chrome won't pump WebRTC audio into WebAudio without one.)
 */
import {
	LocalParticipant,
	LocalTrack,
	LocalTrackPublication,
	RemoteParticipant,
	RemoteTrack,
	Room,
	RoomEvent,
	Track,
} from 'livekit-client'
import { useEffect, useRef, useState } from 'react'
import { setScreenShareRoom } from '../screenshare/store'

export interface RemotePeer {
	identity: string
	name: string
	participant: RemoteParticipant
	videoTrack: RemoteTrack | null
	gain: GainNode | null
	// True while LiveKit reports this participant as an active speaker. Drives
	// the faces-rail "speaker pop" (enlarge + leash to their cursor).
	isSpeaking: boolean
	// Subscribe-only participants (canPublish === false) are bots, not people —
	// today that's the transcriber "scribe". They publish no track, so they get
	// no face bubble; the roster lists them separately as "recording".
	readOnly: boolean
}

interface AudioPipeline {
	gain: GainNode
	source: MediaStreamAudioSourceNode
	keepAlive: HTMLAudioElement
}

export interface LiveKitState {
	status: 'disabled' | 'connecting' | 'connected' | 'error'
	room: Room | null
	peers: RemotePeer[]
	localParticipant: LocalParticipant | null
	micEnabled: boolean
	camEnabled: boolean
	setMicEnabled: (on: boolean) => void
	setCamEnabled: (on: boolean) => void
	audioContext: AudioContext | null
	// Your own published camera track, so the UI can show you a self-bubble
	// the same way it shows remote teammates (null while the camera is off).
	localVideoTrack: LocalTrack | null
	// True while LiveKit reports *you* as an active speaker, so your own rail
	// face can pop the same way a teammate's does.
	localSpeaking: boolean
}

export function useLiveKitRoom(roomId: string, identity: string, name: string): LiveKitState {
	const [status, setStatus] = useState<LiveKitState['status']>('connecting')
	const [room, setRoom] = useState<Room | null>(null)
	const [peers, setPeers] = useState<RemotePeer[]>([])
	const [micEnabled, setMicState] = useState(false)
	const [camEnabled, setCamState] = useState(false)
	const [localVideoTrack, setLocalVideoTrack] = useState<LocalTrack | null>(null)
	// Identities LiveKit currently reports as speaking (includes the local
	// participant when you talk). Kept separate from `peers` so a speaker change
	// doesn't churn the video tracks.
	const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set())
	const audioCtxRef = useRef<AudioContext | null>(null)
	const pipelinesRef = useRef(new Map<string, AudioPipeline>())

	useEffect(() => {
		let cancelled = false
		let lkRoom: Room | null = null

		const rebuildPeers = (r: Room) => {
			const next: RemotePeer[] = []
			r.remoteParticipants.forEach((p) => {
				const videoPub = p.getTrackPublication(Track.Source.Camera)
				// A muted camera stays published, so guard on isMuted too —
				// otherwise we'd paint a frozen/black bubble for someone who
				// turned their camera off without leaving.
				const videoTrack = videoPub && !videoPub.isMuted ? (videoPub.track ?? null) : null
				next.push({
					identity: p.identity,
					name: p.name || p.identity,
					participant: p,
					videoTrack,
					gain: pipelinesRef.current.get(p.identity)?.gain ?? null,
					// Overlaid from `speakingIds` at return time, not here —
					// rebuildPeers only runs on track/membership changes.
					isSpeaking: false,
					readOnly: p.permissions?.canPublish === false,
				})
			})
			setPeers(next)
		}

		const attachAudio = (track: RemoteTrack, participant: RemoteParticipant) => {
			const ctx = (audioCtxRef.current ??= new AudioContext())
			const stream = new MediaStream([track.mediaStreamTrack])
			// Chrome workaround: WebRTC audio only flows into WebAudio while
			// some media element is consuming the stream.
			const keepAlive = new Audio()
			keepAlive.srcObject = stream
			keepAlive.muted = true
			keepAlive.play().catch(() => {})
			const source = ctx.createMediaStreamSource(stream)
			const gain = ctx.createGain()
			gain.gain.value = 1
			source.connect(gain).connect(ctx.destination)
			pipelinesRef.current.get(participant.identity)?.source.disconnect()
			pipelinesRef.current.set(participant.identity, { gain, source, keepAlive })
		}

		const detachAudio = (identity: string) => {
			const pipe = pipelinesRef.current.get(identity)
			if (pipe) {
				pipe.source.disconnect()
				pipe.gain.disconnect()
				pipe.keepAlive.srcObject = null
				pipelinesRef.current.delete(identity)
			}
		}

		async function connect() {
			const params = new URLSearchParams({ room: roomId, identity, name })
			const res = await fetch(`/api/av/token?${params}`)
			const info = await res.json()
			if (cancelled) return
			if (!info.enabled) {
				setStatus('disabled')
				return
			}
			// adaptiveStream: delivered video layer follows the attached element's
			// on-screen size, and fully hidden elements pause server-side (tldraw
			// culls off-viewport shapes from the DOM, so panning away pauses the
			// stream). dynacast: layers nobody subscribes to stop being ENCODED at
			// the publisher. Both were unset pre-screen-share; camera bubbles in
			// the faces rail benefit too. Audio is unaffected (video-only features).
			const r = new Room({ adaptiveStream: true, dynacast: true })
			lkRoom = r
			r.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
				if (track.kind === Track.Kind.Audio) attachAudio(track, participant)
				rebuildPeers(r)
			})
			r.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
				if (track.kind === Track.Kind.Audio) detachAudio(participant.identity)
				rebuildPeers(r)
			})
			r.on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
				if (pub.source === Track.Source.Camera) setLocalVideoTrack(pub.track ?? null)
			})
			r.on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
				if (pub.source === Track.Source.Camera) setLocalVideoTrack(null)
			})
			r.on(RoomEvent.TrackMuted, () => rebuildPeers(r))
			r.on(RoomEvent.TrackUnmuted, () => rebuildPeers(r))
			r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
				setSpeakingIds(new Set(speakers.map((p) => p.identity)))
			})
			r.on(RoomEvent.ParticipantConnected, () => rebuildPeers(r))
			// canPublish lands with the join info but can also change later;
			// rebuild so a subscribe-only scribe is flagged readOnly either way.
			r.on(RoomEvent.ParticipantPermissionsChanged, () => rebuildPeers(r))
			r.on(RoomEvent.ParticipantDisconnected, (p) => {
				detachAudio(p.identity)
				rebuildPeers(r)
			})
			r.on(RoomEvent.Disconnected, () => setStatus('error'))
			try {
				await r.connect(info.url, info.token)
			} catch (err) {
				console.error('LiveKit connect failed', err)
				if (!cancelled) setStatus('error')
				return
			}
			if (cancelled) {
				r.disconnect()
				return
			}
			setRoom(r)
			setStatus('connected')
			rebuildPeers(r)
			setScreenShareRoom(r)
		}

		connect()

		// Browsers keep AudioContexts suspended until a user gesture.
		const resume = () => audioCtxRef.current?.resume()
		document.addEventListener('pointerdown', resume)

		return () => {
			cancelled = true
			document.removeEventListener('pointerdown', resume)
			for (const id of [...pipelinesRef.current.keys()]) detachAudio(id)
			setScreenShareRoom(null)
			lkRoom?.disconnect()
			audioCtxRef.current?.close()
			audioCtxRef.current = null
		}
	}, [roomId, identity, name])

	const setMicEnabled = (on: boolean) => {
		room?.localParticipant.setMicrophoneEnabled(on).catch(console.error)
		audioCtxRef.current?.resume()
		setMicState(on)
	}
	const setCamEnabled = (on: boolean) => {
		room?.localParticipant.setCameraEnabled(on).catch(console.error)
		setCamState(on)
	}

	const localIdentity = room?.localParticipant.identity
	return {
		status,
		room,
		peers: peers.map((p) => ({ ...p, isSpeaking: speakingIds.has(p.identity) })),
		localParticipant: room?.localParticipant ?? null,
		micEnabled,
		camEnabled,
		setMicEnabled,
		setCamEnabled,
		audioContext: audioCtxRef.current,
		localVideoTrack,
		localSpeaking: localIdentity ? speakingIds.has(localIdentity) : false,
	}
}
