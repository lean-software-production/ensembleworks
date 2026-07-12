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
export const CANVAS_REACT_VERSION = 1 as const

export * from './dom-events.js'
export * from './Viewport.js'
export * from './WorldLayer.js'
export * from './Grid.js'
