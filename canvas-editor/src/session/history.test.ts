// Run: bun src/session/history.test.ts
//
// Ported behaviour cases (node:assert, not vitest) from two prior copies of
// this logic: plugins/canvas/tests/page-history-repair.test.ts's
// `historyRepairIntents`/`undoWithRepair`/`redoWithRepair` describe blocks
// (the source-text guard block reading plugins/canvas/canvas/panel/
// session-input.ts is NOT ported — that guard belongs to the plugin's own
// wiring, not this module), and client/src/canvas-v2/page-switcher-dom.
// test.ts's `clampCurrentPageIntents` cases. Editors are built the way
// canvas-editor/src/undo.test.ts does: `LoroCanvasDoc.create({ peerId })` +
// `new Editor({ doc, now, random, pageId })`.
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Page, Shape } from '@ensembleworks/canvas-model'
import { Editor } from '../editor.js'
import { clampCurrentPageIntents, historyRepairIntents, redoWithRepair, undoWithRepair } from './history.js'

const FIXED_RANDOM = () => 0.5

function makeEditor(pages: readonly Page[], currentPageId: string): { doc: LoroCanvasDoc; editor: Editor } {
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	for (const p of pages) doc.putPage(p)
	doc.commit()
	const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: currentPageId })
	return { doc, editor }
}

const livePageIds = (editor: Editor): string[] => editor.doc.listPages().map((p) => p.id as string)

/** A minimal valid geo shape parented onto `parentId`. */
function shape(id: string, parentId: string): Shape {
	return {
		id,
		kind: 'geo',
		parentId: parentId as Shape['parentId'],
		index: 'a0',
		x: 0,
		y: 0,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: { w: 10, h: 10 },
	} as Shape
}

// ============================================================================
// clampCurrentPageIntents (client/src/canvas-v2/page-switcher-dom.test.ts's
// own coverage, ported here since the function itself moved) — [] when
// currentPageId is valid; a SetCurrentPage(canonical) when it names no live
// page.
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

	const { editor: danglingEditor } = makeEditor([{ id: 'page:p', name: 'P', index: 'a0' }], 'page:ghost')
	const clamp = clampCurrentPageIntents(danglingEditor)
	assert.deepEqual(clamp, [{ type: 'SetCurrentPage', pageId: 'page:p' }], 'a dangling currentPageId clamps to the canonical (lexicographically smallest) live page')
	console.log('ok: history — clampCurrentPageIntents no-ops when valid, clamps to canonical when dangling')
}

// ============================================================================
// historyRepairIntents — the page half
// ============================================================================
{
	// "re-homes currentPageId after undoing a '+ new page'"
	const { editor } = makeEditor([{ id: 'page:p', name: 'P', index: 'a0' }], 'page:p')
	editor.applyAll([
		{ type: 'CreatePage', page: { id: 'page:new', name: 'Page 2', index: 'a1' } },
		{ type: 'SetCurrentPage', pageId: 'page:new' },
	])
	assert.notEqual(editor.get().currentPageId, 'page:p', 'precondition: current page switched to the new page')

	undoWithRepair(editor)

	assert.ok(!livePageIds(editor).includes('page:new'), 'the new page is gone after undo')
	assert.ok(livePageIds(editor).includes(editor.get().currentPageId), 'currentPageId re-homes to a page that still exists')
	assert.equal(editor.get().currentPageId, 'page:p', 'currentPageId re-homes to the canonical remaining page')
	console.log('ok: history — historyRepairIntents re-homes currentPageId after undoing a "+ new page"')
}

{
	// "re-homes currentPageId after redoing a DeletePage of the page the user
	// switched back to" — deleting a NON-current page so the redo below is the
	// only thing that can strand the view.
	const { editor } = makeEditor(
		[
			{ id: 'page:a', name: 'A', index: 'a0' },
			{ id: 'page:b', name: 'B', index: 'a1' },
		],
		'page:a',
	)
	editor.apply({ type: 'DeletePage', id: 'page:b' })
	editor.undo()
	editor.apply({ type: 'SetCurrentPage', pageId: 'page:b' })

	redoWithRepair(editor)

	assert.ok(!livePageIds(editor).includes('page:b'), 'page:b is gone after redo')
	assert.ok(livePageIds(editor).includes(editor.get().currentPageId), 'currentPageId re-homes to a page that still exists')
	console.log('ok: history — historyRepairIntents re-homes currentPageId after redoing a DeletePage of the page the user switched back to')
}

