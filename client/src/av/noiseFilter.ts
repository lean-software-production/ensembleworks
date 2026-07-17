/**
 * SPIKE — RNNoise noise suppression as a LiveKit audio track processor.
 *
 * Why this shape: on a self-hosted LiveKit SFU we can't use LiveKit's Krisp
 * filter (its licence is the LiveKit Cloud ToS, tied to Cloud media
 * transport), and we're CPU/RAM constrained on the box that runs the SFU. A
 * *track processor* sidesteps both problems: RNNoise (Xiph.Org, BSD-3-Clause,
 * shipped here via the MIT `@sapphi-red/web-noise-suppressor` WASM worklet)
 * runs entirely in the publisher's browser on the local mic capture, BEFORE
 * the audio is encoded and sent. The server just relays already-cleaned Opus —
 * zero extra work on the SFU.
 *
 * Audio chain (all client-side):
 *   mic track → MediaStreamSource → RnnoiseWorklet → MediaStreamDestination
 *             → processedTrack → LiveKit publishes this instead of the raw mic
 *
 * RNNoise assumes a 48 kHz sample rate, so the processor runs its own
 * AudioContext pinned to 48 kHz rather than reusing LiveKit's (whose rate is
 * device-dependent). It is wired in behind the `noiseFilter` user setting —
 * see chrome/settings.ts and the sync in useLiveKitRoom.ts.
 */
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import { Track } from 'livekit-client'
import type { AudioProcessorOptions, Room, TrackProcessor } from 'livekit-client'

// We deliberately ship only the non-SIMD RNNoise binary and pass it for BOTH
// the `url` and `simdUrl` slots. Reason: this client already runs
// `vite-plugin-wasm` (for loro-crdt), which collapses every `*.wasm?url` import
// to a single emitted asset — importing the `_simd` variant too just resolves
// back to this same file, so a separate import would be misleading dead weight.
// The non-SIMD binary is a valid module on every browser; it only forgoes the
// SIMD speedup, and RNNoise is ~1% CPU either way. Wiring up the SIMD variant
// (excluding it from vite-plugin-wasm so both assets emit) is a possible
// follow-up if a client ever proves CPU-bound on it.
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null
function getRnnoiseWasm(): Promise<ArrayBuffer> {
	wasmBinaryPromise ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseWasmUrl })
	return wasmBinaryPromise
}

/**
 * A LiveKit audio TrackProcessor that cleans the local mic with RNNoise. One
 * instance is single-use per published mic track: LiveKit calls init() when it
 * attaches and destroy() when the processor is removed or the track stops.
 */
class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
	name = 'rnnoise-noise-filter'
	processedTrack?: MediaStreamTrack

	// Its own 48 kHz context (RNNoise's assumed rate), independent of LiveKit's.
	private ctx: AudioContext | null = null
	private source: MediaStreamAudioSourceNode | null = null
	private rnnoise: RnnoiseWorkletNode | null = null
	private destination: MediaStreamAudioDestinationNode | null = null

	async init(opts: AudioProcessorOptions): Promise<void> {
		const wasmBinary = await getRnnoiseWasm()
		const ctx = new AudioContext({ sampleRate: 48000 })
		await ctx.audioWorklet.addModule(rnnoiseWorkletUrl)

		const source = ctx.createMediaStreamSource(new MediaStream([opts.track]))
		// Mic capture is mono; one channel keeps the worklet's work minimal.
		const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary })
		const destination = ctx.createMediaStreamDestination()
		source.connect(rnnoise).connect(destination)

		this.ctx = ctx
		this.source = source
		this.rnnoise = rnnoise
		this.destination = destination
		this.processedTrack = destination.stream.getAudioTracks()[0]
	}

	// LiveKit calls restart() when the underlying capture changes (e.g. the user
	// picks a different mic) — tear the graph down and rebuild it on the new track.
	async restart(opts: AudioProcessorOptions): Promise<void> {
		await this.destroy()
		await this.init(opts)
	}

	async destroy(): Promise<void> {
		this.source?.disconnect()
		this.rnnoise?.disconnect()
		this.rnnoise?.destroy()
		this.destination?.disconnect()
		this.processedTrack?.stop()
		await this.ctx?.close().catch(() => {})
		this.ctx = null
		this.source = null
		this.rnnoise = null
		this.destination = null
		this.processedTrack = undefined
	}
}

/** Fresh processor per published mic track (they are single-use). */
export function createRnnoiseProcessor(): RnnoiseProcessor {
	return new RnnoiseProcessor()
}

/**
 * Reconcile the RNNoise processor on the room's local mic track to `enabled`.
 * Idempotent and no-op when there is no live mic track yet — call it whenever
 * the mic publishes or the setting toggles. Errors are swallowed to a console
 * warning: a failed filter must never take the mic itself down.
 */
export async function syncMicNoiseFilter(room: Room, enabled: boolean): Promise<void> {
	const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack
	if (!track) return
	const active = track.getProcessor()?.name === 'rnnoise-noise-filter'
	try {
		if (enabled && !active) await track.setProcessor(createRnnoiseProcessor())
		else if (!enabled && active) await track.stopProcessor()
	} catch (err) {
		console.warn('[av] noise filter sync failed', err)
	}
}
