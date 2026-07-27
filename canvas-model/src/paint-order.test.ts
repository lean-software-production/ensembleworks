// Run: bun src/paint-order.test.ts
//
// orderForPaint(shapes, byId) — DFS pre-order over the INPUT shape set: forest
// roots (shapes whose parentId is NOT itself an id present in the input set)
// sorted (index ASC, id ASC), then each shape's in-set children recursively,
// each level sorted the same way. See plan docs/plans/2026-07-22-canvas-v2-
// zorder.md, Task A2 / D-3 for the full rationale (DFS groups a subtree so a
// higher-index root paints over another root's ENTIRE subtree, which a flat
// (depth,index) sort cannot do).
import assert from 'node:assert/strict'
import type { Shape } from './shape.js'
import { orderForPaint } from './paint-order.js'

// Minimal shape fixture — only the fields orderForPaint reads (id, parentId,
// index) are load-bearing; the rest are envelope filler, same convention as
// the sibling document module's own test file's inline fixtures.
function s(id: string, parentId: string, index: string): Shape {
  return {
    id,
    kind: 'note',
    parentId,
    index,
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {},
  } as unknown as Shape
}

// byId is a full-doc map in real call sites (ShapeLayer passes snapshot.byId,
// which is NOT restricted to the culled/visible input set — see R1). Build it
// from the same fixtures here; tests below don't rely on it containing
// anything beyond what's in `shapes`.
function byIdOf(shapes: Shape[]): ReadonlyMap<string, Shape> {
  return new Map(shapes.map((sh) => [sh.id, sh]))
}

const ids = (shapes: Shape[]): string[] => shapes.map((sh) => sh.id)

// --- Case 1: sibling index order (scrambled input) ---
{
  const r1 = s('shape:r1', 'page:p', 'a1')
  const r2 = s('shape:r2', 'page:p', 'a2')
  const r3 = s('shape:r3', 'page:p', 'a3')
  const shapes = [r3, r1, r2] // scrambled
  const out = orderForPaint(shapes, byIdOf(shapes))
  assert.deepEqual(ids(out), ['shape:r1', 'shape:r2', 'shape:r3'], 'case 1: siblings paint in ascending index order')
}

// --- Case 2: (index,id) tie-break — the all-'a1' corpus ---
{
  const b = s('shape:b', 'page:p', 'a1')
  const a = s('shape:a', 'page:p', 'a1')
  const shapes = [b, a] // 'b' first in input, id tie-break must still put 'a' first
  const out = orderForPaint(shapes, byIdOf(shapes))
  assert.deepEqual(ids(out), ['shape:a', 'shape:b'], 'case 2: equal index falls back to ascending id, regardless of input order')
}

// --- Case 3: subtree grouping — the DFS crux, kills a flat (index,id) or
// flat (depth,index) sort. F (index a1) has child fc (index a1); S (index
// a2) is a sibling root with no children. True paint order groups F's WHOLE
// subtree before S: [F, fc, S] — S, the higher root index, occludes fc too.
{
  const f = s('shape:f', 'page:p', 'a1')
  const fc = s('shape:fc', 'shape:f', 'a1')
  const sh = s('shape:s', 'page:p', 'a2')
  // Scramble the input so no accidental insertion-order coincidence saves a
  // wrong (non-DFS) implementation.
  const shapes = [sh, fc, f]
  const out = orderForPaint(shapes, byIdOf(shapes))
  assert.deepEqual(ids(out), ['shape:f', 'shape:fc', 'shape:s'], 'case 3 (DFS crux): F\'s subtree [F, fc] groups together, entirely before S')
}

// --- Case 4: parent always precedes its descendants, at depth 3 ---
{
  const root = s('shape:root', 'page:p', 'a1')
  const child = s('shape:child', 'shape:root', 'a1')
  const grand = s('shape:grand', 'shape:child', 'a1')
  const shapes = [grand, root, child] // scrambled
  const out = orderForPaint(shapes, byIdOf(shapes))
  const pos = (id: string) => ids(out).indexOf(id)
  assert.ok(pos('shape:root') < pos('shape:child'), 'case 4: root precedes child')
  assert.ok(pos('shape:child') < pos('shape:grand'), 'case 4: child precedes grandchild')
}

