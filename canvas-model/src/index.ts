// @ensembleworks/canvas-model — the pure typed canvas document model: schema,
// validation, invariants, and spatial-semantics query functions. Zero runtime
// deps but zod; no Loro, no tldraw, no DOM, no Date.now/Math.random/I/O.
// Convention: intra-package relative imports use the `.js` extension
// (nodenext-style; resolves to the .ts source everywhere).
export const CANVAS_MODEL_VERSION = 1 as const

export * from './ids.js'
export * from './shape.js'
export * from './document.js'
export * from './invariants.js'
export * from './repair.js'
export * from './geometry.js'
export * from './spatial-index.js'
export * from './snapping.js'
export * from './arrow-route.js'
export * from './draw-geometry.js'
export * from './neighbors.js'
export * from './cluster.js'
export * from './semantic.js'
export * from './clipboard.js'
export * from './fractional-index.js'
export * from './paint-order.js'
