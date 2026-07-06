/**
 * Live e2e gate for the transcriber cutover (Phase 3, sub-project #6).
 *
 * Proves the charter's hard acceptance test (user decision 6): the COMPILED
 * binary dist/ensembleworks-transcriber completes a real room.connect() →
 * subscribe → segment → STT → POST /api/scribe/transcript against a live
 * LiveKit SFU, with NO Node fallback. Spike C proved import + compiled launch +
 * embedded addon; this harness is the first to drive room.connect() FROM the
 * binary, and the first to drive rtc-node's PUBLISH path under Bun.
 *
 * NOT a *.test.ts — scripts/run-tests.ts (glob **\/src\/**\/*.test.ts) never
 * discovers it, so `bun run test` stays offline and flake-free.
 *
 * Modes:
 *   bun src/e2e-gate.ts           default: SKIP loud + exit 0 if a prerequisite
 *                                 (sync / SFU / STT) is missing; run the pipeline
 *                                 when preflight passes.
 *   bun src/e2e-gate.ts --strict  a missing prerequisite is a FAILURE (exit 1),
 *                                 so an acceptance run cannot pass by skipping.
 *
 * Manual acceptance (see the plan / spec):
 *   bin/dev up
 *   bun --cwd transcriber run build:binary
 *   bun transcriber/src/e2e-gate.ts --strict
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	AudioFrame,
	AudioSource,
	LocalAudioTrack,
	Room,
	TrackKind,
	TrackPublishOptions,
	TrackSource,
} from '@livekit/rtc-node'
import { resolveScribeConnectUrl } from './livekit-url.ts'

// ---- constants ----------------------------------------------------------
const GATE_ROOM = 'gate-e2e' // throwaway; never `team`, so the dev scribe can't collide
const SPEAKER_IDENTITY = 'gate-speaker'
const CHECKER_IDENTITY = 'gate-checker'
const SCRIBE_UNDER_TEST_IDENTITY = 'scribe-gate'
const SAMPLE_RATE = 16_000
const CHANNELS = 1
const FRAME_MS = 20 // 20 ms publish frames (320 samples @ 16 kHz)
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000
const GAP_MS = 500 // silence between fixture loops so the VAD sees discrete utterances
const PUBLISH_VISIBLE_TIMEOUT_MS = 20_000
const TRANSCRIPT_TIMEOUT_MS = 90_000
const POLL_MS = 2_000

const here = path.dirname(fileURLToPath(import.meta.url))
const transcriberRoot = path.join(here, '..')
const binaryPath = path.join(transcriberRoot, 'dist', 'ensembleworks-transcriber')
const fixturePath = path.join(here, 'fixtures', 'gate-speech.wav')

const strict = process.argv.includes('--strict')
const SYNC_URL = process.env.ENSEMBLEWORKS_URL ?? 'http://localhost:8788'

// ---- tiny helpers -------------------------------------------------------
const now = () => Date.now()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const log = (...a: unknown[]) => console.log('[gate]', ...a)

interface TranscriptEntry {
	identity: string
	name: string
	text: string
	t: number
}

/** Decode a mono 16-bit PCM WAV into its Int16 samples (skips non-`data` chunks). */
function readWavPcm16(file: string): { samples: Int16Array; sampleRate: number; channels: number } {
	const buf = readFileSync(file)
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	const tag = (off: number) =>
		String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3))
	if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error(`${file}: not a RIFF/WAVE file`)
	let channels = 0
	let sampleRate = 0
	let bitsPerSample = 0
	let dataOff = -1
	let dataLen = 0
	let off = 12
	while (off + 8 <= view.byteLength) {
		const id = tag(off)
		const size = view.getUint32(off + 4, true)
		const body = off + 8
		if (id === 'fmt ') {
			channels = view.getUint16(body + 2, true)
			sampleRate = view.getUint32(body + 4, true)
			bitsPerSample = view.getUint16(body + 14, true)
		} else if (id === 'data') {
			dataOff = body
			dataLen = size
		}
		off = body + size + (size % 2) // chunks are word-aligned
	}
	if (dataOff < 0) throw new Error(`${file}: no data chunk`)
	if (bitsPerSample !== 16) throw new Error(`${file}: expected 16-bit PCM, got ${bitsPerSample}`)
	const count = Math.floor(dataLen / 2)
	const samples = new Int16Array(count)
	for (let i = 0; i < count; i++) samples[i] = view.getInt16(dataOff + i * 2, true)
	return { samples, sampleRate, channels }
}