// --- Case 5: culled subset — a child whose parent is NOT in the input set is
// treated as a forest root: never dropped, never throws. Two such orphans
// (different indices) must still sort against each other like any other
// roots.
{
  const orphanHi = s('shape:orphan-hi', 'shape:vanished-parent', 'a2')
  const orphanLo = s('shape:orphan-lo', 'shape:vanished-parent', 'a1')
  const shapes = [orphanHi, orphanLo] // 'shape:vanished-parent' is absent from this array
  const out = orderForPaint(shapes, byIdOf(shapes))
  assert.deepEqual(ids(out), ['shape:orphan-lo', 'shape:orphan-hi'], 'case 5: parent-absent-from-input shapes are forest roots, ordered like any root, never dropped')
}

// --- Determinism / shuffle-invariance: same converged set -> same output
// regardless of input array order. Fixture is deliberately built to EXERCISE
// BOTH the sibling-sort path (two roots tie on index 'a', broken by id) AND
// the DFS path (one of the tied roots has a child AND a grandchild, so a
// wrong flat-sort mutant would interleave them with the OTHER tied root) —
// see working rule 5 (A1's first determinism test had a coverage gap: it
// exercised a path a regression wouldn't land in).
{
  const ra1 = s('shape:ra1', 'page:p', 'a') // ties with ra2 on index; smaller id
  const ra2 = s('shape:ra2', 'page:p', 'a') // ties with ra1 on index; larger id
  const rb = s('shape:rb', 'page:p', 'b') // strictly after both, no children
  const c = s('shape:c', 'shape:ra1', 'a') // ra1's child
  const gc = s('shape:gc', 'shape:c', 'a') // ra1's grandchild, via c
  const fixture = [ra1, ra2, rb, c, gc]
  const expected = ['shape:ra1', 'shape:c', 'shape:gc', 'shape:ra2', 'shape:rb']

  // Confirm the expectation itself actually exercises both paths before
  // relying on it: ra1 vs ra2 is a sibling-sort tie-break (case 2's shape),
  // and ra1's subtree [ra1, c, gc] must stay grouped ahead of ra2 (case 3's
  // shape) even though ra1 and ra2 tie on index.
  assert.deepEqual(ids(orderForPaint(fixture, byIdOf(fixture))), expected, 'shuffle fixture: baseline order (input already sorted) is the expected DFS order')

  // Fisher-Yates over a few fixed seeds — deterministic test, no Math.random.
  function shuffled(arr: Shape[], seed: number): Shape[] {
    const out = arr.slice()
    let state = seed
    for (let i = out.length - 1; i > 0; i--) {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      const j = state % (i + 1)
      ;[out[i], out[j]] = [out[j]!, out[i]!]
    }
    return out
  }

  for (const seed of [1, 2, 3, 4, 5, 17, 42]) {
    const permuted = shuffled(fixture, seed)
    const out = orderForPaint(permuted, byIdOf(permuted))
    assert.deepEqual(ids(out), expected, `shuffle seed ${seed}: input order must not affect output`)
  }
}

// --- Cycle safety: a malformed parentId cycle ENTIRELY WITHIN the input set
// (repair.ts is what's normally supposed to prevent this from reaching the
// renderer, but this function must not assume it already ran — same
// discipline the sibling document module's descendantsOf documents for its
// own BFS). Neither
// member satisfies the "parentId not in the input set" root rule, so this
// also exercises the sweep that keeps such shapes from silently vanishing.
// The only HARD requirement is termination (no infinite loop) plus no thrown
// error; both members must still appear exactly once.
{
  const a = s('shape:cyc-a', 'shape:cyc-b', 'a1')
  const bShape = s('shape:cyc-b', 'shape:cyc-a', 'a1')
  const shapes = [a, bShape]
  const out = orderForPaint(shapes, byIdOf(shapes))
  assert.deepEqual(ids(out).sort(), ['shape:cyc-a', 'shape:cyc-b'], 'cycle safety: both cyclic shapes appear exactly once, no throw, no hang')
}

console.log('ok: paint-order')