{
	// "is silent when the undo touched no page at all"
	const { editor } = makeEditor([{ id: 'page:p', name: 'P', index: 'a0' }], 'page:p')
	editor.apply({ type: 'CreateShape', shape: shape('shape:s', 'page:p') })
	editor.undo()

	assert.deepEqual(historyRepairIntents(editor), [], 'an undo that touched no page/selection state yields no repair intents (no same-value SetCurrentPage churn)')
	console.log('ok: history — historyRepairIntents is silent when the undo touched no page at all')
}

// ============================================================================
// historyRepairIntents — the selection half is still there
// ============================================================================
{
	// "prunes a selection whose shapes the undo removed"
	const { editor } = makeEditor([{ id: 'page:p', name: 'P', index: 'a0' }], 'page:p')
	editor.applyAll([{ type: 'CreateShape', shape: shape('shape:s', 'page:p') }, { type: 'SetSelection', ids: ['shape:s'] }])
	assert.deepEqual([...editor.get().selection], ['shape:s'])

	undoWithRepair(editor)

	assert.deepEqual([...editor.get().selection], [], 'undoWithRepair clears the now-dangling selection')
	console.log('ok: history — historyRepairIntents prunes a selection whose shapes the undo removed')
}

{
	// "emits both repairs together when an undo strands both" — one batch (one
	// undo entry): a new page, a shape on it, and a selection naming that
	// shape. Undoing it strands the selection AND the page.
	const { editor } = makeEditor([{ id: 'page:p', name: 'P', index: 'a0' }], 'page:p')
	editor.applyAll([
		{ type: 'CreatePage', page: { id: 'page:new', name: 'Page 2', index: 'a1' } },
		{ type: 'SetCurrentPage', pageId: 'page:new' },
		{ type: 'CreateShape', shape: shape('shape:s', 'page:new') },
		{ type: 'SetSelection', ids: ['shape:s'] },
	])

	editor.undo()
	const repair = historyRepairIntents(editor)

	assert.deepEqual(repair.map((i) => i.type).sort(), ['SetCurrentPage', 'SetSelection'], 'the undo strands both selection and page, so repair carries both intent types')
	editor.applyAll(repair)
	assert.deepEqual([...editor.get().selection], [])
	assert.ok(livePageIds(editor).includes(editor.get().currentPageId))
	console.log('ok: history — historyRepairIntents emits both repairs together when an undo strands both')
}

// ============================================================================
// undoWithRepair / redoWithRepair — the move and the repair are one call
// ============================================================================
{
	// "does not notify subscribers a second time when nothing dangled" —
	// measured against a plain editor.undo() on an identically-prepared
	// editor, so the assertion does not depend on how many times a bare undo
	// notifies by itself.
	const prepare = () => {
		const { editor } = makeEditor([{ id: 'page:p', name: 'P', index: 'a0' }], 'page:p')
		editor.apply({ type: 'CreateShape', shape: shape('shape:s', 'page:p') })
		return editor
	}

	const bare = prepare()
	let bareCount = 0
	const stopBare = bare.subscribe(() => {
		bareCount += 1
	})
	bare.undo()
	stopBare()

	const repaired = prepare()
	let repairedCount = 0
	const stopRepaired = repaired.subscribe(() => {
		repairedCount += 1
	})
	undoWithRepair(repaired)
	stopRepaired()

	assert.equal(repairedCount, bareCount, 'undoWithRepair notifies no more than a bare undo() when nothing dangled')
	console.log('ok: history — undoWithRepair/redoWithRepair does not notify subscribers a second time when nothing dangled')
}

{
	// "still moves history when there is a repair to apply" — the other half
	// of the same rule: the guard above would also pass for a function that
	// did nothing at all.
	const { editor } = makeEditor([{ id: 'page:p', name: 'P', index: 'a0' }], 'page:p')
	editor.applyAll([
		{ type: 'CreatePage', page: { id: 'page:new', name: 'Page 2', index: 'a1' } },
		{ type: 'SetCurrentPage', pageId: 'page:new' },
	])

	undoWithRepair(editor)

	assert.ok(!livePageIds(editor).includes('page:new'))
	assert.equal(editor.get().currentPageId, 'page:p')

	redoWithRepair(editor)

	assert.ok(livePageIds(editor).includes('page:new'))
	assert.ok(livePageIds(editor).includes(editor.get().currentPageId))
	console.log('ok: history — undoWithRepair/redoWithRepair still moves history when there is a repair to apply')
}

console.log('ok: history.test.ts — all cases passed')
