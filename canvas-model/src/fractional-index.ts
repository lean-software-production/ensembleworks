// @ensembleworks/canvas-model — deterministic base-62 fractional indexing.
//
// This is a faithful, hand-rolled port of the well-known
// "fractional-indexing" algorithm (Figma / rocicorp), stripped down to ONLY
// its deterministic generator. The reference library also ships a
// *jittered* variant (`generateJitteredKeyBetween`) that appends a
// random-derived suffix to make concurrent-insert collisions rarer — we
// deliberately do NOT port that path. This module is pure string/integer
// math: no clock, no PRNG, no I/O. (Clean-room note: the forbidden literal
// is spelled out with a broken concatenation on purpose so this comment
// itself does not trip a text scan for it: 'Math' + '.random' + '(' must
// never appear in this file, in any form, including as a real call.)
//
// Convergence story: because there is no jitter, two peers independently
// computing "a key between A and B" get the IDENTICAL string — a z-tie.
// That is CORRECT for us, not a bug: the renderer's paint-order sort
// (paint-order.ts) breaks ties on shape id, giving a total, deterministic
// order every peer agrees on regardless of CRDT merge order. Determinism
// here is what makes that convergence guarantee hold; jitter would only
// reduce (not eliminate) ties while adding entropy this codebase forbids.
//
// Key shape: an "integer part" (a run of digits whose LENGTH is encoded by
// its first character — 'a'..'z' for positive-magnitude lengths 2..27,
// 'A'..'Z' mirrored for negative-magnitude lengths) followed by an optional
// "fractional part" (arbitrary-length digits with no trailing '0'). The
// integer-part length header is what lets `generateKeyBetween(k, null)` /
// `generateKeyBetween(null, k)` — repeated send-to-front / send-to-back —
// terminate cleanly by growing/shrinking the INTEGER part indefinitely,
// instead of exhausting precision the way a naive header-less "average the
// digit strings" scheme would (that scheme cannot represent a key below the
// smallest digit and breaks send-to-back — see the plan's D-1).

const BASE_62_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

const INTEGER_ZERO = 'a0'
// The smallest representable integer part: head 'A' (most-negative-length
// header) followed by the longest all-zero digit run for that header.
const SMALLEST_INT = 'A' + '0'.repeat(26)

/** How many digits the integer part has, given its header character. */
function getIntegerLength(head: string): number {
  if (head >= 'a' && head <= 'z') {
    return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2
  }
  if (head >= 'A' && head <= 'Z') {
    return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2
  }
  throw new Error(`invalid order key head: ${head}`)
}

/** Split a key into its integer part (header + digits). */
function getIntegerPart(key: string): string {
  const len = getIntegerLength(key[0]!)
  if (len > key.length) throw new Error(`invalid order key: ${key}`)
  return key.slice(0, len)
}

function validateInteger(int: string): void {
  if (int.length !== getIntegerLength(int[0]!)) {
    throw new Error(`invalid integer part of order key: ${int}`)
  }
}

function validateOrderKey(key: string): void {
  if (key === SMALLEST_INT) throw new Error(`invalid order key: ${key}`)
  const int = getIntegerPart(key)
  validateInteger(int)
  const frac = key.slice(int.length)
  if (frac.length > 0 && frac[frac.length - 1] === '0') {
    throw new Error(`invalid order key: ${key}`)
  }
}

/** One step up: 'a9' -> 'b0'-ish growth via the header, or null if maxed. */
function incrementInteger(x: string): string | null {
  const head = x[0]!
  const digs = x.slice(1).split('')
  let carry = true
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = BASE_62_DIGITS.indexOf(digs[i]!) + 1
    if (d === BASE_62_DIGITS.length) {
      digs[i] = '0'
    } else {
      digs[i] = BASE_62_DIGITS[d]!
      carry = false
    }
  }
  if (carry) {
    if (head === 'Z') return INTEGER_ZERO
    if (head === 'z') return null
    const nextHead = String.fromCharCode(head.charCodeAt(0) + 1)
    if (nextHead > 'a') digs.push('0')
    else digs.pop()
    return nextHead + digs.join('')
  }
  return head + digs.join('')
}

