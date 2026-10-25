// Run: bun src/fractional-index.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateKeyBetween, generateNKeysBetween, indexBetween } from './fractional-index.js'

// --- published vectors (from the reference algorithm; see plan D-1) ---
assert.equal(generateKeyBetween(null, null), 'a0', 'vector: (null,null) -> a0')
assert.equal(generateKeyBetween('a0', null), 'a1', 'vector: (a0,null) -> a1')
assert.equal(generateKeyBetween(null, 'a0'), 'Zz', 'vector: (null,a0) -> Zz')
assert.equal(generateKeyBetween('a0', 'a1'), 'a0V', 'vector: (a0,a1) -> a0V')
assert.equal(generateKeyBetween('a1', null), 'a2', 'vector: (a1,null) -> a2')

// --- indexBetween is an alias of generateKeyBetween ---
assert.equal(indexBetween, generateKeyBetween, 'indexBetween re-exports generateKeyBetween')

// --- determinism: identical args -> identical output, always ---
{
  const r1 = generateKeyBetween('a0', 'a1')
  const r2 = generateKeyBetween('a0', 'a1')
  assert.equal(r1, r2, 'determinism: same call twice yields identical key')
  const r3 = generateKeyBetween(null, null)
  const r4 = generateKeyBetween(null, null)
  assert.equal(r3, r4, 'determinism: (null,null) is stable across calls')
  // also exercise the SAME-integer-part fractional-midpoint branch (a
  // bounded pair whose integer parts are equal, e.g. two keys under 'a0')
  // interleaved with OTHER calls in between, so a counter-driven or
  // call-order-driven source of entropy (not just a literal Math.random
  // call) would be caught too, not just a byte-for-byte identical
  // back-to-back call.
  const r5 = generateKeyBetween('a0V', 'a0W')
  generateKeyBetween(null, null) // unrelated call in between, on purpose
  const r6 = generateKeyBetween('a0V', 'a0W')
  assert.equal(r5, r6, 'determinism: same-integer-part midpoint is stable across calls, even interleaved with other calls')
}

// --- strict-between property, walked over a growing chain ---
{
  // Build a chain of 200 keys via repeated midpoint bisection and check
  // every adjacent pair is strictly ordered, and every freshly generated
  // midpoint is strictly between its bounds.
  let lo: string | null = null
  let hi: string | null = null
  let a = generateKeyBetween(lo, hi) // 'a0'
  let b = generateKeyBetween(a, hi) // above a0, unbounded above
  assert.ok(a < b, `strict-between seed: ${a} < ${b}`)
  let prevA = a
  let prevB = b
  for (let i = 0; i < 200; i++) {
    const mid = generateKeyBetween(prevA, prevB)
    assert.ok(prevA < mid, `strict-between[${i}]: ${prevA} < ${mid}`)
    assert.ok(mid < prevB, `strict-between[${i}]: ${mid} < ${prevB}`)
    // narrow the window from a random-ish deterministic side (alternate)
    if (i % 2 === 0) {
      prevB = mid
    } else {
      prevA = mid
    }
  }
}

// --- strict-between property over many generated (a,b) pairs, including
// equal-prefix keys ---
{
  const seeds: Array<[string | null, string | null]> = [
    [null, null],
    ['a0', null],
    [null, 'a0'],
    ['a0', 'a1'],
    ['a0', 'a0V'],
    ['a0V', 'a1'],
    ['Zz', 'a0'],
    ['a1', 'a2'],
  ]
  for (const [a, b] of seeds) {
    const mid = generateKeyBetween(a, b)
    if (a !== null) assert.ok(a < mid, `strict-between pair (${a},${b}): ${a} < ${mid}`)
    if (b !== null) assert.ok(mid < b, `strict-between pair (${a},${b}): ${mid} < ${b}`)
  }

  // equal-prefix keys: two keys sharing a long common prefix
  const p1 = 'a0VVVVV'
  const p2 = 'a0VVVVW'
  const midEq = generateKeyBetween(p1, p2)
  assert.ok(p1 < midEq && midEq < p2, `equal-prefix strict-between: ${p1} < ${midEq} < ${p2}`)
}

// --- before-first / after-last ---
{
  const x = 'a5'
  const before = generateKeyBetween(null, x)
  const after = generateKeyBetween(x, null)
  assert.ok(before < x, `before-first: ${before} < ${x}`)
  assert.ok(x < after, `after-last: ${x} < ${after}`)
}

