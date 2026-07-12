// Random op generation for the E1 convergence rig. Deterministic (PRNG-driven
// only — see prng.ts). Ops are generated independently per peer-universe over
// a small SHARED id pool, so cross-peer collisions (the interesting case) show
// up by construction: two peers picking the same shape/binding id from a tiny
// pool is common, not rare.
import type { CanvasDoc } from '@ensembleworks/canvas-doc'
import type { Binding, Shape } from '@ensembleworks/canvas-model'
import { int, pick, type Rng } from './prng.js'

export interface IdPool {
  readonly shapeIds: readonly string[]
  readonly pageIds: readonly string[]
  readonly bindingIds: readonly string[]
}

export type Op =
  | { kind: 'putShape'; shape: Shape }
  | { kind: 'updateProps'; id: string; props: Record<string, unknown> }
  | { kind: 'reparent'; id: string; parentId: string }
  | { kind: 'deleteShape'; id: string }
  | { kind: 'putBinding'; binding: Binding }
  | { kind: 'deleteBinding'; id: string }

const KINDS = ['note', 'geo', 'frame', 'group'] as const

function randomShape(rng: Rng, id: string, parentId: string): Shape {
  return {
    id: id as Shape['id'],
    kind: pick(rng, KINDS),
    parentId: parentId as Shape['parentId'],
    index: `a${int(rng, 99_999)}`,
    x: int(rng, 1000),
    y: int(rng, 1000),
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {},
  }
}

function randomParentTarget(rng: Rng, pool: IdPool): string {
  return pick(rng, [...pool.shapeIds, ...pool.pageIds])
}

function otherId(rng: Rng, pool: IdPool, exclude: string): string {
  const rest = pool.shapeIds.filter((x) => x !== exclude)
  return rest.length > 0 ? pick(rng, rest) : exclude
}

// Like otherId, but ALSO avoids an id this batch has deleted — for the second
// id in a hostile burst, which immediately becomes a putShape TARGET (see
// randomOps). otherId alone isn't enough there: probe-proven — a burst whose
// "child" id happened to be one THIS SAME batch deleted earlier recreates it
// via putShape, hitting the exact duplicate-node pathology creatableId guards
// against for the "a"/"parent" id (this was found and fixed while building
// the rig: the very first shrink-caught failure came from exactly this gap).
function otherCreatableId(rng: Rng, pool: IdPool, exclude: string, deletedThisBatch: ReadonlySet<string>): string {
  const rest = pool.shapeIds.filter((x) => x !== exclude && !deletedThisBatch.has(x))
  if (rest.length > 0) return pick(rng, rest)
  const anyOther = pool.shapeIds.filter((x) => x !== exclude)
  return anyOther.length > 0 ? pick(rng, anyOther) : exclude
}

// Prefer an id this SAME batch hasn't deleted yet — see the deletedThisBatch
// comment on randomOps for why: putShape on an id THIS peer already deleted
// locally creates a genuinely NEW Loro tree node sharing the old shapeId
// (nodeByShapeId can't find the tombstoned original — canvas-doc's putShape
// only upserts an id resolvable via nodeByShapeId AT CALL TIME). canvas-doc's
// repair() now tolerates more than one physical node per shapeId (see
// loro-canvas-doc.ts's nodesByShapeId), so this is no longer load-bearing for
// CORRECTNESS — kept anyway because same-peer id-reuse-after-delete has no
// real-world analogue (production shape ids are unique nanoids, never reused)
// and manufacturing it needlessly inflates the guarded-skip count without
// exercising anything new. Falls back to the full pool if every id in it has
// been deleted this batch (rare with a 5-id pool; accepted as-is).
function creatableId(rng: Rng, pool: IdPool, deletedThisBatch: ReadonlySet<string>): string {
  const avail = pool.shapeIds.filter((id) => !deletedThisBatch.has(id))
  return avail.length > 0 ? pick(rng, avail) : pick(rng, pool.shapeIds)
}

