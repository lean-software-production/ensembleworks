import type { Binding, Page, RepairOp, Shape, ShapeKind } from '@ensembleworks/canvas-model'

/** Result of applying a remote update. `pending` is true when some received
 * ops depend on history this doc hasn't seen yet — the caller should follow
 * up with a sync request (send versionBytes() to the source peer).
 * `changed` is true iff the import newly applied at least one op; a no-op
 * import (all ops already known to this doc) reports `changed: false`, so
 * callers can skip downstream work (repair, rebroadcast) that only matters
 * when state actually moved. */
export interface ImportResult { pending: boolean; changed: boolean }

/** A locally-originated write this doc REFUSED to apply because the resulting
 * shape would fail canvas-model's `validateShape` — i.e. exactly what
 * `repair()` would later judge a `validProps` violation and act on. Reported
 * rather than thrown: a throw from a write escapes `Editor.applyAll`'s
 * un-try/caught intent loop and strands that batch's earlier mutations
 * uncommitted (see the plan's decision D1). `error` is the verbatim zod
 * message. */
export interface InvalidWrite {
  op: 'putShape' | 'updateProps'
  /** The shape's `kind`. Carried as its own field because `id` is a nanoid —
   * meaningless across sessions and not greppable — and because `error` only
   * names the kind on the props-refinement path. An ENVELOPE failure (bad
   * `index`, missing `x`) produces a zod message that never mentions it, which
   * is exactly when you most want to know which tool was emitting what.
   *
   * Narrowed rather than `string` so a consumer's `switch` gets exhaustiveness,
   * with `'<unknown>'` as an explicit arm instead of a `default` that silently
   * absorbs both "malformed" and "a kind we forgot to handle" — different
   * situations a dashboard should distinguish.
   *
   * The narrowing is only honest because `rejectWrite` COERCES this centrally
   * (it takes the offending value, not a caller-derived kind): every call site
   * is reaching into an already-invalid value, so a caller-supplied kind would
   * be exactly where garbage — a number, an object — would enter. */
  kind: ShapeKind | '<unknown>'
  id: string
  error: string
}

/** Sink for InvalidWrite reports, injected at doc construction. When none is
 * supplied the doc warns on the console instead — a rejection is never
 * silent. */
export type InvalidWriteHandler = (write: InvalidWrite) => void