/** Fetch a role token from the sync server for GATE_ROOM. */
async function fetchToken(identity: string, role: 'member' | 'scribe'): Promise<{ url: string; token: string }> {
	const params = new URLSearchParams({ room: GATE_ROOM, identity, name: identity, role })
	const res = await fetch(`${SYNC_URL}/api/av/token?${params}`)
	if (!res.ok) throw new Error(`token endpoint ${res.status}`)
	const info = (await res.json()) as { enabled?: boolean; url?: string; token?: string }
	if (!info.enabled || !info.url || !info.token) throw new Error('LiveKit not enabled on the sync server')
	const url = resolveScribeConnectUrl(info.url, process.env.LIVEKIT_URL)
	if (!url) throw new Error('could not resolve an SFU URL')
	return { url, token: info.token }
}

// ---- preflight ----------------------------------------------------------
interface Preflight {
	missing: string[]
	sfuUrl: string | null
}

async function preflight(): Promise<Preflight> {
	const missing: string[] = []
	let sfuUrl: string | null = null

	// 1. Sync server health.
	try {
		const res = await fetch(`${SYNC_URL}/api/health`)
		if (!res.ok) missing.push(`sync server /api/health returned ${res.status}`)
	} catch (err) {
		missing.push(`sync server unreachable at ${SYNC_URL} (${(err as Error).message})`)
	}

	// 2. LiveKit configured — a scribe-role token that carries an SFU url.
	try {
		const params = new URLSearchParams({ room: GATE_ROOM, identity: 'gate-preflight', role: 'scribe' })
		const res = await fetch(`${SYNC_URL}/api/av/token?${params}`)
		const info = (await res.json()) as { enabled?: boolean; url?: string; token?: string }
		if (!res.ok || !info.enabled || !info.url || !info.token) {
			missing.push('LiveKit is not configured on the sync server (token endpoint disabled)')
		} else {
			sfuUrl = resolveScribeConnectUrl(info.url, process.env.LIVEKIT_URL) ?? null
			if (!sfuUrl) missing.push('could not resolve an SFU URL from the token endpoint / LIVEKIT_URL')
		}
	} catch (err) {
		missing.push(`token endpoint failed (${(err as Error).message})`)
	}

	// 3. STT backend (the dev stack sets STT_URL=http://localhost:8091/v1).
	if (!process.env.STT_URL && !process.env.STT_API_KEY) {
		missing.push('neither STT_URL nor STT_API_KEY is set — the scribe has no STT backend')
	}

	return { missing, sfuUrl }
}

