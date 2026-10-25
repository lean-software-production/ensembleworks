// Undo/redo plus the repair both hosts need afterwards: history can strand a
// selection on deleted shapes, or leave currentPageId pointing at a page the
// undo removed. Previously duplicated in client/src/canvas-v2 and
// plugins/canvas/canvas/pages.
import { canonicalPageId } from '@ensembleworks/canvas-model'
import type { Editor } from '../editor.js'
import type { Intent } from '../intents.js'
import { pruneDanglingSelectionIntents } from './tool-loop.js'

/** A SetCurrentPage back to the canonical page when currentPageId no longer
 * names a page in the doc; otherwise nothing. */
export function clampCurrentPageIntents(editor: Editor): Intent[] {
  const pages = editor.doc.listPages()
  const current = editor.get().currentPageId
  if (pages.some((p) => p.id === current)) return []
  const canonical = canonicalPageId(pages)
  if (canonical === undefined) return []
  return [{ type: 'SetCurrentPage', pageId: canonical }]
}

/** Everything a history move can strand: dangling selection ids, then a
 * dangling current page. */
export function historyRepairIntents(editor: Editor): Intent[] {
  return [...pruneDanglingSelectionIntents(editor), ...clampCurrentPageIntents(editor)]
}

function applyRepair(editor: Editor): void {
  const repair = historyRepairIntents(editor)
  if (repair.length > 0) editor.applyAll(repair)
}

export function undoWithRepair(editor: Editor): void {
  editor.undo()
  applyRepair(editor)
}

export function redoWithRepair(editor: Editor): void {
  editor.redo()
  applyRepair(editor)
}