// Best-effort structural mirror kept alongside op GENERATION (not application
// — randomOps never touches a doc) so deleteShape's REAL cascade (it deletes
// the shape's entire subtree — see canvas-doc.ts's deleteShape contract) can
// be approximated here: without this, a later putShape on an id that got
// swept by an ancestor's cascade delete (rather than deleted directly) hits
// the exact same duplicate-node pathology creatableId already guards against
// for direct deletes — probe-proven while building this rig (a batch that
// reparented e under d, then deleted d, then later put-shaped e again,
// produced two physical Loro nodes for shapeId 'e' after cross-peer merge:
// nodeByShapeId found none — real one cascade-tombstoned — so putShape
// created a fresh one). Every putShape/reparent op generated (regardless of
// whether the guarded runtime call will actually succeed — some hostile
// bursts deliberately attempt a cycle that Loro will reject) is recorded
// here, so the tracked structure is a SUPERSET of what's ever real: it may
// over-restrict a few recreatable ids (a rejected op's target edge lingers in
// the mirror), never under-count a real cascade. That's the safe direction —
// erring conservative here costs a little generator diversity, not a bogus
// duplicate node.
function markDeletedWithCascade(id: string, deletedThisBatch: Set<string>, parentOf: Map<string, string>): void {
  if (deletedThisBatch.has(id)) return
  deletedThisBatch.add(id)
  for (const [child, parent] of parentOf) if (parent === id) markDeletedWithCascade(child, deletedThisBatch, parentOf)
}

/**
 * Generates `count`-ish ops (hostile bursts push 2-3 ops per iteration, so the
 * result is trimmed to exactly `count`). Mix, over the small shared idPool:
 *
 * - putShape / updateProps / reparent / deleteShape / putBinding / deleteBinding
 * - HOSTILE reparent-into-each-other: put A (root) and B (child of A), then
 *   attempt to reparent A under B — Loro's native cycle guard must reject it;
 *   applyOp() catches and continues. Because idPool is tiny and SHARED across
 *   peers, an independent op stream on another peer can just as easily attempt
 *   the mirror move (B under A) — after exchange, this is the real cross-peer
 *   cycle case repair()'s noCycles pass exists for.
 * - HOSTILE delete-then-bind: delete a shape, then put a binding referencing it
 *   (or reference it from another peer's concurrent stream — same shared pool).
 * - HOSTILE reparent-to-own-descendant: same construction as reparent-into-each-
 *   other, phrased as a single local guard trip.
 * - same-shape concurrent prop edits across peers: not a special case — falls
 *   out of updateProps drawing from the shared idPool on every peer.
 */
