// Run: bun src/repair-cost.test.ts
//
// Pins repair()'s cost post-index (Task A2). Two scenarios:
//  1. A 1k-shape CLEAN doc (empty plan) — the Phase-2 review measured this at
//     ~7.36ms/call, and that floor is dominated by the three list*() WASM
//     marshals inside repair() (measured ~70% of it), NOT by nodeByShapeId's
//     O(n) scan — an empty plan means the scan's call site in repair()'s loop
//     never runs. So the index does not materially move this number; it is
//     re-measured here (not "should improve") and pinned with a generous
//     ceiling so a real regression (e.g. someone reintroducing an O(n) scan
//     into the list*() path) still trips it.
//  2. A 1k-shape DIRTY doc whose plan has 500 dropShape ops — this is the
//     scenario the O(n) nodeByShapeId/nodesByShapeId scan made O(n^2): each
//     op re-resolved its id via a full tree scan. Measured against the
//     pre-index implementation (git HEAD~1 at the time this test was
//     written): ~730ms for this exact scenario. Post-index: pinned well
//     under that.
// Both are backed by a structural gate (bounded tree.nodes() call count)
// since wall-clock is inherently noisier in CI than in a dev measurement.
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const validShape = (id: string) => ({
  id, kind: 'note', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { color: 'yellow' },
})
// opacity: 'no' (wrong type, string not number) fails the envelope's zod
// schema -> validProps violation -> repairPlan emits dropShape (same
// construction as canvas-doc/src/repair.test.ts's doc2 case).
const invalidShape = (id: string) => ({ ...validShape(id), opacity: 'no' as any })

function cleanDoc(): LoroCanvasDoc {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' } as any)
  for (let i = 0; i < 1000; i++) doc.putShape(validShape(`shape:s${i}`) as any)
  doc.commit()
  return doc
}
function dirtyDoc(): LoroCanvasDoc {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' } as any)
  for (let i = 0; i < 500; i++) doc.putShape(validShape(`shape:v${i}`) as any)
  for (let i = 0; i < 500; i++) doc.putShape(invalidShape(`shape:bad${i}`) as any)
  doc.commit()
  return doc
}

function meanRepairMs(build: () => LoroCanvasDoc, iters: number): { mean: number; planLen: number } {
  const times: number[] = []
  let planLen = -1
  for (let i = 0; i < iters; i++) {
    const doc = build() // fresh doc each iteration: repair() mutates it
    const t0 = performance.now()
    const plan = doc.repair()
    times.push(performance.now() - t0)
    planLen = plan.length
  }
  return { mean: times.reduce((a, b) => a + b, 0) / iters, planLen }
}

// --- scenario 1: clean 1k-shape doc ---
const clean = meanRepairMs(cleanDoc, 20)
assert.equal(clean.planLen, 0, 'precondition: doc is invariant-clean, empty plan')
console.log(`repair-cost: CLEAN 1k-shape doc, mean ${clean.mean.toFixed(3)}ms/call over 20 runs`)
// Generous ceiling: measured mean ~6-7ms on the dev box (unchanged from the
// 7.36ms Phase-2 floor, as expected for an empty plan). Margin math for the
// 50ms ceiling: a 16-core saturation test on the dev box pushed this to
// 15.0ms at only ~2.4x slowdown, and shared CI runners (GH Actions) run
// 3-5x slower than that box — 6.3ms x 5 ≈ 31.5ms, which would breach a 20ms
// ceiling on a bad day. 50ms gives full 5x slow-runner headroom while an
// O(n) regression in the hot path lands orders of magnitude above it; the
// structural tree.nodes() call-count gate below remains the primary
// regression detector, this wall-clock pin is the coarse backstop.
assert.ok(clean.mean < 50, `clean-doc repair() mean ${clean.mean.toFixed(3)}ms exceeds the 50ms ceiling`)

// --- scenario 2: dirty 1k-shape doc, 500-op plan (the O(n^2) scenario) ---
const dirty = meanRepairMs(dirtyDoc, 10)
assert.equal(dirty.planLen, 500, 'precondition: 500 dropShape ops in the plan')
console.log(`repair-cost: DIRTY 1k-shape doc (500-op plan), mean ${dirty.mean.toFixed(2)}ms/call over 10 runs`)
// Measured against the pre-index implementation: ~730ms for this exact
// scenario (O(n) nodesByShapeId scan x 500 ops on a 1000-node tree). Pinned
// well under that — 100ms leaves ~7x margin over the measured ~11ms while
// still failing hard if the O(n^2) behavior returns.
assert.ok(dirty.mean < 100, `dirty-doc repair() mean ${dirty.mean.toFixed(2)}ms exceeds the 100ms ceiling`)

// --- structural gate: tree.nodes() call count does not scale with plan size ---
// The real invariant the index buys: repair()'s cost is no longer a function
// of how many ops are in the plan. Spy on the private tree's nodes() (the
// WASM marshal both listShapes() and reindex() call) and confirm the count
// is IDENTICAL whether the plan has 0 ops or 500 — proof the per-op scan is
// gone, independent of wall-clock noise.
function nodesCallCountForRepair(build: () => LoroCanvasDoc): number {
  const doc = build()
  const tree = (doc as any).tree
  const original = tree.nodes.bind(tree)
  let count = 0
  tree.nodes = (...args: unknown[]) => { count++; return original(...args) }
  doc.repair()
  tree.nodes = original
  return count
}
const cleanCalls = nodesCallCountForRepair(cleanDoc)
const dirtyCalls = nodesCallCountForRepair(dirtyDoc)
console.log(`repair-cost: tree.nodes() calls — clean(0-op plan)=${cleanCalls}, dirty(500-op plan)=${dirtyCalls}`)
assert.ok(cleanCalls <= 2, `clean-doc repair() called tree.nodes() ${cleanCalls} times, expected a small constant`)
assert.equal(dirtyCalls, cleanCalls + 1, 'dirty-doc repair() calls tree.nodes() exactly ONE more time than clean (the trailing reindex(), skipped when the plan is empty) — NOT once per plan op')

console.log('ok: repair-cost')
