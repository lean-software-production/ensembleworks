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
  | { kind: 'setText'; id: string; text: string }

const KINDS = ['note', 'geo', 'frame', 'group'] as const
const COLORS = ['red', 'blue', 'green', 'yellow'] as const
const TEXT_WORDS = ['hello', 'world', 'lorem', 'ipsum', 'canvas', 'sync', 'loro', 'agent', 'note', 'frame'] as const

// How often a generated shape / prop edit carries STRUCTURED content instead
// of an empty record. With all-empty props/meta (the rig's original
// fixtures), nested/multi-key data never flowed through winner election,
// dedupe, per-op prop merges, or the invariant checks at all — this closes
// that gap. Scope honesty (mutation-probed at 500 seeds): this does NOT make
// the rig catch a de-sorted stableStringify, and structurally cannot — Loro's
// value marshaling normalizes key order deterministically and IDENTICALLY on
// every peer (probe: writer inserts z,a,m; writer and all importers read
// back z,m,a), so every rig comparison sees byte-identical inputs either
// way. The key sort is pinned by canvas-model's unit assertion; its
// end-to-end justification is cross-REPRESENTATION comparison — a
// Loro-marshaled object vs one built in original insertion order outside
// Loro (the ShadowMirror tldraw-vs-mirror path that already cost one bug) —
// which no single-engine rig exercises.
const RICH_CONTENT_RATE = 0.3

// Op-mix thresholds: one draw r = rng() per loop turn, matched against these
// CUMULATIVE upper bounds in order (each band's probability is the gap to the
// previous bound). Rationale per band:
const RATE_CYCLE_PAIR = 0.05 //       5% — hostile reparent-into-each-other burst: rare enough not to dominate, frequent enough that ~every batch has one
const RATE_DELETE_THEN_BIND = 0.1 //  5% — hostile delete-then-bind burst: seeds the dangling-binding repair path
const RATE_CYCLE_SELF_DESC = 0.15 //  5% — hostile reparent-to-own-descendant burst: the single-shape phrasing of the cycle guard
const RATE_PUT_SHAPE = 0.5 //        35% — putShape dominates: creation/overwrite churn is what makes the tiny shared id pool collide across peers
const RATE_SET_TEXT = 0.65 //        15% — setText: a MEANINGFUL slice (not a token 1%) so the LoroText write surface (concurrent same-shape text edits, garbage/vanished-id tolerance) gets real volume, same as updateProps does for props
const RATE_UPDATE_PROPS = 0.8 //     15% — concurrent same-shape prop edits (the LWW-per-key case) need real volume
const RATE_REPARENT = 0.9 //         10% — plain reparents keep the tree topology moving between the hostile bursts
const RATE_DELETE_SHAPE = 0.96 //     6% — deletes stay below creations so docs grow rather than empty out
// remaining 4% — binding ops, split 50/50 put/delete by a second draw

/** ~RICH_CONTENT_RATE of the time: multi-key props with a nested object and
 * an array — the shapes of data stableStringify must serialize
 * key-order-insensitively (objects) yet order-sensitively (arrays). All
 * values PRNG-drawn, so determinism holds. Kind-agnostic on purpose: every
 * KINDS entry's schema is a looseObject, extra keys pass through. */
function randomProps(rng: Rng): Record<string, unknown> {
  if (rng() >= RICH_CONTENT_RATE) return {}
  const props: Record<string, unknown> = {
    color: pick(rng, COLORS),
    size: { w: int(rng, 800), h: int(rng, 600) },
    tags: [`t${int(rng, 5)}`, `t${int(rng, 5)}`],
  }
  if (rng() < 0.5) props.z = int(rng, 10)
  return props
}

/** Same idea for meta (carried verbatim by the model — z.record). */
function randomMeta(rng: Rng): Record<string, unknown> {
  if (rng() >= RICH_CONTENT_RATE) return {}
  return { origin: pick(rng, ['agent', 'user', 'import'] as const), rev: int(rng, 100) }
}

/** A short, deterministic (PRNG-drawn, no Math.random), variable-length body
 * for setText — 1-4 words plus a distinguishing numeric suffix so two draws
 * are very unlikely to collide, which matters for the text-convergence check
 * (a real edit, not a fixed placeholder). */
