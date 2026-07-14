// Run: bun src/canvas-v2/bootstrap-page.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { BOOTSTRAP_PAGE_ID, resolvePageId } from './bootstrap-page'

// A brand-new doc has zero pages -> bootstraps BOOTSTRAP_PAGE_ID and commits it.
{
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	assert.equal(doc.listPages().length, 0, 'precondition: a fresh doc has no pages')
	const pageId = resolvePageId(doc)
	assert.equal(pageId, BOOTSTRAP_PAGE_ID)
	assert.equal(doc.listPages().length, 1, 'bootstrap wrote exactly one page')
	assert.equal(doc.listPages()[0]!.id, BOOTSTRAP_PAGE_ID)
	console.log('ok: bootstrap-page — empty doc bootstraps the convention page id')
}

// A doc that already has a page (real content, or a prior bootstrap) keeps
// using the EXISTING canonical page rather than creating a second one.
{
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	doc.putPage({ id: 'page:existing-real-room', name: 'Real Room' })
	doc.commit()
	const pageId = resolvePageId(doc)
	assert.equal(pageId, 'page:existing-real-room', 'resolvePageId adopts the existing page, not the bootstrap literal')
	assert.equal(doc.listPages().length, 1, 'no redundant second page was created')
	console.log('ok: bootstrap-page — existing page is adopted, never duplicated')
}

// Calling resolvePageId twice on the same (already-bootstrapped) doc is
// idempotent — no second page, same answer both times.
{
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	const first = resolvePageId(doc)
	const second = resolvePageId(doc)
	assert.equal(first, second)
	assert.equal(doc.listPages().length, 1, 'a second call does not write a second page')
	console.log('ok: bootstrap-page — idempotent across repeated calls')
}

// Multiple existing pages: canonicalPageId's own rule (lexicographically
// smallest id) decides which one resolvePageId adopts — pinning that this
// module defers to that rule rather than inventing its own tie-break.
{
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	doc.putPage({ id: 'page:zzz', name: 'Z' })
	doc.putPage({ id: 'page:aaa', name: 'A' })
	doc.commit()
	const pageId = resolvePageId(doc)
	assert.equal(pageId, 'page:aaa', 'the lexicographically smallest existing page id wins, matching canonicalPageId')
	assert.equal(doc.listPages().length, 2, 'no page was added or removed')
	console.log('ok: bootstrap-page — defers to canonicalPageId\'s tie-break across multiple existing pages')
}

console.log('ok: bootstrap-page.test.ts — all cases passed')
