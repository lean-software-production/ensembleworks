/**
 * Minimal mono 16-bit PCM WAV encoder. The AudioStream already delivers
 * resampled 16 kHz mono Int16 frames, so a 44-byte RIFF header in front of
 * the raw samples is all an STT server needs.
 */

export function encodeWavPcm16(samples: Int16Array, sampleRate: number): Uint8Array {
	const dataBytes = samples.length * 2
	const buf = new ArrayBuffer(44 + dataBytes)
	const view = new DataView(buf)
	const writeAscii = (off: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
	}

	writeAscii(0, 'RIFF')
	view.setUint32(4, 36 + dataBytes, true)
	writeAscii(8, 'WAVE')
	writeAscii(12, 'fmt ')
	view.setUint32(16, 16, true) // fmt chunk size
	view.setUint16(20, 1, true) // PCM
	view.setUint16(22, 1, true) // mono
	view.setUint32(24, sampleRate, true)
	view.setUint32(28, sampleRate * 2, true) // byte rate
	view.setUint16(32, 2, true) // block align
	view.setUint16(34, 16, true) // bits per sample
	writeAscii(36, 'data')
	view.setUint32(40, dataBytes, true)
	new Int16Array(buf, 44).set(samples)
	return new Uint8Array(buf)
}
