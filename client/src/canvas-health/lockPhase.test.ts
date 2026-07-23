/**
 * The gate's tri-state decision. `pending` exists so a lone tab never flashes
 * the refusal screen during the (sub-millisecond, but non-zero) wait for its
 * own lock grant.
 */
import assert from 'node:assert/strict'
import { lockPhase } from './useCanvasLock'

const base = { supported: true, granted: false, otherHolderSeen: false, graceElapsed: false }

// 1. Nothing known yet ⇒ pending. This is the first paint of EVERY tab.
assert.equal(lockPhase(base), 'pending')

// 2. Granted ⇒ held.
assert.equal(lockPhase({ ...base, granted: true }), 'held')

// 3. Someone else holds it ⇒ blocked, without waiting for the grace timer.
assert.equal(lockPhase({ ...base, otherHolderSeen: true }), 'blocked')

// 4. Grace elapsed with no grant ⇒ blocked, even if query() never answered.
//    This is the backstop that stops a tab sitting on a blank splash forever.
assert.equal(lockPhase({ ...base, graceElapsed: true }), 'blocked')

// 5. GRANTED WINS over a query result. query() is async, so its answer can
//    land AFTER our own grant — treating it as authoritative would blank out a
//    tab that legitimately owns the canvas. There is no teardown path after
//    this change, so a granted tab must never be re-blocked.
assert.equal(lockPhase({ ...base, granted: true, otherHolderSeen: true }), 'held')

// 6. GRANTED WINS over the grace timer, for the same reason: a slow grant
//    (holder closed at t=2.9s) must not be overridden by a timer that already
//    fired.
assert.equal(lockPhase({ ...base, granted: true, graceElapsed: true }), 'held')

// 7. FAIL OPEN: no navigator.locks ⇒ held, regardless of everything else.
//    Single-tab enforcement is best-effort and must never be a hard
//    dependency — an engine without the API gets the app, not a refusal.
assert.equal(lockPhase({ ...base, supported: false }), 'held')
assert.equal(lockPhase({ supported: false, granted: false, otherHolderSeen: true, graceElapsed: true }), 'held')

console.log('lockPhase: ok')
