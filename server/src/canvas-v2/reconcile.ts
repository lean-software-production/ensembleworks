/**
 * Reconcile — diff-apply a freshly-converted CanvasDocument into a
 * LoroCanvasDoc, touching only what changed. Shadow mode (Task D2) reconciles
 * on every tick; applying the whole model every time via bridge.ts's
 * loadModel would churn the CRDT (every shape re-put every tick, forever).
 *
 * PLAN-BUG FOUND + FIXED (see reconcile.test.ts case 4 for the reproducing
 * test): the plan's code sketch computed `current` ONCE via dumpModel(doc)
 * before the delete loop, then used that same pre-delete snapshot as the
 * put loop's "did this shape change" baseline. deleteShape() CASCADES via the
 * real Loro tree — deleting a parent tombstones every descendant's real node,
 * including a descendant that SURVIVES in `target` (just reparented, e.g. to
 * a grandparent or the page root after its direct parent was removed). If
 * that survivor's envelope is otherwise byte-identical to its pre-delete
 * self, the stale `current` map reports "unchanged" and the put loop would
 * skip it — silently losing a shape that no longer has any Loro node at all.
 * Fix: recompute the put loop's baseline from the doc AFTER the delete loop
 * runs (`doc.listShapes()`), not from the pre-delete `current` snapshot. Any
 * shape whose real node got cascade-tombstoned is then absent from that
 * baseline, so it unconditionally re-puts (full envelope, so it's not a
 * partial write) regardless of whether its OWN fields "changed".
 *
 * Cycle-guard note: putShape/reparent can throw if `target` names a
 * cycle (converted tldraw data should never produce one, but reconcile does
 * not defend against a hostile shape here). Controller-ratified choice:
 * let it propagate — a mirror tick failing loudly beats silently applying a
 * partial diff. ShadowMirror (D2) wraps tick() and counts the failure.
 */
import { isDeepStrictEqual } from 'node:util'
import type { CanvasDocument, Shape } from '@ensembleworks/canvas-model'
import { dumpModel, type LoroCanvasDoc } from '@ensembleworks/canvas-doc'

/**
 * Bring `doc` (Loro) into line with `target` (freshly converted from tldraw),
 * touching only what changed. Returns a small change summary for metrics.
 * `puts`/`deletes` count SHAPES only (pages/bindings are small whole-record
 * sets, unconditionally upserted/deleted every call — see the plan's Task D1
 * semantics note) — this is the plan's chosen definition, kept as-is.
 * `refused` counts shape puts the write boundary rejected as a no-op (see
 * `putShape`'s validation) — a PER-CALL delta, not the doc's lifetime
 * `invalidWriteCount`. A refused shape is never written: it stays absent from
 * `doc` if it never landed, or keeps its stale mirrored value if it did, and
 * every later call retries it: `reconcile` cannot converge on a target that
 * carries a shape the model schema rejects. That is a correct,
 * visible consequence of refusing to write invalid data, not a bug — folding
 * it into `puts` would hide it as indistinguishable ordinary churn.
 * One commit() at the end.
 *
 * Absent-parent tolerance: a target shape whose parentId names a shape absent
 * from `target` inherits putShape's bulk-load tolerance — its real Loro node
 * parks at the tree root while data.parentId retains the missing id (the
 * pre-existing LoroCanvasDoc split-brain-avoidance behavior; see
 * placeInTree's comment). This is deterministic and idempotent, and it IS
 * reachable here: shadow consumes arbitrary live-room data, and fromTldraw
 * drops unknown shape types, which can orphan a surviving child's parentId.
 */
