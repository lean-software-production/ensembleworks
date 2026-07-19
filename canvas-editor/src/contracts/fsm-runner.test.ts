// Run: bun src/contracts/fsm-runner.test.ts
import assert from 'node:assert/strict'
import type { Contract } from '@ensembleworks/interaction-contracts'
import { runContractFsm } from './fsm-runner.js'

// A contract that always holds: after a plain wheel, the visible world rect is
// a well-formed rectangle (minX < maxX). Proves the runner drives events,
// applies the wheel camera policy, and evaluates the invariant.
const alwaysHolds: Contract = {
  name: 'smoke-visible-rect-wellformed',
  level: 'fsm',
  when: 'every-event',
  gesture: () => [{ kind: 'wheel', dx: 0, dy: 50, at: { ref: 'point', x: 100, y: 100 } }],
  check: (obs) => {
    const r = obs.visibleWorldRect()
    return r.maxX > r.minX && r.maxY > r.minY ? null : `degenerate rect ${JSON.stringify(r)}`
  },
}

// A contract that always fails: asserts an impossible visible rect.
const alwaysFails: Contract = {
  ...alwaysHolds,
  name: 'smoke-impossible',
  check: () => 'deliberate failure',
}

{
  const r = runContractFsm(alwaysHolds, 1)
  assert.equal(r.failure, null, 'a holding contract passes')
  console.log('ok: FSM runner reports a passing contract')
}
{
  const r = runContractFsm(alwaysFails, 7)
  assert.equal(r.failure, 'deliberate failure', 'a failing contract surfaces its message')
  assert.equal(r.seed, 7, 'the failing seed is attached for repro')
  console.log('ok: FSM runner reports a failing contract with its seed')
}
{
  const a = runContractFsm(alwaysHolds, 123)
  const b = runContractFsm(alwaysHolds, 123)
  assert.deepEqual(a, b, 'same seed -> same verdict (determinism)')
  console.log('ok: FSM runner is deterministic per seed')
}

// Short-circuit: an every-event contract over a THREE-event gesture whose
// invariant passes on event 1 and fails from event 2 onward must return the
// FIRST failing event's observation, not the final state's. Plain wheel pans
// camera.y -= dy/z (wheel-down reveals content below), and minY of the
// visible rect is -camera.y, so three dy=100 wheels observe minY = 100, 200,
// 300; the invariant (minY <= 150) first fails at 200.
const failsMidway: Contract = {
  name: 'smoke-first-failure-wins',
  level: 'fsm',
  when: 'every-event',
  gesture: () => [
    { kind: 'wheel', dx: 0, dy: 100, at: { ref: 'point', x: 100, y: 100 } },
    { kind: 'wheel', dx: 0, dy: 100, at: { ref: 'point', x: 100, y: 100 } },
    { kind: 'wheel', dx: 0, dy: 100, at: { ref: 'point', x: 100, y: 100 } },
  ],
  check: (obs) => {
    const minY = obs.visibleWorldRect().minY
    return minY <= 150 ? null : `minY=${minY}`
  },
}
{
  const r = runContractFsm(failsMidway, 1)
  assert.equal(r.failure, 'minY=200', 'every-event returns the FIRST failing event (short-circuit), not the final state')
  console.log('ok: FSM runner short-circuits at the first failing event')
}

// Discriminating pair: the SAME gesture + check that fails mid-gesture but
// holds at the end (pan down past the limit, then pan back) must fail under
// every-event and pass under at-end — pinning that `when` really selects
// per-event vs final-state evaluation.
const overshootsThenRecovers: Contract = {
  name: 'smoke-overshoot-recover',
  level: 'fsm',
  when: 'every-event',
  gesture: () => [
    { kind: 'wheel', dx: 0, dy: 200, at: { ref: 'point', x: 100, y: 100 } },
    { kind: 'wheel', dx: 0, dy: -200, at: { ref: 'point', x: 100, y: 100 } },
  ],
  check: (obs) => {
    const minY = obs.visibleWorldRect().minY
    return minY <= 150 ? null : `minY=${minY}`
  },
}
{
  const everyEvent = runContractFsm(overshootsThenRecovers, 1)
  const atEnd = runContractFsm({ ...overshootsThenRecovers, when: 'at-end' }, 1)
  assert.equal(everyEvent.failure, 'minY=200', 'every-event catches the mid-gesture violation')
  assert.equal(atEnd.failure, null, 'at-end judges ONLY the final state (mid-gesture violation invisible)')
  console.log('ok: FSM runner distinguishes every-event from at-end (discriminating pair)')
}

// Non-vacuous determinism: the gesture CONSUMES its rng (wheel dy drawn from
// rng.next()), and the check is a reporter that always "fails" with the
// observed minY — so the rng-derived pan is visible in the result. Same seed
// twice -> identical results; two seeds -> different observed coordinates,
// proving the rng actually influenced the run.
const rngDriven: Contract = {
  name: 'smoke-rng-driven',
  level: 'fsm',
  when: 'at-end',
  gesture: (rng) => [{ kind: 'wheel', dx: 0, dy: 100 * rng.next(), at: { ref: 'point', x: 100, y: 100 } }],
  check: (obs) => `minY=${obs.visibleWorldRect().minY}`,
}
{
  const a = runContractFsm(rngDriven, 5)
  const b = runContractFsm(rngDriven, 5)
  assert.deepEqual(a, b, 'same seed -> identical result for an rng-consuming gesture')
  assert.ok(a.failure !== null && /^minY=\d/.test(a.failure), `reporter exposes an rng-derived pan (got ${a.failure})`)
  const other = runContractFsm(rngDriven, 6)
  assert.notEqual(a.failure, other.failure, 'different seeds -> different resolved gesture coordinates')
  console.log('ok: FSM runner determinism is rng-sensitive (same seed identical, seeds diverge)')
}

// seedScene is a LOUD seam: a malformed SceneShape (bad id prefix / unknown
// kind) throws at seeding time instead of writing a malformed shape.
{
  const badScene: Contract = {
    ...alwaysHolds,
    name: 'smoke-bad-scene',
    scene: () => [{ id: 'nope', kind: 'note', x: 0, y: 0, w: 10, h: 10 }],
  }
  assert.throws(() => runContractFsm(badScene, 1), /seedScene: invalid SceneShape "nope"/, 'malformed scene id throws loudly')
  const badKind: Contract = {
    ...alwaysHolds,
    name: 'smoke-bad-kind',
    scene: () => [{ id: 'shape:s1', kind: 'not-a-kind', x: 0, y: 0, w: 10, h: 10 }],
  }
  assert.throws(() => runContractFsm(badKind, 1), /seedScene: invalid SceneShape "shape:s1"/, 'unknown scene kind throws loudly')
  console.log('ok: seedScene rejects malformed SceneShapes loudly')
}
