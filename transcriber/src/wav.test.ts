// Tests for the WAV encoder: header fields + payload round-trip.
// Run with: npx tsx src/wav.test.ts
import assert from 'node:assert/strict'
import { encodeWavPcm16 } from './wav.ts'

const samples = new Int16Array([0, 1000, -1000, 32767, -32768, 42])
const wav = encodeWavPcm16(samples, 16_000)
const view = new DataView(wav.buffer)

assert.equal(wav.length, 44 + samples.length * 2, '44-byte header + 2 bytes per sample')
assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF')
assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE')
assert.equal(view.getUint16(20, true), 1, 'PCM format')
assert.equal(view.getUint16(22, true), 1, 'mono')
assert.equal(view.getUint32(24, true), 16_000, 'sample rate')
assert.equal(view.getUint32(28, true), 32_000, 'byte rate = rate * 2')
assert.equal(view.getUint16(34, true), 16, '16 bits per sample')
assert.equal(view.getUint32(40, true), samples.length * 2, 'data chunk size')

const decoded = new Int16Array(wav.buffer, 44)
assert.deepEqual([...decoded], [...samples], 'payload round-trips exactly')

console.log('wav.test.ts: all tests passed')
