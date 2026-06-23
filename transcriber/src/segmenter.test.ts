// Tests for the energy-based utterance segmenter, with synthesized PCM.
// Run with: npx tsx src/segmenter.test.ts
import assert from 'node:assert/strict'
import { createSegmenter, type Utterance } from './segmenter.ts'

const RATE = 16_000
const FRAME = 160 // 10 ms, the granularity LiveKit delivers

function* frames(samples: Int16Array) {
	for (let off = 0; off < samples.length; off += FRAME) {
		yield samples.subarray(off, Math.min(off + FRAME, samples.length))
	}
}

function silence(ms: number): Int16Array {
	return new Int16Array(Math.round((ms / 1000) * RATE)) // zeros
}

function tone(ms: number, amplitude = 8000): Int16Array {
	const out = new Int16Array(Math.round((ms / 1000) * RATE))
	for (let i = 0; i < out.length; i++) {
		out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE))
	}
	return out
}

function concat(...parts: Int16Array[]): Int16Array {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
	let off = 0
	for (const p of parts) {
		out.set(p, off)
		off += p.length
	}
	return out
}

function run(samples: Int16Array): Utterance[] {
	const seg = createSegmenter({ sampleRate: RATE })
	const out: Utterance[] = []
	for (const f of frames(samples)) {
		const u = seg.push(f)
		if (u) out.push(u)
	}
	const tail = seg.flush()
	if (tail) out.push(tail)
	return out
}

// 1. One spoken second between silences → exactly one utterance, roughly
// covering the tone (preroll may pull the start a little earlier).
{
	const utterances = run(concat(silence(500), tone(1000), silence(1500)))
	assert.equal(utterances.length, 1, `expected one utterance, got ${utterances.length}`)
	const u = utterances[0]!
	assert.ok(u.startMs >= 100 && u.startMs <= 500, `start near the tone, got ${u.startMs}`)
	assert.ok(u.endMs >= 1500, `end after the tone (hangover included), got ${u.endMs}`)
	assert.ok(u.endMs <= 2600, `closes well before the input ends, got ${u.endMs}`)
	// The pcm carries the whole tone: at least 1s of samples.
	assert.ok(u.pcm.length >= RATE, 'utterance pcm contains the spoken second')
	console.log('ok: single utterance detected between silences')
}

// 2. A 100 ms blip (door slam, key clack) is below minUtteranceMs → dropped.
{
	const utterances = run(concat(silence(500), tone(100), silence(1500)))
	assert.equal(utterances.length, 0, 'sub-minimum blip should be discarded')
	console.log('ok: short blip discarded')
}

// 3. Pure silence → nothing.
{
	assert.equal(run(silence(3000)).length, 0, 'silence should produce no utterances')
	console.log('ok: silence produces nothing')
}

// 4. Two utterances separated by a long pause come out separately.
{
	const utterances = run(
		concat(silence(300), tone(800), silence(1200), tone(800), silence(1200))
	)
	assert.equal(utterances.length, 2, `expected two utterances, got ${utterances.length}`)
	assert.ok(utterances[1]!.startMs > utterances[0]!.endMs, 'utterances do not overlap')
	console.log('ok: long pause splits utterances')
}

// 5. A brief mid-sentence pause (shorter than the hangover) does NOT split.
{
	const utterances = run(concat(silence(300), tone(600), silence(400), tone(600), silence(1200)))
	assert.equal(utterances.length, 1, 'a 400ms breath should not split the sentence')
	console.log('ok: mid-sentence pause survives the hangover')
}

// 6. Speech longer than maxUtteranceMs is force-closed into bounded chunks.
{
	const seg = createSegmenter({ sampleRate: RATE, maxUtteranceMs: 2000 })
	const out: Utterance[] = []
	for (const f of frames(tone(5000))) {
		const u = seg.push(f)
		if (u) out.push(u)
	}
	const tail = seg.flush()
	if (tail) out.push(tail)
	assert.ok(out.length >= 2, `monologue should split, got ${out.length}`)
	for (const u of out) {
		assert.ok(u.pcm.length <= 2 * RATE + FRAME, 'every chunk stays within maxUtteranceMs')
	}
	console.log('ok: monologue force-split at maxUtteranceMs')
}

// 7. flush() emits the open utterance when the track ends mid-speech.
{
	const seg = createSegmenter({ sampleRate: RATE })
	for (const f of frames(concat(silence(300), tone(800)))) seg.push(f)
	const tail = seg.flush()
	assert.ok(tail, 'flush should emit the in-flight utterance')
	assert.ok(tail.pcm.length >= 0.8 * RATE, 'flushed utterance carries the speech')
	console.log('ok: flush emits the in-flight utterance')
}

console.log('segmenter.test.ts: all tests passed')
