import type { Shape } from '@ensembleworks/canvas-model'

// The engine-agnostic contract. LoroCanvasDoc implements it today; a Yjs-backed
// impl could replace it without touching callers (design's swappability rule).
export interface CanvasDoc {
  listShapes(): Shape[]
  getShape(id: string): Shape | undefined
  /** Upsert: creates the shape if the id is new, otherwise overwrites its fields. */
  putShape(shape: Shape): void
  /** Silent no-op if no shape with this id exists. */
  updateProps(id: string, props: Record<string, unknown>): void
  /** Silent no-op if no shape with this id exists. */
  deleteShape(id: string): void
  /** Silent no-op if no shape with this id exists. */
  reparent(id: string, parentId: string, index?: number): void
  getText(id: string): string
  /** Silent no-op if no shape with this id exists. */
  setText(id: string, text: string): void
  exportSnapshot(): Uint8Array
  exportUpdate(): Uint8Array
  import(bytes: Uint8Array): void
  subscribe(listener: () => void): () => void
  commit(): void
}