// --- digit-exhaustion: adjacent single-char-apart keys force precision
// extension (no digit strictly between 'a0' and 'a1' in the header/int
// space alone -> the fractional part grows) ---
{
  const mid = generateKeyBetween('a0', 'a1')
  assert.ok('a0' < mid && mid < 'a1', `digit exhaustion extends precision: a0 < ${mid} < a1`)
  assert.ok(mid.length > 'a0'.length, 'digit exhaustion grows the key length')
}

// --- stress loop: repeated send-to-back (indexBetween(null, k)) stays
// strictly decreasing, never collides, never throws, terminates ---
{
  const N = 500
  let k = 'a5'
  const seen = new Set([k])
  let maxLen = k.length
  for (let i = 0; i < N; i++) {
    const next = generateKeyBetween(null, k)
    assert.ok(next < k, `send-to-back[${i}]: ${next} < ${k}`)
    assert.ok(!seen.has(next), `send-to-back[${i}]: no collision (${next})`)
    seen.add(next)
    maxLen = Math.max(maxLen, next.length)
    k = next
  }
  assert.equal(seen.size, N + 1, 'send-to-back: all 501 keys distinct')
  // bounded length growth: should not blow up unreasonably over 500 steps
  assert.ok(maxLen < 200, `send-to-back: key length stays bounded (max ${maxLen})`)
}

// --- stress loop: repeated send-to-front (indexBetween(k, null)) stays
// strictly increasing, never collides, never throws, terminates ---
{
  const N = 500
  let k = 'a5'
  const seen = new Set([k])
  let maxLen = k.length
  for (let i = 0; i < N; i++) {
    const next = generateKeyBetween(k, null)
    assert.ok(next > k, `send-to-front[${i}]: ${next} > ${k}`)
    assert.ok(!seen.has(next), `send-to-front[${i}]: no collision (${next})`)
    seen.add(next)
    maxLen = Math.max(maxLen, next.length)
    k = next
  }
  assert.equal(seen.size, N + 1, 'send-to-front: all 501 keys distinct')
  assert.ok(maxLen < 200, `send-to-front: key length stays bounded (max ${maxLen})`)
}

// --- generateNKeysBetween: n keys, strictly increasing, each strictly
// between the bounds ---
{
  const cases: Array<[string | null, string | null, number]> = [
    [null, null, 5],
    ['a0', null, 5],
    [null, 'a0', 5],
    ['a0', 'a1', 7],
    ['a5', 'a9', 10],
  ]
  for (const [a, b, n] of cases) {
    const keys = generateNKeysBetween(a, b, n)
    assert.equal(keys.length, n, `generateNKeysBetween(${a},${b},${n}) returns ${n} keys`)
    for (let i = 0; i < keys.length; i++) {
      if (a !== null) assert.ok(a < keys[i], `key[${i}]=${keys[i]} > lower bound ${a}`)
      if (b !== null) assert.ok(keys[i] < b, `key[${i}]=${keys[i]} < upper bound ${b}`)
      if (i > 0) assert.ok(keys[i - 1] < keys[i], `strictly increasing: ${keys[i - 1]} < ${keys[i]}`)
    }
  }
  // n=0 and n=1 edge cases
  assert.deepEqual(generateNKeysBetween('a0', 'a1', 0), [], 'n=0 -> empty array')
  const one = generateNKeysBetween('a0', 'a1', 1)
  assert.equal(one.length, 1, 'n=1 -> single key')
  assert.ok('a0' < one[0] && one[0] < 'a1', 'n=1 key strictly between bounds')
}

// --- ordering total: a sequence of inserts produces keys whose string-sort
// matches insertion intent (simulate repeated "insert after the current
// last" then verify the whole run sorts in insertion order) ---
{
  const keys: string[] = [generateKeyBetween(null, null)]
  for (let i = 0; i < 50; i++) {
    keys.push(generateKeyBetween(keys[keys.length - 1], null))
  }
  const sorted = [...keys].sort()
  assert.deepEqual(sorted, keys, 'append-only run: string-sort matches insertion order')

  // now interleave inserts strictly between the first two keys 30 times,
  // interspersed with appends, and verify string-sort still matches the
  // logical order in which we placed each key
  const timeline: string[] = [keys[0], keys[1]]
  for (let i = 0; i < 30; i++) {
    const mid = generateKeyBetween(timeline[0], timeline[1])
    timeline.splice(1, 0, mid)
  }
  const sortedTimeline = [...timeline].sort()
  assert.deepEqual(sortedTimeline, timeline, 'interleaved inserts: string-sort matches logical order')
}

// --- clean-room: the module source text must never contain Math.random( ---
{
  const src = readFileSync(new URL('./fractional-index.ts', import.meta.url), 'utf8')
  assert.ok(!src.includes('Math.random' + '('), 'source has no Math.random( call (clean-room, no jitter)')
}

console.log('ok: fractional-index')
