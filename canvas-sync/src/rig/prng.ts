// Deterministic PRNG for the E1/E2 rigs. This file lives under canvas-sync/src
// (not src/rig-only-excluded), so boundary.test.ts scans it like every other
// non-test source file — Math.random/Date.now are forbidden here too, which
// is free: the rig needs seeded determinism anyway (same seed ⇒ same replay,
// forever — the whole point of the shrink-to-minimal-repro contract).
export type Rng = () => number

/** mulberry32: small, fast, good-enough-for-testing PRNG. Returns a closure
 * producing numbers in [0, 1), reseedable by constructing a fresh instance
 * from the same seed. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform pick from a non-empty array. Throws on an empty array (a rig bug,
 * not a runtime condition to swallow). */
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('pick: empty array')
  return arr[Math.floor(rng() * arr.length)] as T
}

/** Uniform integer in [0, n). */
export function int(rng: Rng, n: number): number {
  return Math.floor(rng() * n)
}

/** Fisher-Yates shuffle, PRNG-driven (not Math.random) — returns a new array,
 * input is untouched. */
export function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(rng, i + 1)
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}