function randomText(rng: Rng): string {
  const n = 1 + int(rng, 4)
  const words: string[] = []
  for (let i = 0; i < n; i++) words.push(pick(rng, TEXT_WORDS))
  return `${words.join(' ')} #${int(rng, 1_000_000)}`
}

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
    meta: randomMeta(rng),
    props: randomProps(rng),
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
 * - putShape / updateProps / reparent / deleteShape / putBinding / deleteBinding / setText
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
    if (r < RATE_CYCLE_PAIR && idPool.shapeIds.length >= 2) {
      const a = creatableId(rng, idPool, deletedThisBatch)
      const b = otherCreatableId(rng, idPool, a, deletedThisBatch)
      const aPage = pick(rng, idPool.pageIds)
      ops.push({ kind: 'putShape', shape: randomShape(rng, a, aPage) })
      ops.push({ kind: 'putShape', shape: randomShape(rng, b, a) }) // b under a
      ops.push({ kind: 'reparent', id: a, parentId: b }) // attempt a under b: cycle, must be rejected
      deletedThisBatch.delete(a); deletedThisBatch.delete(b)
      parentOf.set(a, aPage); parentOf.set(b, a) // the rejected reparent(a, b) is deliberately NOT mirrored
    } else if (r < RATE_DELETE_THEN_BIND) {
      const deletedId = pick(rng, idPool.shapeIds)
      const fromId = otherId(rng, idPool, deletedId)
      ops.push({ kind: 'deleteShape', id: deletedId })
      markDeletedWithCascade(deletedId, deletedThisBatch, parentOf)
      ops.push({
        kind: 'putBinding',
        binding: { id: pick(rng, idPool.bindingIds) as Binding['id'], fromId: fromId as Binding['fromId'], toId: deletedId as Binding['toId'], props: {}, meta: {} },
      })
    } else if (r < RATE_CYCLE_SELF_DESC && idPool.shapeIds.length >= 2) {
      const parent = creatableId(rng, idPool, deletedThisBatch)
      const child = otherCreatableId(rng, idPool, parent, deletedThisBatch)
      const parentPage = pick(rng, idPool.pageIds)
      ops.push({ kind: 'putShape', shape: randomShape(rng, parent, parentPage) })
      ops.push({ kind: 'putShape', shape: randomShape(rng, child, parent) }) // child under parent
      ops.push({ kind: 'reparent', id: parent, parentId: child }) // parent under its own child: cycle
      deletedThisBatch.delete(parent); deletedThisBatch.delete(child)
      parentOf.set(parent, parentPage); parentOf.set(child, parent) // rejected reparent NOT mirrored
    } else if (r < RATE_PUT_SHAPE) {
      const id = creatableId(rng, idPool, deletedThisBatch)
      const parentId = randomParentTarget(rng, idPool)
      ops.push({ kind: 'putShape', shape: randomShape(rng, id, parentId) })
      deletedThisBatch.delete(id)
      parentOf.set(id, parentId)
    } else if (r < RATE_SET_TEXT) {
      // Mostly an existing pool id, so this is a real text edit (the case the
      // convergence check below needs volume on); sometimes an id THIS batch
      // has already deleted (vanished — Loro tombstoned its text container,
      // see loro-canvas-doc.ts's deleteNode); occasionally a pure-garbage id
      // that was never in the pool at all. Both non-pool cases exercise
      // setText's silent-no-op contract (canvas-doc.ts: "Silent no-op if no
      // shape with this id exists"), same tolerance deleteShape already
      // honors — see the fuzz test for the crash-safety half of that claim.
      const roll = rng()
      const id =
        roll < 0.85 ? pick(rng, idPool.shapeIds)
        : roll < 0.93 && deletedThisBatch.size > 0 ? pick(rng, [...deletedThisBatch])
        : `shape:garbage-${int(rng, 1_000_000)}`
      ops.push({ kind: 'setText', id, text: randomText(rng) })
    } else if (r < RATE_UPDATE_PROPS) {
      const id = pick(rng, idPool.shapeIds)
      // A distinguishing scalar always; structured nested content at the
      // same RICH_CONTENT_RATE as randomShape (see randomProps' comment for
      // why the nesting is load-bearing coverage, not decoration).
      ops.push({ kind: 'updateProps', id, props: { tag: int(rng, 1_000_000), ...randomProps(rng) } })
    } else if (r < RATE_REPARENT) {
      const id = pick(rng, idPool.shapeIds)
      const parentId = randomParentTarget(rng, idPool)
      ops.push({ kind: 'reparent', id, parentId })
      parentOf.set(id, parentId) // best-effort: some of these throw on a cycle at runtime (superset, safe)
    } else if (r < RATE_DELETE_SHAPE) {
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
      case 'setText': doc.setText(op.id, op.text); break
    }
  } catch {
    stats.skipped++
  }
}
