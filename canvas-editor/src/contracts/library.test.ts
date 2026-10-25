// Run: bun src/contracts/library.test.ts
// The FSM lane: every level:'fsm' contract in the library must hold across a
// fixed seed set. Seeds are deterministic; a failure prints the contract name
// + seed for exact repro.
import assert from 'node:assert/strict'
import { CONTRACTS } from '@ensembleworks/interaction-contracts'
import { runContractFsm } from './fsm-runner.js'

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34]
let ran = 0
for (const contract of CONTRACTS.filter((c) => c.level === 'fsm')) {
  for (const seed of SEEDS) {
    const r = runContractFsm(contract, seed)
    assert.equal(r.failure, null, `contract '${r.contract}' violated at seed ${r.seed}: ${r.failure}`)
    ran++
  }
}
console.log(`ok: ${ran} fsm-contract runs held (${CONTRACTS.filter((c) => c.level === 'fsm').length} contract(s) x ${SEEDS.length} seeds)`)

// Wide fuzz campaign — drag-cursor-lock ONLY (Pilot 2's pin; cheap at the FSM
// level, and the fuzz campaign the design promises). Every other contract
// keeps the fixed-seed loop above; this widens just the one the audit's
// drift repro lives in.
const CURSOR_LOCK = CONTRACTS.find((c) => c.name === 'drag-cursor-lock')
assert.ok(CURSOR_LOCK, 'drag-cursor-lock must be registered for the wide campaign')
const WIDE_SEED_COUNT = 200
for (let seed = 0; seed < WIDE_SEED_COUNT; seed++) {
  const r = runContractFsm(CURSOR_LOCK, seed)
  assert.equal(r.failure, null, `contract '${r.contract}' violated at seed ${r.seed}: ${r.failure}`)
}
console.log(`ok: drag-cursor-lock held across ${WIDE_SEED_COUNT} seeds`)
