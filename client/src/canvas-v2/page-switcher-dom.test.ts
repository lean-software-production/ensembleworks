// Run: bun src/canvas-v2/page-switcher-dom.test.ts
// Task U1 (docs/plans/2026-07-22-canvas-v2-pages.md, D-6) — the pure
// intent-building math `PageSwitcher.tsx` calls: newPageIntents/
// deletePageIntents/movePageIntents/clampCurrentPageIntents. A real
// Editor/LoroCanvasDoc (page-intents.test.ts's own construction pattern),
// FIXED_RANDOM so newPageIntents' minted id is deterministic and assertable.
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { Editor } from '@ensembleworks/canvas-editor'
import { orderedPages, type Page } from '@ensembleworks/canvas-model'
import { clampCurrentPageIntents, deletePageIntents, movePageIntents, newPageIntents } from './page-switcher-dom.js'

const FIXED_RANDOM = () => 0.5

function makeEditor(pages: Page[], currentPageId: string) {
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	for (const p of pages) doc.putPage(p)
	doc.commit()
	const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: currentPageId })
	return { doc, editor }
}

// ============================================================================
// 1. newPageIntents: a CreatePage (new id, index sorting AFTER the max
//    existing) + a SetCurrentPage to that new id.
// ============================================================================
{
	const { doc, editor } = makeEditor(
		[
			{ id: 'page:p', name: 'P', index: 'a0' },
			{ id: 'page:q', name: 'Q', index: 'a1' },
		],
		'page:p',
	)
	const intents = newPageIntents(editor)
	assert.equal(intents.length, 2, 'newPageIntents emits exactly [CreatePage, SetCurrentPage]')
	const create = intents[0] as { type: string; page: { id: string; index?: string } }
	const setCur = intents[1] as { type: string; pageId: string }
	assert.equal(create.type, 'CreatePage', 'first intent is CreatePage')
	assert.equal(setCur.type, 'SetCurrentPage', 'second intent is SetCurrentPage')
	assert.equal(setCur.pageId, create.page.id, 'SetCurrentPage targets the newly minted page id')

	editor.applyAll(intents)
	const ordered = orderedPages(doc.listPages())
	assert.equal(ordered.length, 3, 'the doc now has 3 pages')
	assert.equal(ordered[2]!.id, create.page.id, 'the new page sorts LAST (index after the existing max)')
	console.log('ok: page-switcher-dom — newPageIntents mints a page that sorts after the max existing index')
}

// ============================================================================
// 2. deletePageIntents on the ONLY page: refuses, returns [].
// ============================================================================
{
	const { editor } = makeEditor([{ id: 'page:only', name: 'Only', index: 'a0' }], 'page:only')
	const intents = deletePageIntents(editor, 'page:only')
	assert.deepEqual(intents, [], 'deleting the only page is refused (no DeletePage emitted)')
	console.log('ok: page-switcher-dom — deletePageIntents refuses the only page')
}

// ============================================================================
// 3. deletePageIntents on a NON-current page: [DeletePage] only, no
//    SetCurrentPage.
// ============================================================================
{
	const { editor } = makeEditor(
		[
			{ id: 'page:p', name: 'P', index: 'a0' },
			{ id: 'page:q', name: 'Q', index: 'a1' },
		],
		'page:p',
	)
	const intents = deletePageIntents(editor, 'page:q')
	assert.deepEqual(intents, [{ type: 'DeletePage', id: 'page:q' }], 'deleting a non-current page emits DeletePage only')
	console.log('ok: page-switcher-dom — deletePageIntents on a non-current page emits DeletePage only')
}

