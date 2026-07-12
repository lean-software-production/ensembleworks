// @ensembleworks/canvas-react — the thin, logic-free renderer: React 19
// components that READ @ensembleworks/canvas-editor's Editor/ToolContext
// state and DISPATCH normalized input events to a caller-supplied `onInput`
// callback. It never computes intents, never applies canvas-model ops, and
// never imports canvas-editor's tools/* internals except through the public
// package entry (`@ensembleworks/canvas-editor`, exports: { ".": ... } — a
// single barrel, so there IS no subpath to import). Depends only on
// @ensembleworks/canvas-editor + @ensembleworks/canvas-model + react +
// react-dom (enforced by boundary.test.ts). DOM access is fair game here —
// unlike canvas-editor/canvas-model, THIS package's whole job is the DOM.
//
// CALLER OBLIGATIONS (G3, the seam that constructs Editor + ToolContext
// once and passes both down as props):
//   - `toolContext.dispose()` MUST be called on unmount. React strict
//     mode's double-mount, room switches, and HMR all construct fresh
//     contexts, and every undisposed predecessor keeps its doc listener
//     registered forever — see tool-context.ts's dispose() doc comment.
//     Nothing in this package disposes it (the context is caller-owned;
//     ShapeLayer only reads through it).
//   - Viewport's `onViewportBlur` is the abandonment-gap cancel hook —
//     wire it (plus Escape/unmount) to the in-flight-gesture cleanup
//     described in tools/arrow.ts's ABANDONMENT GAP note.
export const CANVAS_REACT_VERSION = 1 as const

export * from './dom-events.js'
export * from './Viewport.js'
export * from './WorldLayer.js'
export * from './Grid.js'
export * from './use-editor-state.js'
export * from './shapeRegistry.js'
export * from './ShapeBody.js'
export * from './ShapeLayer.js'
export * from './TextEditor.js'
export * from './shapes/BoxShape.js'
export * from './Overlay.js'
export * from './overlay/Selection.js'
export * from './overlay/Handles.js'
export * from './overlay/SnapGuides.js'
export * from './overlay/Arrows.js'
export * from './overlay/Cursors.js'