// ---- synthetic speaker (publish under Bun — first exercised here) --------
/** Connect the synthetic speaker and loop the fixture until `signal` aborts. */
async function startSpeaker(sfuUrl: string, signal: AbortSignal): Promise<Room> {
	const { token } = await fetchToken(SPEAKER_IDENTITY, 'member')
	const room = new Room()
	await room.connect(sfuUrl, token, { autoSubscribe: false, dynacast: false })

	const source = new AudioSource(SAMPLE_RATE, CHANNELS)
	const track = LocalAudioTrack.createAudioTrack('gate-speech', source)
	// publishTrack takes a REQUIRED TrackPublishOptions second arg.
	await room.localParticipant!.publishTrack(
		track,
		new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
	)

	const { samples, sampleRate, channels } = readWavPcm16(fixturePath)
	if (sampleRate !== SAMPLE_RATE || channels !== CHANNELS) {
		throw new Error(`fixture must be ${SAMPLE_RATE} Hz mono; got ${sampleRate} Hz / ${channels}ch`)
	}
	const silence = new Int16Array((SAMPLE_RATE * GAP_MS) / 1000)

	// Background pump: feed 20 ms frames, AWAITING captureFrame — its resolved
	// promise is the backpressure that keeps the loop real-time. An un-awaited
	// tight loop overruns the source's queue and mispaces the WAV, so the audio
	// arrives as a garbled burst and the VAD never sees clean utterances.
	void (async () => {
		try {
			while (!signal.aborted) {
				for (let i = 0; i < samples.length && !signal.aborted; i += FRAME_SAMPLES) {
					const chunk = samples.subarray(i, Math.min(i + FRAME_SAMPLES, samples.length))
					await source.captureFrame(new AudioFrame(chunk, SAMPLE_RATE, CHANNELS, chunk.length))
				}
				for (let i = 0; i < silence.length && !signal.aborted; i += FRAME_SAMPLES) {
					const chunk = silence.subarray(i, Math.min(i + FRAME_SAMPLES, silence.length))
					await source.captureFrame(new AudioFrame(chunk, SAMPLE_RATE, CHANNELS, chunk.length))
				}
			}
		} catch (err) {
			if (!signal.aborted) log('speaker pump error:', err)
		}
	})()

	return room
}

// ---- harness self-check: publish visible BEFORE the scribe launches ------
/** Confirm the speaker's audio publication is visible to a subscribe-only peer. */
async function confirmPublishVisible(sfuUrl: string): Promise<void> {
	const { token } = await fetchToken(CHECKER_IDENTITY, 'scribe')
	const checker = new Room()
	await checker.connect(sfuUrl, token, { autoSubscribe: false, dynacast: false })
	try {
		const deadline = now() + PUBLISH_VISIBLE_TIMEOUT_MS
		const seen = () =>
			[...checker.remoteParticipants.values()].some(
				(p) =>
					p.identity === SPEAKER_IDENTITY &&
					[...p.trackPublications.values()].some((pub) => pub.kind === TrackKind.KIND_AUDIO),
			)
		while (now() < deadline) {
			if (seen()) return
			await sleep(250)
		}
		throw new Error(
			`harness-side: ${SPEAKER_IDENTITY}'s audio track never became visible within ` +
				`${PUBLISH_VISIBLE_TIMEOUT_MS / 1000}s — publish path under Bun, NOT the scribe under test`,
		)
	} finally {
		await checker.disconnect()
	}
}

