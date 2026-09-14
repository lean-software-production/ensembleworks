// The undo/redo history-repair helpers now live in canvas-editor's session
// module (canvas-editor/src/session/history.ts); this re-export keeps old import paths working.
export { historyRepairIntents, undoWithRepair, redoWithRepair } from "@ensembleworks/canvas-editor";
