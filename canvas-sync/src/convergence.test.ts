// Run: bun src/convergence.test.ts
//
// Property-based multi-replica convergence: N=3 independent LoroCanvasDoc
// peers each apply an independent random op batch (hostile ops included —
// see rig/ops.ts), exchange updates in a PRNG-shuffled order, then repair.
// The load-bearing assertions (design's A4 contract):
//   1. normalized dumpModel is byte-for-byte identical across all peers.
//   2. checkInvariants is empty on every peer's post-repair state.
//   3. MODEL-AGREEMENT: Loro's repair() and the pure applyRepairToModel
//      reference agree when both start from the same converged pre-repair
//      model.
// On any mismatch, shrink: replay the same seed at half the op count until
// the failure disappears, and fail with the minimal (seed, opCount) repro.
import assert from 'node:assert/strict'
import { LoroCanvasDoc, dumpModel } from '@ensembleworks/canvas-doc'
import { applyRepairToModel, checkInvariants, repairPlan, type CanvasDocument } from '@ensembleworks/canvas-model'
import { mulberry32, shuffle } from './rig/prng.js'
import { applyOp, randomOps, type IdPool } from './rig/ops.js'
import { normalize } from './test-helpers.js'

// Seed-count lever: `EW_RIG_SEEDS=500 bun src/convergence.test.ts` runs a
// larger sweep without editing source — that's how the 500/2000-seed stress
// runs in the execution reports are produced. Default 50 keeps the
// per-commit run sub-second. (NaN/0/absent all fall through to 50.)
const SEEDS = Number(process.env.EW_RIG_SEEDS) || 50
const N = 3
const MAX_OPS = 40
const PEER_IDS = [1n, 2n, 3n] as const

// Small and SHARED across all three peer-universes and every op in a trial:
// the whole point is that independent random streams collide on the same ids
// (concurrent prop edits on the same shape, cross-peer reparent cycles,
// binds racing deletes — see ops.ts's doc comment).
const ID_POOL: IdPool = {
  shapeIds: ['shape:a', 'shape:b', 'shape:c', 'shape:d', 'shape:e'],
  pageIds: ['page:p', 'page:q'],
  bindingIds: ['binding:1', 'binding:2', 'binding:3', 'binding:4'],
}

function statesEqual(a: unknown, b: unknown): boolean {
  try { assert.deepStrictEqual(a, b); return true } catch { return false }
}

interface TrialResult { ok: boolean; detail?: string; skipped: number }

/**
 * One full trial, parameterized ONLY by (seed, opCount) so it's replayable:
 * same inputs ⇒ same outcome, forever (the shrink mechanism depends on this).
 *
 * EXPORTED so the shrink failure message's replay instruction actually works:
 * `import { runTrial } from './convergence.test.ts'` then call it with the
 * reported (seed, opCount). Caveat, stated rather than hidden: house test
 * files are self-executing, so importing this module ALSO re-runs the full
 * seed sweep below as a side effect — acceptable for a debugging session
 * (it's the same sweep you're investigating), just don't import it from
 * another suite.
 */