// ---- scribe under test = the COMPILED binary ----------------------------
function launchScribe(): ChildProcess {
	if (!existsSync(binaryPath)) {
		log(`compiled binary missing at ${binaryPath} — building it (bun run build:binary)`)
		const built = spawnSync(
			'bun',
			['build', '--compile', '--sourcemap', 'src/transcriber.ts', '--outfile', 'dist/ensembleworks-transcriber'],
			{ cwd: transcriberRoot, stdio: 'inherit' },
		)
		if (built.status !== 0) throw new Error('build:binary failed')
	}
	const child = spawn(binaryPath, [], {
		env: {
			...process.env,
			ENSEMBLEWORKS_URL: SYNC_URL,
			ENSEMBLEWORKS_ROOM: GATE_ROOM,
			SCRIBE_IDENTITY: SCRIBE_UNDER_TEST_IDENTITY,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	child.stdout?.on('data', (b: Buffer) => process.stdout.write(`[scribe-under-test] ${b}`))
	child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[scribe-under-test] ${b}`))
	return child
}

// ---- assert: a transcript line from the speaker lands --------------------
async function waitForTranscript(sinceMs: number): Promise<TranscriptEntry> {
	const deadline = now() + TRANSCRIPT_TIMEOUT_MS
	while (now() < deadline) {
		const params = new URLSearchParams({ room: GATE_ROOM, since: String(sinceMs) })
		const res = await fetch(`${SYNC_URL}/api/scribe/transcript?${params}`)
		if (res.ok) {
			const body = (await res.json()) as { entries?: TranscriptEntry[] }
			const hit = (body.entries ?? []).find((e) => e.identity === SPEAKER_IDENTITY && e.text.trim() !== '')
			if (hit) return hit
		}
		await sleep(POLL_MS)
	}
	throw new Error(
		`no transcript line from ${SPEAKER_IDENTITY} within ${TRANSCRIPT_TIMEOUT_MS / 1000}s — ` +
			`the compiled scribe did not complete connect→subscribe→segment→STT→POST`,
	)
}

// ---- main ---------------------------------------------------------------
async function main(): Promise<number> {
	const t0 = now()
	log(`mode: ${strict ? 'STRICT (missing prereq ⇒ FAIL)' : 'default (missing prereq ⇒ SKIP + exit 0)'}`)
	log(`sync ${SYNC_URL}; room ${GATE_ROOM}; binary ${binaryPath}`)

	const pf = await preflight()
	if (pf.missing.length > 0 || !pf.sfuUrl) {
		const lines = pf.missing.length ? pf.missing : ['SFU URL unresolved']
		if (strict) {
			console.error('\n================ GATE FAIL (--strict) ================')
			console.error('Prerequisites missing — a strict acceptance run must not skip:')
			for (const m of lines) console.error(`  - ${m}`)
			console.error('Bring the dev stack up first:  bin/dev up')
			console.error('======================================================\n')
			return 1
		}
		console.log('\n================ GATE SKIP (no --strict) ================')
		console.log('Prerequisites absent — skipping the live gate (expected off the dev stack):')
		for (const m of lines) console.log(`  - ${m}`)
		console.log('To actually run the gate:  bin/dev up  &&  bun --cwd transcriber run build:binary')
		console.log('  then:  bun transcriber/src/e2e-gate.ts --strict')
		console.log('=========================================================\n')
		return 0
	}
	const sfuUrl = pf.sfuUrl
	const tPreflight = now()
	log(`preflight OK (${tPreflight - t0} ms); SFU ${sfuUrl}`)

	const abort = new AbortController()
	let speaker: Room | null = null
	let scribe: ChildProcess | null = null
	let code = 1
	try {
		// 1. Synthetic speaker publishes the looped fixture.
		speaker = await startSpeaker(sfuUrl, abort.signal)
		log(`speaker connected + publishing '${path.basename(fixturePath)}' (looped)`)

		// 1b. Harness self-check — publish visible BEFORE the scribe launches.
		await confirmPublishVisible(sfuUrl)
		const tVisible = now()
		log(`self-check OK: ${SPEAKER_IDENTITY}'s track is visible (${tVisible - tPreflight} ms)`)

		// 2. Scribe under test = the COMPILED binary.
		const sinceMs = now()
		scribe = launchScribe()
		log(`scribe-under-test launched (pid ${scribe.pid}); polling transcript for room ${GATE_ROOM}`)

		// 3. Assert a transcript line lands.
		const hit = await waitForTranscript(sinceMs)
		const tHit = now()

		console.log('\n================ GATE PASS ================')
		console.log(`transcript from ${SPEAKER_IDENTITY}: ${JSON.stringify(hit.text)}`)
		console.log('timings (ms):')
		console.log(`  preflight            ${tPreflight - t0}`)
		console.log(`  publish-visible      ${tVisible - tPreflight}`)
		console.log(`  connect→…→POST       ${tHit - sinceMs}`)
		console.log(`  total                ${tHit - t0}`)
		console.log('every hop proven: connect (binary joined the SFU), subscribe, segment')
		console.log('(VAD), STT (non-empty), POST /api/scribe/transcript.')
		console.log('==========================================\n')
		code = 0
	} catch (err) {
		console.error('\n================ GATE FAIL ================')
		console.error((err as Error).message)
		console.error('==========================================\n')
		code = 1
	} finally {
		abort.abort()
		if (scribe) scribe.kill('SIGTERM')
		if (speaker) await speaker.disconnect().catch(() => {})
	}
	return code
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error('gate harness crashed:', err)
		process.exit(1)
	},
)
