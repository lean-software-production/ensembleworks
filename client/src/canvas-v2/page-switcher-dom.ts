/**
 * Task U1 (docs/plans/2026-07-22-canvas-v2-pages.md, D-6) — the pure
 * intent-building MATH the `PageSwitcher` component's handlers call, kept
 * DOM-free and unit-testable, mirroring `tool-loop.ts`'s
 * `pruneDanglingSelectionIntents`/`deleteSelectionIntents` idiom (read the
 * editor, return an `Intent[]`, let the caller `editor.applyAll(...)` it —
 * this module never calls `applyAll` itself). `RenamePage`'s math is a bare
 * pass-through (`{ type: 'RenamePage', id, name }`, no editor read needed),
 * so — deliberately, per the plan's file list — it has no helper here and
 * is dispatched directly from `PageSwitcher.tsx`.
 */
import { canonicalPageId, generateKeyBetween, orderedPages, type Page, type PageId } from '@ensembleworks/canvas-model'
import type { Editor, Intent } from '@ensembleworks/canvas-editor'

/** Mint a page id the same DOM-edge way `image-create.ts`'s clipboard/create
 * siblings mint shape/asset ids elsewhere in this file's neighborhood — this
 * module draws its randomness from `editor.random()` (not `crypto` directly)
 * so it stays trivially testable against the FIXED_RANDOM convention every
 * other `canvas-editor`/`canvas-v2` intent-builder test already uses (see
 * `clipboard-intents.ts`'s `mintShapeId`/`mintBindingId`, the same idea). */
function mintPageId(editor: Editor): PageId {
	return `page:${Math.floor(editor.random() * 1e9).toString(36)}`
}

/** "+ new page" (D-6): mint a fresh `Page` whose `index` sorts AFTER every
 * existing page (`generateKeyBetween(maxIndex, null)` — the same
 * append-at-the-end idiom `image-create.ts`'s `topIndex` and
 * `reorder-intents.ts`'s `toFront` use), then batch `CreatePage` +
 * `SetCurrentPage` in ONE `applyAll` call (create AND switch, one commit —
 * tldraw parity, D-6). */
export function newPageIntents(editor: Editor): Intent[] {
	const ordered = orderedPages(editor.doc.listPages())
	const maxIndex = ordered.length > 0 ? (ordered[ordered.length - 1]!.index ?? null) : null
	const page: Page = {
		id: mintPageId(editor),
		name: `Page ${ordered.length + 1}`,
		index: generateKeyBetween(maxIndex, null),
	}
	return [
		{ type: 'CreatePage', page },
		{ type: 'SetCurrentPage', pageId: page.id },
	]
}

/** Delete a page (D-6): refuses the doc's only page (no-op — `DeletePage`
 * itself also refuses this, but refusing HERE means the caller never emits
 * a doomed intent, and the mutant table pins this at the helper level too).
 * An unknown id is likewise a tolerant no-op (never throws — the applyAll
 * TOLERANCE CONTRACT, D-3). When the page being deleted IS the current page,
 * batches a follow-up `SetCurrentPage` onto an adjacent page (the next page
 * in `orderedPages`, falling back to the previous one when deleting the
 * last page in the list) so `currentPageId` never dangles even before the
 * undo-clamp (`clampCurrentPageIntents`) would catch it. */
export function deletePageIntents(editor: Editor, id: string): Intent[] {
	const pages = editor.doc.listPages()
	if (pages.length <= 1) return []
	const ordered = orderedPages(pages)
	const i = ordered.findIndex((p) => p.id === id)
	if (i === -1) return []

	const intents: Intent[] = [{ type: 'DeletePage', id }]
	if (editor.get().currentPageId === id) {
		const adjacent = ordered[i + 1] ?? ordered[i - 1]
		if (adjacent) intents.push({ type: 'SetCurrentPage', pageId: adjacent.id })
	}
	return intents
}

export type MoveDir = 'left' | 'right'

/** Reorder one slot (D-6, D-4): recompute `id`'s fractional `index` to sit
 * between its NEW neighbors, exactly v1 `PanelPages`'s `onMoveUp`/
 * `onMoveDown` `getIndexBetween` pattern (`client/src/chrome/PanelPages.tsx`)
 * — moving left inserts between the page two-before and the page
 * immediately-before (which `id` is swapping past); moving right is the
 * mirror. A no-op at either end of `orderedPages` (already first/last) or
 * on an unknown id — never throws. */
export function movePageIntents(editor: Editor, id: string, dir: MoveDir): Intent[] {
	const ordered = orderedPages(editor.doc.listPages())
	const i = ordered.findIndex((p) => p.id === id)
	if (i === -1) return []

	if (dir === 'left') {
		if (i === 0) return []
		const prev = ordered[i - 1]!
		const prevPrev = ordered[i - 2]
		const index = generateKeyBetween(prevPrev?.index ?? null, prev.index ?? null)
		return [{ type: 'ReorderPage', id, index }]
	}

	if (i === ordered.length - 1) return []
	const next = ordered[i + 1]!
	const nextNext = ordered[i + 2]
	const index = generateKeyBetween(next.index ?? null, nextNext?.index ?? null)
	return [{ type: 'ReorderPage', id, index }]
}

/** Undo-clamp (D-6, D-3): `SetCurrentPage` is a view intent with no undo
 * inverse (D-2), so undoing a `CreatePage`+`SetCurrentPage` batch removes
 * the page but leaves `currentPageId` still naming it — the render filter
 * (R1) would then show an empty canvas. Mirrors `tool-loop.ts`'s
 * `pruneDanglingSelectionIntents`: read the CURRENT `currentPageId` live,
 * and only when it names no LIVE page, emit a `SetCurrentPage` onto the
 * canonical page (`canonicalPageId` — the lexicographically-smallest page
 * id, `repair.ts`'s convergent choice, reused here rather than inventing a
 * second "pick a fallback page" rule). Returns `[]` (no spurious
 * `SetCurrentPage`) whenever `currentPageId` already names a live page — a
 * normal undo/redo that never touched the current page must not re-dispatch
 * a same-value SetCurrentPage on every call. */
export function clampCurrentPageIntents(editor: Editor): Intent[] {
	const pages = editor.doc.listPages()
	const current = editor.get().currentPageId
	if (pages.some((p) => p.id === current)) return []
	const canonical = canonicalPageId(pages)
	if (canonical === undefined) return []
	return [{ type: 'SetCurrentPage', pageId: canonical }]
}
