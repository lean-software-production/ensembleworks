// Run: bun src/types.test.ts
import assert from 'node:assert/strict'
import { mulberry32 } from './types.js'

// Determinism: same seed -> identical stream.
{
  const a = mulberry32(42)
  const b = mulberry32(42)
  const seqA = [a.next(), a.next(), a.next()]
  const seqB = [b.next(), b.next(), b.next()]
  assert.deepEqual(seqA, seqB, 'same seed produces the same stream')
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `value ${v} is in [0,1)`)
  console.log('ok: mulberry32 is deterministic and in-range')
}

// Different seeds diverge (a smoke check, not a statistical claim).
{
  assert.notEqual(mulberry32(1).next(), mulberry32(2).next(), 'different seeds diverge')
  console.log('ok: mulberry32 seeds diverge')
}