export function runTrial(seed: number, opCount: number): TrialResult {
  const rng = mulberry32(seed)

  // GENESIS fork, not N independent creates: putShape on a brand-new id
  // CREATES a fresh Loro tree node (see loro-canvas-doc.ts's putShape — it
  // only upserts an id that's already resolvable via nodeByShapeId on THIS
  // doc). If three peers independently putShape the SAME id before ever
  // syncing, each gets its OWN tree node tagged with that shapeId, which is
  // unrealistic (production shape ids are unique nanoids, generated once,
  // never independently reused) and just adds noise the rig doesn't need to
  // stress. So every peer-universe FORKS from one shared genesis snapshot
  // that already contains every shapeId in the pool (+ the page(s) — this
  // also satisfies the zero-page precondition below) — the independent
  // per-peer op batches then mutate (reparent/update/delete/bind) a SHARED
  // tree-node identity per id, which is exactly the concurrent-edit scenario
  // the hostile ops are meant to stress (reparent-into-each-other, concurrent
  // prop edits, etc.). Even so, heavy concurrent structural churn on a shared
  // id CAN still converge into more than one physical Loro node per shapeId
  // (Loro's tree CRDT resolves conflicts per node identity, not per this
  // shapeId convention) — probe-proven while building this rig, and now
  // handled on both sides: LoroCanvasDoc.repair() reconciles every physical
  // node sharing an id (see its nodesByShapeId comment), and this file's
  // normalize() (test-helpers.ts) breaks sort ties on full content so a
  // converged duplicate-id multiset normalizes identically regardless of
  // per-peer tree traversal order.
  const genesis = LoroCanvasDoc.create({ peerId: 0n })
  genesis.putPage({ id: 'page:p', name: 'P' })
  // Zero-page docs make orphan-repair unsatisfiable BY DESIGN (repairPlan
  // emits no reparentToRoot ops when doc.pages.length === 0 — see repair.ts).
  // page:p above already guarantees every peer starts non-zero-page; this
  // second page is purely so canonicalPageId (lexicographically smallest)
  // has something to pick between.
  if (rng() < 0.3) genesis.putPage({ id: 'page:q', name: 'Q' })
  for (const id of ID_POOL.shapeIds) {
    genesis.putShape({
      id: id as any, kind: 'note', parentId: 'page:p', index: 'a0',
      x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {},
    })
  }
  genesis.commit()
  const genesisSnapshot = genesis.exportSnapshot()

  const peers = PEER_IDS.map((peerId) => LoroCanvasDoc.fromSnapshot(genesisSnapshot, { peerId }))

  const stats = { skipped: 0 }
  for (const doc of peers) {
    const ops = randomOps(rng, opCount, ID_POOL)
    for (const op of ops) applyOp(doc, op, stats)
    doc.commit()
  }

  // Exchange: every peer's update, imported into every OTHER peer, in a
  // PRNG-shuffled order per importer (not a fixed global order).
  const updates = peers.map((doc) => doc.exportUpdate())
  for (let i = 0; i < peers.length; i++) {
    const senders = shuffle(rng, [...updates.keys()].filter((j) => j !== i))
    for (const j of senders) peers[i]!.import(updates[j]!)
    peers[i]!.commit()
  }

  // Capture the converged PRE-repair model (any one peer — they all hold the
  // same oplog history at this point) for the model-agreement check below.
  const preRepairModel: CanvasDocument = dumpModel(peers[0]!)

  for (const doc of peers) { doc.repair(); doc.commit() }

  const normalizedStates = peers.map((doc) => normalize(dumpModel(doc)))
  for (let i = 1; i < normalizedStates.length; i++) {
    if (!statesEqual(normalizedStates[0], normalizedStates[i])) {
      return { ok: false, skipped: stats.skipped, detail: `peer 0 and peer ${i} disagree on normalized post-repair state` }
    }
  }

  for (let i = 0; i < peers.length; i++) {
    const violations = checkInvariants(dumpModel(peers[i]!))
    if (violations.length > 0) {
      return {
        ok: false,
        skipped: stats.skipped,
        detail: `peer ${i} has ${violations.length} invariant violation(s) after repair: ${JSON.stringify(violations)}`,
      }
    }
  }

  // A4: Loro's repair() and the pure reference must agree, starting from the
  // SAME converged pre-repair model.
  const plan = repairPlan(preRepairModel)
  const expected = normalize(applyRepairToModel(preRepairModel, plan))
  const actual = normalize(dumpModel(peers[0]!))
  if (!statesEqual(expected, actual)) {
    return { ok: false, skipped: stats.skipped, detail: 'Loro repair() and the pure applyRepairToModel reference disagree on the converged state' }
  }

  return { ok: true, skipped: stats.skipped }
}

/** Halve opCount on the same seed until the failure disappears; report the
 * minimal failing (seed, opCount) — the replayable repro. */
function shrinkAndFail(seed: number, failingOpCount: number, firstDetail: string): never {
  let minimalCount = failingOpCount
  let minimalDetail = firstDetail
  let count = failingOpCount
  while (count > 1) {
    const half = Math.floor(count / 2)
    const res = runTrial(seed, half)
    if (res.ok) break // the failure no longer reproduces below `count` — stop shrinking
    minimalCount = half
    minimalDetail = res.detail ?? minimalDetail
    count = half
  }
  assert.fail(
    `convergence rig FAILED — minimal repro: seed=${seed}, opCount=${minimalCount}. ${minimalDetail}\n` +
    `Replay with: runTrial(${seed}, ${minimalCount}) in canvas-sync/src/convergence.test.ts`,
  )
}

const started = performance.now()
let totalSkipped = 0
for (let seed = 1; seed <= SEEDS; seed++) {
  const res = runTrial(seed, MAX_OPS)
  totalSkipped += res.skipped
  if (!res.ok) shrinkAndFail(seed, MAX_OPS, res.detail ?? 'unknown failure')
}
const elapsedMs = performance.now() - started

console.log(`ok: convergence — ${SEEDS} seeds × N=${N} peers × ≤${MAX_OPS} ops/peer, ${elapsedMs.toFixed(0)}ms, ${totalSkipped} guarded cycle-op(s) skipped`)
