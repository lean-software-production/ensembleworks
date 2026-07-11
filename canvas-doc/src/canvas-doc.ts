import type { Shape } from '@ensembleworks/canvas-model'

// The engine-agnostic contract. LoroCanvasDoc implements it today; a Yjs-backed
// impl could replace it without touching callers (design's swappability rule).
export interface CanvasDoc {
  listShapes(): Shape[]
  getShape(id: string): Shape | undefined
  putShape(shape: Shape): void
  updateProps(id: string, props: Record<string, unknown>): void
  deleteShape(id: string): void
  reparent(id: string, parentId: string, index?: number): void
  getText(id: string): string
  setText(id: string, text: string): void
  exportSnapshot(): Uint8Array
  exportUpdate(): Uint8Array
  import(bytes: Uint8Array): void
  subscribe(listener: () => void): () => void
  commit(): void
}
