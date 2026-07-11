import type { Binding, Page, Shape } from '@ensembleworks/canvas-model'

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
  exportUpdate(): Uint8Array
  import(bytes: Uint8Array): void
  subscribe(listener: () => void): () => void
  commit(): void
}