// ============================================================================
// 4. deletePageIntents on the CURRENT page: [DeletePage, SetCurrentPage(adj)].
// ============================================================================
{
	const { editor } = makeEditor(
		[
			{ id: 'page:p', name: 'P', index: 'a0' },
			{ id: 'page:q', name: 'Q', index: 'a1' },
			{ id: 'page:r', name: 'R', index: 'a2' },
		],
		'page:q',
	)
	const intents = deletePageIntents(editor, 'page:q')
	assert.deepEqual(
		intents,
		[
			{ type: 'DeletePage', id: 'page:q' },
			{ type: 'SetCurrentPage', pageId: 'page:r' },
		],
		'deleting the CURRENT page batches a follow-up SetCurrentPage onto the adjacent (next) page',
	)
	console.log('ok: page-switcher-dom — deletePageIntents deleting the current page batches SetCurrentPage(adjacent)')
}

// ============================================================================
// 5. movePageIntents('left'/'right') moves the page one slot in orderedPages.
// ============================================================================
{
	const { doc, editor } = makeEditor(
		[
			{ id: 'page:a', name: 'A', index: 'a0' },
			{ id: 'page:b', name: 'B', index: 'a1' },
			{ id: 'page:c', name: 'C', index: 'a2' },
		],
		'page:a',
	)
	// page:b moves left -> should now sort BEFORE page:a.
	const leftIntents = movePageIntents(editor, 'page:b', 'left')
	assert.equal(leftIntents.length, 1, 'movePageIntents yields exactly one ReorderPage')
	assert.equal(leftIntents[0]!.type, 'ReorderPage', 'the intent is a ReorderPage')
	editor.applyAll(leftIntents)
	let ordered = orderedPages(doc.listPages())
	assert.deepEqual(
		ordered.map((p) => p.id),
		['page:b', 'page:a', 'page:c'],
		'moving page:b left swaps it one slot earlier',
	)

	// Move page:c ('page:a','page:c' now adjacent at the tail) left over page:a.
	const leftAgain = movePageIntents(editor, 'page:c', 'left')
	editor.applyAll(leftAgain)
	ordered = orderedPages(doc.listPages())
	assert.deepEqual(
		ordered.map((p) => p.id),
		['page:b', 'page:c', 'page:a'],
		'moving page:c left again swaps it past page:a',
	)

	// Move page:b right -> back past page:c.
	const rightIntents = movePageIntents(editor, 'page:b', 'right')
	editor.applyAll(rightIntents)
	ordered = orderedPages(doc.listPages())
	assert.deepEqual(
		ordered.map((p) => p.id),
		['page:c', 'page:b', 'page:a'],
		'moving page:b right swaps it one slot later',
	)

	// Boundary: the first page can't move left; the last can't move right.
	assert.deepEqual(movePageIntents(editor, 'page:c', 'left'), [], 'the first page cannot move left')
	assert.deepEqual(movePageIntents(editor, 'page:a', 'right'), [], 'the last page cannot move right')
	console.log('ok: page-switcher-dom — movePageIntents moves a page exactly one slot in orderedPages, no-ops at the ends')
}

// ============================================================================
// 6. clampCurrentPageIntents: [] when currentPageId is valid; a
//    SetCurrentPage(canonical) when it names no live page.
// ============================================================================
{
	const { editor: validEditor } = makeEditor(
		[
			{ id: 'page:p', name: 'P', index: 'a0' },
			{ id: 'page:q', name: 'Q', index: 'a1' },
		],
		'page:q',
	)
	assert.deepEqual(clampCurrentPageIntents(validEditor), [], 'a valid currentPageId yields no clamp intent (no spurious SetCurrentPage)')

	// Simulate the undo-strands-currentPageId edge: currentPageId names a
	// page that no longer exists in the doc (e.g. after undoing a CreatePage
	// the switcher had just switched to).
	const { doc, editor: danglingEditor } = makeEditor([{ id: 'page:p', name: 'P', index: 'a0' }], 'page:ghost')
	const clamp = clampCurrentPageIntents(danglingEditor)
	assert.deepEqual(clamp, [{ type: 'SetCurrentPage', pageId: 'page:p' }], 'a dangling currentPageId clamps to the canonical (lexicographically smallest) live page')
	void doc
	console.log('ok: page-switcher-dom — clampCurrentPageIntents no-ops when valid, clamps to canonical when dangling')
}

console.log('ok: page-switcher-dom.test.ts — all cases passed')
