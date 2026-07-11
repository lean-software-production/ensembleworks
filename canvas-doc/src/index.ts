// @ensembleworks/canvas-doc — the CRDT document engine. Wraps Loro behind our
// own CanvasDoc interface so the backend stays swappable (Yjs is the sanctioned
// fallback). Depends only on @ensembleworks/canvas-model + loro-crdt; never
// imports from server.
export const CANVAS_DOC_VERSION = 1 as const

export * from './canvas-doc.js'
export * from './loro-canvas-doc.js'