/** One step down: symmetric to incrementInteger. */
function decrementInteger(x: string): string | null {
  const head = x[0]!
  const digs = x.slice(1).split('')
  let borrow = true
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = BASE_62_DIGITS.indexOf(digs[i]!) - 1
    if (d === -1) {
      digs[i] = BASE_62_DIGITS[BASE_62_DIGITS.length - 1]!
    } else {
      digs[i] = BASE_62_DIGITS[d]!
      borrow = false
    }
  }
  if (borrow) {
    if (head === 'a') return 'Z' + BASE_62_DIGITS[BASE_62_DIGITS.length - 1]!
    if (head === 'A') return null
    const nextHead = String.fromCharCode(head.charCodeAt(0) - 1)
    if (nextHead < 'Z') digs.push(BASE_62_DIGITS[BASE_62_DIGITS.length - 1]!)
    else digs.pop()
    return nextHead + digs.join('')
  }
  return head + digs.join('')
}

/**
 * The fractional-part midpoint between digit-strings `a` and `b` (`b` may
 * be null for "unbounded above"). `a` is always lexicographically before
 * `b`. Recurses past any shared prefix, then splits the digit gap; if the
 * gap is too narrow to split, extends precision by one more digit.
 */
function midpoint(a: string, b: string | null): string {
  if (b != null && a >= b) throw new Error(`${a} >= ${b}`)
  if (a.slice(-1) === '0' || (b != null && b.slice(-1) === '0')) {
    throw new Error('trailing zero in midpoint input')
  }
  if (b != null) {
    // strip the shared prefix; it carries through untouched
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const digitA = a ? BASE_62_DIGITS.indexOf(a[0]!) : 0
  const digitB = b != null ? BASE_62_DIGITS.indexOf(b[0]!) : BASE_62_DIGITS.length
  if (digitB - digitA > 1) {
    const midDigit = Math.round(0.5 * (digitA + digitB))
    return BASE_62_DIGITS[midDigit]!
  }
  // no room between adjacent digits: extend precision by one more place
  if (b != null && b.length > 1) {
    return b.slice(0, 1)
  }
  return BASE_62_DIGITS[digitA]! + midpoint(a.slice(1), null)
}

/**
 * A key strictly between `a` and `b` (lexicographic string order), with
 * `null` meaning "unbounded" on that side: `(null, null)` seeds `'a0'`,
 * `(k, null)` returns a key after `k`, `(null, k)` returns a key before
 * `k`, `(a, b)` returns a midpoint. Deterministic — same inputs always
 * produce the same output (no randomness, no clock).
 */
export function generateKeyBetween(a: string | null, b: string | null): string {
  if (a != null) validateOrderKey(a)
  if (b != null) validateOrderKey(b)
  if (a != null && b != null && a >= b) {
    throw new Error(`generateKeyBetween: ${a} >= ${b}`)
  }

  if (a == null) {
    if (b == null) return INTEGER_ZERO
    const ib = getIntegerPart(b)
    const fb = b.slice(ib.length)
    if (ib === SMALLEST_INT) return ib + midpoint('', fb)
    if (ib < b) return ib
    const res = decrementInteger(ib)
    if (res == null) throw new Error('generateKeyBetween: cannot decrement below the smallest key')
    return res
  }

  if (b == null) {
    const ia = getIntegerPart(a)
    const fa = a.slice(ia.length)
    const next = incrementInteger(ia)
    return next == null ? ia + midpoint(fa, null) : next
  }

  const ia = getIntegerPart(a)
  const fa = a.slice(ia.length)
  const ib = getIntegerPart(b)
  const fb = b.slice(ib.length)
  if (ia === ib) return ia + midpoint(fa, fb)
  const next = incrementInteger(ia)
  if (next == null) throw new Error('generateKeyBetween: cannot increment past the largest key')
  if (next < b) return next
  return ia + midpoint(fa, null)
}

/**
 * `n` keys strictly between `a` and `b`, each strictly less than the next
 * (a strictly-increasing run). Used for multi-shape reorder ops that need
 * several new indices at once (bring-to-front / send-to-back over a
 * multi-select). Deterministic, same as `generateKeyBetween`.
 */
export function generateNKeysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return []
  if (n === 1) return [generateKeyBetween(a, b)]

  if (b == null) {
    let cur = generateKeyBetween(a, b)
    const result = [cur]
    for (let i = 0; i < n - 1; i++) {
      cur = generateKeyBetween(cur, b)
      result.push(cur)
    }
    return result
  }

  if (a == null) {
    let cur = generateKeyBetween(a, b)
    const result = [cur]
    for (let i = 0; i < n - 1; i++) {
      cur = generateKeyBetween(a, cur)
      result.push(cur)
    }
    result.reverse()
    return result
  }

  const mid = Math.floor(n / 2)
  const c = generateKeyBetween(a, b)
  return [...generateNKeysBetween(a, c, mid), c, ...generateNKeysBetween(c, b, n - mid - 1)]
}

/** Readable alias for call sites that think in terms of "insert between". */
export const indexBetween = generateKeyBetween
