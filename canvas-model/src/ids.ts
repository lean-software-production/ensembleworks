// Branded id helpers. Ids are the verbatim tldraw ids ("shape:…", "page:…",
// "binding:…") so the model round-trips losslessly and v2 responses reference
// the same ids agents already hold.
export type ShapeId = `shape:${string}`
export type PageId = `page:${string}`
export type BindingId = `binding:${string}`
export type ParentId = ShapeId | PageId

export const isShapeId = (s: string): s is ShapeId => s.startsWith('shape:')
export const isPageId = (s: string): s is PageId => s.startsWith('page:')
export const isBindingId = (s: string): s is BindingId => s.startsWith('binding:')
export const parentKind = (id: string): 'shape' | 'page' | 'other' =>
  isShapeId(id) ? 'shape' : isPageId(id) ? 'page' : 'other'