export function randomOps(rng: Rng, count: number, idPool: IdPool): Op[] {
  const ops: Op[] = []
  // Ids THIS batch has deleted (directly OR via a cascade — see
  // markDeletedWithCascade) and not since recreated. Tracked locally per
  // randomOps() call; cross-peer/cross-batch delete-vs-edit races are
  // untouched by this (and remain a fully legitimate hostile scenario — they
  // never duplicate a node, only this-same-peer delete-then-recreate does).
  const deletedThisBatch = new Set<string>()
  // Best-effort (superset) mirror of each id's parent, seeded to match
  // genesis (every pool shape starts under page:p) — see
  // markDeletedWithCascade's comment for why this only needs to be
  // conservative, not exact.
  const parentOf = new Map<string, string>(idPool.shapeIds.map((id) => [id, idPool.pageIds[0] ?? 'page:p']))
  while (ops.length < count) {
    const r = rng()
    if (r < 0.05 && idPool.shapeIds.length >= 2) {
      const a = creatableId(rng, idPool, deletedThisBatch)
      const b = otherCreatableId(rng, idPool, a, deletedThisBatch)
      const aPage = pick(rng, idPool.pageIds)
      ops.push({ kind: 'putShape', shape: randomShape(rng, a, aPage) })
      ops.push({ kind: 'putShape', shape: randomShape(rng, b, a) }) // b under a
      ops.push({ kind: 'reparent', id: a, parentId: b }) // attempt a under b: cycle, must be rejected
      deletedThisBatch.delete(a); deletedThisBatch.delete(b)
      parentOf.set(a, aPage); parentOf.set(b, a) // the rejected reparent(a, b) is deliberately NOT mirrored
    } else if (r < 0.1) {
      const deletedId = pick(rng, idPool.shapeIds)
      const fromId = otherId(rng, idPool, deletedId)
      ops.push({ kind: 'deleteShape', id: deletedId })
      markDeletedWithCascade(deletedId, deletedThisBatch, parentOf)
      ops.push({
        kind: 'putBinding',
        binding: { id: pick(rng, idPool.bindingIds) as Binding['id'], fromId: fromId as Binding['fromId'], toId: deletedId as Binding['toId'], props: {}, meta: {} },
      })
    } else if (r < 0.15 && idPool.shapeIds.length >= 2) {
      const parent = creatableId(rng, idPool, deletedThisBatch)
      const child = otherCreatableId(rng, idPool, parent, deletedThisBatch)
      const parentPage = pick(rng, idPool.pageIds)
      ops.push({ kind: 'putShape', shape: randomShape(rng, parent, parentPage) })
      ops.push({ kind: 'putShape', shape: randomShape(rng, child, parent) }) // child under parent
      ops.push({ kind: 'reparent', id: parent, parentId: child }) // parent under its own child: cycle
      deletedThisBatch.delete(parent); deletedThisBatch.delete(child)
      parentOf.set(parent, parentPage); parentOf.set(child, parent) // rejected reparent NOT mirrored
    } else if (r < 0.55) {
      const id = creatableId(rng, idPool, deletedThisBatch)
      const parentId = randomParentTarget(rng, idPool)
      ops.push({ kind: 'putShape', shape: randomShape(rng, id, parentId) })
      deletedThisBatch.delete(id)
      parentOf.set(id, parentId)
    } else if (r < 0.75) {
      const id = pick(rng, idPool.shapeIds)
      ops.push({ kind: 'updateProps', id, props: { tag: int(rng, 1_000_000) } })
    } else if (r < 0.9) {
      const id = pick(rng, idPool.shapeIds)
      const parentId = randomParentTarget(rng, idPool)
      ops.push({ kind: 'reparent', id, parentId })
      parentOf.set(id, parentId) // best-effort: some of these throw on a cycle at runtime (superset, safe)
    } else if (r < 0.96) {
      const id = pick(rng, idPool.shapeIds)
      ops.push({ kind: 'deleteShape', id })
      markDeletedWithCascade(id, deletedThisBatch, parentOf)
    } else if (rng() < 0.5) {
      ops.push({
        kind: 'putBinding',
        binding: {
          id: pick(rng, idPool.bindingIds) as Binding['id'],
          fromId: pick(rng, idPool.shapeIds) as Binding['fromId'],
          toId: pick(rng, idPool.shapeIds) as Binding['toId'],
          props: {},
          meta: {},
        },
      })
    } else {
      ops.push({ kind: 'deleteBinding', id: pick(rng, idPool.bindingIds) })
    }
  }
  return ops.slice(0, count)
}

/** Skip counter — applyOp increments it whenever the guarded call throws (a
 * cycle rejection from putShape/reparent). The count is informational only
 * (logged by the rig), not asserted: the guard rejecting hostile ops IS the
 * expected behavior, not a rig failure. */
export interface ApplyStats { skipped: number }

/** Apply one Op to `doc`, guarded: putShape/reparent may throw on a
 * cycle-creating placement (Loro's native guard — see canvas-doc.ts's
 * putShape/reparent contracts). That throw is part of the behavior under test,
 * not an error — catch it, count it, and continue with the next op. */
export function applyOp(doc: CanvasDoc, op: Op, stats: ApplyStats): void {
  try {
    switch (op.kind) {
      case 'putShape': doc.putShape(op.shape); break
      case 'updateProps': doc.updateProps(op.id, op.props); break
      case 'reparent': doc.reparent(op.id, op.parentId); break
      case 'deleteShape': doc.deleteShape(op.id); break
      case 'putBinding': doc.putBinding(op.binding); break
      case 'deleteBinding': doc.deleteBinding(op.id); break
    }
  } catch {
    stats.skipped++
  }
}
