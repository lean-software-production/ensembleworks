// @ensembleworks/canvas-model — the pure typed canvas document model: schema,
// validation, invariants, and spatial-semantics query functions. Zero runtime
// deps but zod; no Loro, no tldraw, no DOM, no Date.now/Math.random/I/O.
// Convention: intra-package relative imports use the `.js` extension
// (nodenext-style; resolves to the .ts source everywhere).
export const CANVAS_MODEL_VERSION = 1 as const
