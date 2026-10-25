// Run: bun src/protocol.test.ts
import assert from 'node:assert/strict'
import { Frame, decode, encode } from './protocol.js'

// Round-trip each Frame tag through encode/decode: tag and payload both survive.
for (const tag of [Frame.Update, Frame.Presence, Frame.SyncRequest, Frame.SyncDone]) {
  const payload = new Uint8Array([1, 2, 3, 4, 5])
  const frame = encode(tag, payload)
  const out = decode(frame)
  assert.equal(out.tag, tag, `tag round-trips for Frame ${tag}`)
  assert.deepEqual(out.payload, payload, `payload bytes round-trip for Frame ${tag}`)
}

// decode() on an empty frame throws — there is no tag byte to read.
assert.throws(() => decode(new Uint8Array(0)), /empty frame/)

// An empty-payload Update round-trips: payload length 0, not undefined/absent.
{
  const frame = encode(Frame.Update, new Uint8Array(0))
  const out = decode(frame)
  assert.equal(out.tag, Frame.Update)
  assert.equal(out.payload.length, 0)
}

// decode() does not copy: payload is a `subarray` view of length N over the
// 1+N frame, not a fresh N+1-length copy.
{
  const payload = new Uint8Array([9, 8, 7])
  const frame = encode(Frame.Presence, payload)
  const out = decode(frame)
  assert.equal(out.payload.byteLength, payload.byteLength, 'decoded payload length pins to N, not N+1')
  assert.equal(out.payload.buffer, frame.buffer, 'payload is a view over the same underlying buffer (subarray, no copy)')
}

console.log('ok: protocol')
