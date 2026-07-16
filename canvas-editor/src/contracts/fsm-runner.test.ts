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
