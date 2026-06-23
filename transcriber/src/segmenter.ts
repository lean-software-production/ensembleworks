/**
 * Energy-based utterance segmenter — the pure heart of the transcriber.
 *
 * PCM frames go in, complete utterances come out. An utterance opens when the
 * frame RMS crosses `openThreshold`, stays open while speech keeps the level
 * above `closeThreshold` (hysteresis so trailing consonants don't chop the
 * tail off), and closes after `hangoverMs` of silence. A preroll ring keeps
 * the syllable that *triggered* the detector from being lost.
 *
 * No livekit, no fs, no clock — time is counted in samples — so this is
 * directly testable with synthesized PCM (see segmenter.test.ts).
 */

export interface SegmenterOptions {
	sampleRate: number
	/** RMS (0..1 of full scale) that opens an utterance. */
	openThreshold?: number
	/** RMS that counts as "still speaking" once open (< openThreshold). */
	closeThreshold?: number
	/** Silence that closes an utterance. */
	hangoverMs?: number
	/** Voiced spans shorter than this are dropped (coughs, key clacks). */
	minUtteranceMs?: number
	/** Force-close at this length so STT requests stay bounded. */
	maxUtteranceMs?: number
	/** Audio retained from before the opening frame. */
	prerollMs?: number
}

export interface Utterance {
	pcm: Int16Array
	startMs: number
	endMs: number
}

export interface Segmenter {
	/** Feed one PCM frame; returns a finished utterance or null. */
	push(frame: Int16Array): Utterance | null
	/** Close any open utterance (track ended, participant left). */
	flush(): Utterance | null
}

export function createSegmenter(opts: SegmenterOptions): Segmenter {
	const sampleRate = opts.sampleRate
	const openThreshold = opts.openThreshold ?? 0.015
	const closeThreshold = opts.closeThreshold ?? 0.008
	const hangoverSamples = Math.round(((opts.hangoverMs ?? 700) / 1000) * sampleRate)
	const minSamples = Math.round(((opts.minUtteranceMs ?? 250) / 1000) * sampleRate)
	const maxSamples = Math.round(((opts.maxUtteranceMs ?? 30_000) / 1000) * sampleRate)
	const prerollSamples = Math.round(((opts.prerollMs ?? 300) / 1000) * sampleRate)

	let consumed = 0 // total samples ever pushed; the clock
	const preroll: Int16Array[] = []
	let prerollLen = 0
	let open: Int16Array[] | null = null
	let openLen = 0
	let openStart = 0 // sample index where the utterance (incl. preroll) starts
	let voiceStart = 0 // sample index of the frame that opened the utterance
	let lastVoice = 0 // sample index of the last frame above closeThreshold

	const msOf = (samples: number) => Math.round((samples / sampleRate) * 1000)

	const rms = (frame: Int16Array) => {
		if (!frame.length) return 0
		let sum = 0
		for (let i = 0; i < frame.length; i++) {
			const s = (frame[i] ?? 0) / 32768
			sum += s * s
		}
		return Math.sqrt(sum / frame.length)
	}

	const concat = (chunks: Int16Array[], len: number) => {
		const out = new Int16Array(len)
		let off = 0
		for (const c of chunks) {
			out.set(c, off)
			off += c.length
		}
		return out
	}

	const close = (): Utterance | null => {
		if (!open) return null
		// Minimum length is judged on the *voiced* span — preroll is silence
		// and must not let a key clack masquerade as speech.
		const utterance: Utterance | null =
			lastVoice - voiceStart >= minSamples
				? { pcm: concat(open, openLen), startMs: msOf(openStart), endMs: msOf(consumed) }
				: null
		open = null
		openLen = 0
		return utterance
	}

	return {
		push(frame) {
			const level = rms(frame)
			consumed += frame.length

			if (!open) {
				if (level >= openThreshold) {
					open = [...preroll, frame]
					openLen = prerollLen + frame.length
					openStart = consumed - openLen
					voiceStart = consumed - frame.length
					lastVoice = consumed
					preroll.length = 0
					prerollLen = 0
					return null
				}
				// Stay idle: maintain the preroll ring.
				preroll.push(frame)
				prerollLen += frame.length
				while (prerollLen - (preroll[0]?.length ?? 0) >= prerollSamples && preroll.length > 1) {
					prerollLen -= preroll.shift()!.length
				}
				return null
			}

			open.push(frame)
			openLen += frame.length
			if (level >= closeThreshold) lastVoice = consumed
			if (consumed - lastVoice >= hangoverSamples || openLen >= maxSamples) return close()
			return null
		},

		flush: close,
	}
}
