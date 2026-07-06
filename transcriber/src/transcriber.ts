/**
 * EnsembleWorks transcriber bot ("the scribe").
 *
 * Joins the room's LiveKit session with a subscribe-only token, splits each
 * teammate's audio track into utterances (energy VAD, see segmenter.ts),
 * transcribes them against a hosted OpenAI-compatible STT server (Groq's
 * Whisper API by default), and posts the text to the sync server's
 * /api/scribe/transcript — where each line gets stamped with the speaker's live
 * cursor position and nearest frame.
 *
 * Deliberately visible: it appears in the participant list as "📝 scribe" so
 * the room knows it is being transcribed. It hears every track at full
 * volume regardless of canvas distance — spatial audio is a client-side
 * gain, not an access control.
 *
 * Environment:
 *   ENSEMBLEWORKS_URL    sync server (default http://localhost:8788)
 *   ENSEMBLEWORKS_ROOM   room to scribe (default team)
 *   STT_URL       OpenAI-compatible STT server (default Groq, https://api.groq.com/openai/v1)
 *   STT_MODEL     model name (default whisper-large-v3-turbo)
 *   STT_LANGUAGE  optional language hint, e.g. en
 *   STT_API_KEY   bearer token for the hosted STT (e.g. a Groq gsk_... key)
 *   SCRIBE_IDENTITY / SCRIBE_NAME   participant identity/name overrides
 */
import {
	AudioStream,
	Room,
	RoomEvent,
	TrackKind,
	type RemoteParticipant,
	type RemoteTrack,
} from '@livekit/rtc-node'
import { readScribeEndpoint } from './config.ts'
import { resolveScribeConnectUrl } from './livekit-url.ts'
import { createSegmenter } from './segmenter.ts'
import { transcribeWav } from './stt.ts'
import { encodeWavPcm16 } from './wav.ts'

const { url: SYNC_URL, room: SYNC_ROOM } = readScribeEndpoint(process.env)
const STT_URL = process.env.STT_URL ?? 'https://api.groq.com/openai/v1'
const STT_MODEL = process.env.STT_MODEL ?? 'whisper-large-v3-turbo'
const STT_LANGUAGE = process.env.STT_LANGUAGE
const STT_API_KEY = process.env.STT_API_KEY
const SCRIBE_IDENTITY = process.env.SCRIBE_IDENTITY ?? 'scribe'
const SCRIBE_NAME = process.env.SCRIBE_NAME ?? '📝 scribe'

const SAMPLE_RATE = 16_000 // AudioStream resamples for us; whisper's native rate

const log = (...args: unknown[]) => console.log(`[scribe ${SYNC_ROOM}]`, ...args)

async function fetchToken(): Promise<{ url: string; token: string } | null> {
	const params = new URLSearchParams({
		room: SYNC_ROOM,
		identity: SCRIBE_IDENTITY,
		name: SCRIBE_NAME,
		role: 'scribe',
	})
	const res = await fetch(`${SYNC_URL}/api/av/token?${params}`)
	if (!res.ok) throw new Error(`token endpoint ${res.status}`)
	const info = (await res.json()) as { enabled: boolean; url?: string; token?: string }
	if (!info.enabled || !info.url || !info.token) return null
	// info.url is guaranteed defined by the guard above (returns null otherwise),
	// so the resolved url is always a string — the `!` reflects that upstream guard.
	const url = resolveScribeConnectUrl(info.url, process.env.LIVEKIT_URL)!
	return { url, token: info.token }
}

async function postTranscript(participant: RemoteParticipant, text: string) {
	const res = await fetch(`${SYNC_URL}/api/scribe/transcript`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			room: SYNC_ROOM,
			identity: participant.identity,
			name: participant.name || participant.identity,
			text,
		}),
	})
	if (!res.ok) throw new Error(`transcript endpoint ${res.status}`)
}

/**
 * Pump one participant's audio track: frames → segmenter → STT → transcript.
 * STT calls are chained per participant so a slow transcription can't reorder
 * one speaker's utterances; different speakers transcribe concurrently.
 */
function pumpTrack(track: RemoteTrack, participant: RemoteParticipant, signal: AbortSignal) {
	const who = participant.name || participant.identity
	const segmenter = createSegmenter({ sampleRate: SAMPLE_RATE })
	let sttChain = Promise.resolve()

	const handleUtterance = (pcm: Int16Array) => {
		const wav = encodeWavPcm16(pcm, SAMPLE_RATE)
		const audioSec = pcm.length / SAMPLE_RATE
		sttChain = sttChain.then(async () => {
			const started = Date.now()
			try {
				const text = await transcribeWav(wav, {
					url: STT_URL,
					model: STT_MODEL,
					language: STT_LANGUAGE,
					apiKey: STT_API_KEY,
				})
				const sttSec = (Date.now() - started) / 1000
				if (!text) return
				// [audio → stt] makes the CPU sidecar's real-time factor visible.
				log(`${who} [${audioSec.toFixed(1)}s → ${sttSec.toFixed(1)}s]: ${text}`)
				await postTranscript(participant, text)
			} catch (err) {
				log(`utterance from ${who} dropped:`, err)
			}
		})
	}

	void (async () => {
		log(`listening to ${who}`)
		const stream = new AudioStream(track, SAMPLE_RATE, 1)
		const reader = stream.getReader()
		signal.addEventListener('abort', () => reader.cancel().catch(() => {}))
		try {
			for (;;) {
				const { done, value: frame } = await reader.read()
				if (done || signal.aborted) break
				const utterance = segmenter.push(frame.data)
				if (utterance) handleUtterance(utterance.pcm)
			}
		} catch (err) {
			if (!signal.aborted) log(`audio stream from ${who} failed:`, err)
		}
		const tail = segmenter.flush()
		if (tail) handleUtterance(tail.pcm)
		log(`stopped listening to ${who}`)
	})()
}

async function main() {
	const info = await fetchToken()
	if (!info) {
		console.error('LiveKit is not configured on the sync server (token endpoint says disabled).')
		process.exit(1)
	}

	const room = new Room()
	// One abort controller per subscribed track, keyed by track sid.
	const pumps = new Map<string, AbortController>()

	room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
		if (track.kind !== TrackKind.KIND_AUDIO || !track.sid) return
		const ctl = new AbortController()
		pumps.set(track.sid, ctl)
		pumpTrack(track, participant, ctl.signal)
	})
	room.on(RoomEvent.TrackUnsubscribed, (track) => {
		if (!track.sid) return
		pumps.get(track.sid)?.abort()
		pumps.delete(track.sid)
	})
	room.on(RoomEvent.Disconnected, () => {
		log('disconnected from LiveKit; exiting (systemd restarts us)')
		process.exit(1)
	})

	await room.connect(info.url, info.token, { autoSubscribe: true, dynacast: false })
	log(`connected to ${info.url} as ${SCRIBE_NAME}; posting to ${SYNC_URL}`)

	const shutdown = async () => {
		for (const ctl of pumps.values()) ctl.abort()
		await room.disconnect()
		process.exit(0)
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
}

main().catch((err) => {
	console.error('scribe failed to start:', err)
	process.exit(1)
})