// The engine-agnostic contract. LoroCanvasDoc implements it today; a Yjs-backed
// impl could replace it without touching callers (design's swappability rule).
export interface CanvasDoc {
  listShapes(): Shape[]
  getShape(id: string): Shape | undefined
  /**
   * Upsert: creates the shape if the id is new, otherwise overwrites its fields.
   * Throws if placement would create a cycle (existing shape upserted under its
   * own descendant); no fields are modified in that case. Asymmetry every
   * implementation must preserve: putShape TOLERATES a parentId naming a
   * not-yet-loaded shape (the node falls back to root; the parentId field is
   * retained for a later reparent pass), whereas reparent THROWS on an unknown
   * parent.
   *
   * REJECTS (total no-op, no throw) a shape that fails canvas-model's
   * validateShape — the same predicate repair() judges by — reporting it via
   * the implementation's invalid-write hook. A local writer can therefore no
   * longer originate the state repair() is obliged to destroy. Remote ops
   * arriving through import(), or shapes loaded from a pre-boundary snapshot,
   * bypass this entirely; repair() remains the defence there.
   */
  putShape(shape: Shape): void
  /**
   * Merges `props` into the shape's existing props. Silent no-op if no shape
   * with this id exists.
   *
   * REJECTS (total no-op, no throw) a patch whose MERGED result would fail
   * canvas-model's validateShape, reporting it via the implementation's
   * invalid-write hook. Validation runs on the merge, not the patch — so
   * a patch that heals an already-invalid shape is accepted — but only if the
   * shape's invalidity is in its PROPS. validateShape checks the whole
   * envelope, so a shape whose envelope is invalid (e.g. opacity: 'opaque',
   * reachable only via import()) can never be prop-updated again: every patch
   * is refused. Defensible, since such a shape is dropShape-doomed anyway.
   */
  updateProps(id: string, props: Record<string, unknown>): void
  /**
   * Silent no-op if no shape with this id exists. Cascades: deletes the shape's
   * entire subtree in the real Loro tree — any shape whose ancestry passes
   * through `id` (e.g. a frame's children) is deleted too, and every deleted
   * shape's text container is cleared (no resurrection if the id is reused).
   *
   * This cascade is intentional and unchanged: an EXPLICIT delete means to take
   * the contents — deleting a frame deletes what is in it. It is NOT the
   * behaviour repair() dropped; repair()'s automatic response to an invalid
   * prop removes only the offending shape and rescues its children. The
   * asymmetry between the two is deliberate, not a bug.
   */
  deleteShape(id: string): void
  /**
   * Silent no-op if no shape with this id exists. Throws if `parentId` names a
   * shape that does not exist, or if the move would create a cycle (rejected by
   * the engine's native cycle guard) — in both throw cases the shape's data is
   * left unchanged.
   */
  reparent(id: string, parentId: string, index?: number): void
  /** Returns '' if no shape with this id exists (or it has no text set yet). */
  getText(id: string): string
  /** Silent no-op if no shape with this id exists. */
  setText(id: string, text: string): void
  /** Upsert a binding by id into the top-level bindings map. */
  putBinding(binding: Binding): void
  /** Silent no-op if the binding id is absent. */
  deleteBinding(id: string): void
  listBindings(): Binding[]
  /** Upsert a page by id into the top-level pages map. */
  putPage(page: Page): void
  /** Silent no-op if the page id is absent. */
  deletePage(id: string): void
  listPages(): Page[]
  exportSnapshot(): Uint8Array
  /**
   * Without sinceVersion: exports the whole history (as before). With
   * sinceVersion — bytes from another peer's versionBytes() — exports only
   * the ops that peer is missing, so peers can converge incrementally
   * instead of re-shipping a full snapshot on every sync.
   */
  exportUpdate(sinceVersion?: Uint8Array): Uint8Array
  /** This doc's current oplog version, encoded for handing to a peer so it can
   * ask for (or compute) a delta against it. */
  versionBytes(): Uint8Array
  /**
   * Apply update bytes from a peer. `pending: true` means some received ops
   * depend on history this doc hasn't seen yet — follow up with a sync
   * request (send versionBytes() to the source peer) to fill the gap.
   */
  import(bytes: Uint8Array): ImportResult
  /**
   * Compute the deterministic repairPlan (canvas-model) from this doc's own
   * converged state and apply it: reparent orphans/cycle members to the
   * canonical page root (lexicographically smallest page id — see
   * canonicalPageId), delete dangling bindings, and drop shapes with invalid
   * props — removing ONLY the offending shape, never its subtree (one bad prop
   * must not execute a container's innocent contents, and Loro tombstones make
   * that loss unrecoverable). Each child of a dropped shape is rescued, not
   * deleted: a LOGICAL child (its stored parentId names the dropped shape) is
   * rehomed to the root of the page the dropped shape was already on — its
   * pageAncestorId, falling back to the canonical page ONLY when that chain
   * dead-ends or cycles (owner ruling 11: a rescued child may shift position
   * but must not change page) — and a merely-PHYSICAL tree child is lifted
   * clear of Loro's delete cascade the same way. A binding whose endpoint is a
   * dropped shape dies in the same pass (it is not dangling when the plan is
   * computed, so no deleteBinding op names it — sweeping it here is what lets
   * ONE pass converge). Pure function of the converged model, so every peer
   * that calls repair() on the same state computes and applies the identical
   * plan — no coordination needed. Idempotent: calling repair() again on an
   * already-clean doc returns []. Zero-page docs: orphans are unrepairable (no
   * target page) — the violation is left standing rather than looping on a
   * non-converging op; dropShape is suppressed by the same rule, so a childless
   * invalid shape stays invalid until a page exists. The returned array is the
   * plan as computed, not a full change log — the bindings swept because an
   * endpoint dropped, and the children rehomed off a dropped parent, are side
   * effects of the dropShape ops and are not themselves itemized. Caller must
   * commit() after to persist.
   */
  repair(): RepairOp[]
  subscribe(listener: () => void): () => void
  /**
   * Fires with the encoded bytes of each locally-committed change (not
   * changes arriving via import() from elsewhere — no echo loop), the
   * sync-transport hook: forward the bytes to peers so they can import() an
   * incremental delta instead of re-shipping a snapshot.
   */
  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void
  commit(): void
}
