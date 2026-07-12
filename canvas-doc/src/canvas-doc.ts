import type { Binding, Page, RepairOp, Shape } from '@ensembleworks/canvas-model'

/** Result of applying a remote update. `pending` is true when some received
 * ops depend on history this doc hasn't seen yet — the caller should follow
 * up with a sync request (send versionBytes() to the source peer).
 * `changed` is true iff the import newly applied at least one op; a no-op
 * import (all ops already known to this doc) reports `changed: false`, so
 * callers can skip downstream work (repair, rebroadcast) that only matters
 * when state actually moved. */
export interface ImportResult { pending: boolean; changed: boolean }

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
   */
  putShape(shape: Shape): void
  /** Silent no-op if no shape with this id exists. */
  updateProps(id: string, props: Record<string, unknown>): void
  /**
   * Silent no-op if no shape with this id exists. Cascades: deletes the shape's
   * entire subtree in the real Loro tree — any shape whose ancestry passes
   * through `id` (e.g. a frame's children) is deleted too, and every deleted
   * shape's text container is cleared (no resurrection if the id is reused).
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
   * canonicalPageId), delete dangling bindings, drop shapes with invalid
   * props (cascades to their subtree AND to bindings whose endpoint drops in
   * the same pass). Pure function of the converged model, so every peer that
   * calls repair() on the same state computes and applies the identical plan
   * — no coordination needed. Idempotent: calling repair() again on an
   * already-clean doc returns []. Zero-page docs: orphans are unrepairable
   * (no target page) — the violation is left standing rather than looping on
   * a non-converging op. The returned array is the plan as computed, not a
   * full change log — shapes and bindings removed only via cascade (not named
   * in the plan) are not itemized. Caller must commit() after to persist.
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
