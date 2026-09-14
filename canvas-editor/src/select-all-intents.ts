/** Ctrl/Cmd+A "select all" (Task keyboard/K4) -- mirrors the established
 * page-filtered pattern clipboard-intents.ts's `reindexRootsToTop` already
 * uses (`s.parentId === pageId`): every TOP-LEVEL shape on the CURRENT page
 * (editor.get().currentPageId), never a shape on a different page and never
 * a shape nested inside a frame/group (whose parentId is that container's
 * id, not the page's) -- a documented v2 simplification of tldraw's own
 * `editor.selectAll()` (Editor.ts), which additionally narrows to a shared
 * parent when the pre-existing selection already names one. v2 has no such
 * nested-selection-scoping product decision yet, so this always selects
 * every top-level shape on the page, regardless of what (if anything) was
 * selected before.
 *
 * Always returns exactly one SetSelection intent (even `ids: []` on an
 * empty page) -- harmless either way: SetSelection is a view intent
 * (docMutated: false, editor.ts), so it never touches the undo stack. The
 * caller (CanvasV2App.tsx's handleGlobalShortcut) applies it via
 * editor.applyAll(...), same as every other intent-emitting shortcut here.
 *
 * Sorted by fractional index (id as a tiebreak for equal indices) --
 * `doc.listShapes()`'s own order is CRDT-internal, not z-order or insertion
 * order (see canvas-doc's own tests, which always `.sort()` before
 * asserting), so returning it unsorted would make the resulting selection's
 * *contents* correct but its *order* nondeterministic across peers/replays.
 * Mirrors clipboard-intents.ts's `reindexRootsToTop`, the established
 * precedent for this exact sort. */
import type { Editor } from './editor.js'
import type { Intent } from './intents.js'

export function selectAllIntents(editor: Editor): Intent[] {
	const pageId = editor.get().currentPageId
	const ids = editor.doc.listShapes()
		.filter((s) => s.parentId === pageId)
		.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((s) => s.id)
	return [{ type: 'SetSelection', ids }]
}
