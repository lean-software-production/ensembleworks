/**
 * Speech-to-text client for any OpenAI-compatible transcription server
 * (POST /v1/audio/transcriptions, multipart, returns { text }).
 *
 * The default deployment points STT_URL + STT_API_KEY at Groq's hosted Whisper
 * API (whisper-large-v3-turbo) — GPU-backed and comfortably real-time, so the
 * transcription load stays off the dev VM. Any OpenAI-compatible endpoint works
 * (api.openai.com, or a self-hosted faster-whisper server if you'd rather keep
 * audio on your own network).
 */

export interface SttOptions {
	/** OpenAI-compatible base url ending in /v1 (…/audio/transcriptions is appended) or a full endpoint. */
	url: string
	model: string
	language?: string
	apiKey?: string
}

export async function transcribeWav(wav: Uint8Array, opts: SttOptions): Promise<string> {
	const endpoint = opts.url.includes('/audio/transcriptions')
		? opts.url
		: `${opts.url.replace(/\/$/, '')}/audio/transcriptions`

	const form = new FormData()
	form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav')
	form.append('model', opts.model)
	if (opts.language) form.append('language', opts.language)

	const res = await fetch(endpoint, {
		method: 'POST',
		headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : undefined,
		body: form,
	})
	if (!res.ok) {
		throw new Error(`stt ${res.status}: ${(await res.text()).slice(0, 300)}`)
	}
	const body = (await res.json()) as { text?: string }
	return (body.text ?? '').trim()
}
