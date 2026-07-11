// Run: bun src/memory-transport.test.ts
import assert from 'node:assert/strict'
import { makePair } from './memory-transport.js'

// a -> b delivery: exact bytes, synchronous (same tick, no timers).
{
  const [a, b] = makePair()
  const received: Uint8Array[] = []
  b.onMessage((bytes) => received.push(bytes))
  const payload = new Uint8Array([1, 2, 3])
  a.send(payload)
  assert.equal(received.length, 1, 'b received exactly one message')
  assert.deepEqual(received[0], payload, 'exact bytes delivered a -> b')
}

// b -> a delivery: exact bytes, synchronous.
{
  const [a, b] = makePair()
  const received: Uint8Array[] = []
  a.onMessage((bytes) => received.push(bytes))
  const payload = new Uint8Array([9, 8, 7])
  b.send(payload)
  assert.equal(received.length, 1, 'a received exactly one message')
  assert.deepEqual(received[0], payload, 'exact bytes delivered b -> a')
}

// close() fires BOTH onClose callbacks exactly once, even if called twice.
{
  const [a, b] = makePair()
  let aCloses = 0
  let bCloses = 0
  a.onClose(() => aCloses++)
  b.onClose(() => bCloses++)
  a.close()
  a.close() // second call must be a no-op
  b.close() // already closed via a; must also be a no-op
  assert.equal(aCloses, 1, 'a.onClose fired exactly once')
  assert.equal(bCloses, 1, 'b.onClose fired exactly once')
}

// After close(), send() is a silent no-op: no delivery, no throw.
{
  const [a, b] = makePair()
  const received: Uint8Array[] = []
  b.onMessage((bytes) => received.push(bytes))
  a.close()
  assert.doesNotThrow(() => a.send(new Uint8Array([1])), 'send after close does not throw')
  assert.equal(received.length, 0, 'no delivery after close')
}

console.log('ok: memory-transport')