export function reconcile(doc: LoroCanvasDoc, target: CanvasDocument): { puts: number; deletes: number; refused: number } {
	const current = dumpModel(doc)
	const curShapesBefore = new Map(current.shapes.map((s) => [s.id, s]))
	const tgtShapes = new Map(target.shapes.map((s) => [s.id, s]))

	let puts = 0
	let deletes = 0

	// Deletes first (frees parents; also frees up any id target wants to reuse).
	for (const id of curShapesBefore.keys()) {
		if (!tgtShapes.has(id)) {
			doc.deleteShape(id)
			deletes++
		}
	}

	// Recompute the put-loop baseline from the doc AFTER deletes — see the
	// module doc comment above. A shape cascade-tombstoned by a deleted
	// ancestor is now absent here even though it was present in `current`, so
	// it correctly falls into the `!prev` (unconditional re-put) branch below.
	const curShapesAfter = new Map(doc.listShapes().map((s) => [s.id, s]))

	// Puts in depth order (parents before children) so a freshly-recreated
	// parent's node exists by the time a resurrected child is placed under it.
	const ordered = [...tgtShapes.values()].sort((a, b) => depth(target, a.id) - depth(target, b.id))
	// Bracket the put loop with the doc's rejection counter so a REFUSED write
	// is distinguishable from a completed one. Without this, `puts` counts both
	// and a room carrying a shape the write boundary refuses reports a nonzero
	// delta on every tick forever — reconcile cannot converge on it, and the
	// shadow divergence signal never clears. That is not a regression (the old
	// behaviour wrote it and let repair() cascade-delete the subtree), but it
	// changes what the dashboard MEANS, so it must be legible rather than
	// silently folded into `puts`.
	//
	// invalidWriteCount is a monotonic LIFETIME total, so `refused` must be a
	// delta: the shadow mirror reconciles the same doc every tick, and the raw
	// counter would grow without bound while the per-tick truth stayed 1.
	// Bracketing the loop rather than the whole function is deliberate — no
	// write outside it can reject today, and this stays correct if one ever can.
	const refusedBefore = doc.invalidWriteCount
	for (const s of ordered) {
		const prev = curShapesAfter.get(s.id)
		if (!prev || !shallowEqualShape(prev, s)) {
			doc.putShape(s)
			puts++
		}
	}
	const refused = doc.invalidWriteCount - refusedBefore
	puts -= refused // a refusal is not a put

	// Pages + bindings: whole-record upsert/delete, unconditionally (small
	// sets; no diffing needed, and — unlike shapes — nothing cascades them).
	const curP = new Map(current.pages.map((p) => [p.id, p]))
	const tgtP = new Map(target.pages.map((p) => [p.id, p]))
	for (const id of curP.keys()) if (!tgtP.has(id)) doc.deletePage(id)
	for (const p of tgtP.values()) doc.putPage(p)

	const curB = new Map(current.bindings.map((b) => [b.id, b]))
	const tgtB = new Map(target.bindings.map((b) => [b.id, b]))
	for (const id of curB.keys()) if (!tgtB.has(id)) doc.deleteBinding(id)
	for (const b of tgtB.values()) doc.putBinding(b)

	doc.commit()
	return { puts, deletes, refused }
}

function depth(doc: CanvasDocument, id: string, guard = 0): number {
	const s = doc.byId.get(id)
	if (!s || !s.parentId.startsWith('shape:') || guard > 50) return 0
	return 1 + depth(doc, s.parentId, guard + 1)
}

// Envelope + deep props/meta equality. props/meta MUST be compared
// order-independently (isDeepStrictEqual, NOT JSON.stringify): Loro's
// tree-node data map does not round-trip JS object key insertion order
// (probe: set {n,color,z,b} → get {n,z,b,color}), so a stringify comparison
// against the dumped mirror re-puts every 2+-key shape on every tick forever
// — permanent churn on an unchanged target (reconcile.test.ts case 6 pins
// this). `kind` is compared too (ratified ruling: reconcile's contract is
// bring-in-line; no carve-out for "kind never changes in real tldraw").
function shallowEqualShape(a: Shape, b: Shape): boolean {
	return (
		a.kind === b.kind &&
		a.parentId === b.parentId &&
		a.index === b.index &&
		a.x === b.x &&
		a.y === b.y &&
		a.rotation === b.rotation &&
		a.isLocked === b.isLocked &&
		a.opacity === b.opacity &&
		isDeepStrictEqual(a.props, b.props) &&
		isDeepStrictEqual(a.meta, b.meta)
	)
}

