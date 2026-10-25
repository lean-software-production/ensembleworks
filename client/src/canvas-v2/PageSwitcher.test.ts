// Run: bun src/canvas-v2/PageSwitcher.test.ts
// Task U1 (docs/plans/2026-07-22-canvas-v2-pages.md, D-6) — component
// render/click coverage for the page switcher tab bar. Same rig as
// dev-overlay-metrics.test.ts (happy-dom globals installed BEFORE any
// react-dom/client import, IS_REACT_ACT_ENVIRONMENT + act() for
// deterministic flushing) — lighter than CanvasV2App.test.ts's full
// sync-session mount: PageSwitcher only needs a real Editor/LoroCanvasDoc
// (image-create.test.ts's own `editor.applyAll` CAPTURE-while-delegating
// pattern), not a live SyncClientPeer/SyncServerPeer pair.
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

const win = new Window()
;(globalThis as any).window = win
;(globalThis as any).document = win.document
;(globalThis as any).navigator = win.navigator
;(globalThis as any).location = win.location
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { LoroCanvasDoc, dumpModel } = await import('@ensembleworks/canvas-doc')
const { Editor } = await import('@ensembleworks/canvas-editor')
const { PageSwitcher } = await import('./PageSwitcher.js')
type Intent = import('@ensembleworks/canvas-editor').Intent
type Editor = import('@ensembleworks/canvas-editor').Editor
type Page = import('@ensembleworks/canvas-model').Page
type LoroCanvasDocT = ReturnType<typeof LoroCanvasDoc.create>

function makeEditor(pages: Page[], currentPageId: string) {
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	for (const p of pages) doc.putPage(p)
	doc.commit()
	const editor: Editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: currentPageId })
	const batches: (readonly Intent[])[] = []
	const realApplyAll = editor.applyAll.bind(editor)
	editor.applyAll = (intents: readonly Intent[]) => {
		batches.push(intents)
		realApplyAll(intents)
	}
	return { doc, editor, batches }
}

function mount(editor: Editor, doc: LoroCanvasDocT, currentPageId: string) {
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	const render = () =>
		act(async () => {
			root.render(createElement(PageSwitcher, { editor, snapshot: dumpModel(doc), currentPageId }))
		})
	return { container, root, render }
}

async function main() {
	// ==========================================================================
	// 1. Renders one tab per page (orderedPages order), the current page
	//    marked via aria-pressed + data-canvas-v2-page.
	// ==========================================================================
	{
		const { doc, editor } = makeEditor(
			[
				{ id: 'page:p', name: 'Alpha', index: 'a0' },
				{ id: 'page:q', name: 'Beta', index: 'a1' },
			],
			'page:q',
		)
		const { container, root, render } = mount(editor, doc, 'page:q')
		await render()

		const tabs = Array.from(container.querySelectorAll('[data-canvas-v2-page]')) as HTMLButtonElement[]
		assert.equal(tabs.length, 2, 'one tab rendered per page')
		assert.equal(tabs[0]!.getAttribute('data-canvas-v2-page'), 'page:p', 'tabs render in orderedPages order (Alpha first)')
		assert.equal(tabs[1]!.getAttribute('data-canvas-v2-page'), 'page:q', 'Beta is the second tab')
		assert.equal(tabs[0]!.getAttribute('aria-pressed'), 'false', 'the non-current tab is not marked pressed')
		assert.equal(tabs[1]!.getAttribute('aria-pressed'), 'true', 'the CURRENT page (page:q) is marked aria-pressed')
		assert.ok(container.querySelector('[data-canvas-v2-new-page]'), 'the "+ new page" control is present')

		await act(async () => root.unmount())
		container.remove()
		console.log('ok: PageSwitcher — renders one tab per page in order, marks the current page')
	}

	// ==========================================================================
	// 2. Clicking a non-current tab dispatches editor.applyAll([SetCurrentPage]).
	// ==========================================================================
	{
		const { doc, editor, batches } = makeEditor(
			[
				{ id: 'page:p', name: 'Alpha', index: 'a0' },
				{ id: 'page:q', name: 'Beta', index: 'a1' },
			],
			'page:p',
		)
		const { container, root, render } = mount(editor, doc, 'page:p')
		await render()

		const target = container.querySelector('[data-canvas-v2-page="page:q"]') as HTMLButtonElement
		assert.ok(target, 'the Beta tab exists')
		await act(async () => target.click())

		assert.deepEqual(batches, [[{ type: 'SetCurrentPage', pageId: 'page:q' }]], 'clicking a tab dispatches exactly one applyAll([SetCurrentPage(thatId)]) batch')

		await act(async () => root.unmount())
		container.remove()
		console.log('ok: PageSwitcher — clicking a tab dispatches SetCurrentPage(thatId)')
	}

	// ==========================================================================
	// 3. Clicking "+ new page" dispatches applyAll([CreatePage, SetCurrentPage]).
	// ==========================================================================
	{
		const { doc, editor, batches } = makeEditor([{ id: 'page:p', name: 'Alpha', index: 'a0' }], 'page:p')
		const { container, root, render } = mount(editor, doc, 'page:p')
		await render()

		const addBtn = container.querySelector('[data-canvas-v2-new-page]') as HTMLButtonElement
		assert.ok(addBtn, 'the "+ new page" button exists')
		await act(async () => addBtn.click())

		assert.equal(batches.length, 1, 'exactly one applyAll batch fired')
		const batch = batches[0]! as ReadonlyArray<{ type: string }>
		assert.equal(batch.length, 2, 'the batch carries [CreatePage, SetCurrentPage]')
		assert.equal(batch[0]!.type, 'CreatePage', 'first intent is CreatePage')
		assert.equal(batch[1]!.type, 'SetCurrentPage', 'second intent is SetCurrentPage')
		assert.equal(doc.listPages().length, 2, 'the new page actually landed in the doc')

		await act(async () => root.unmount())
		container.remove()
		console.log('ok: PageSwitcher — clicking "+ new page" dispatches CreatePage + SetCurrentPage')
	}

	console.log('ok: PageSwitcher.test.ts — all cases passed')
}

main()
	.catch((err) => {
		console.error(err)
		process.exit(1)
	})
	.finally(() => {
		process.exit(0)
	})
