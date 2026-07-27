/**
 * Task U1 (docs/plans/2026-07-22-canvas-v2-pages.md, D-6) — the page
 * switcher: a compact horizontal TAB BAR (the plan's judgment call #1,
 * recommended and accepted), one tab per page in `orderedPages` order, the
 * current page highlighted. v1's `client/src/chrome/PanelPages.tsx` informed
 * the layout (a name, move-left/right, a delete affordance) but is entirely
 * tldraw and not reusable — this is v2's own component wired to the v2
 * intents landed by E1/E3.
 *
 * Thin renderer only: every mutation (switch/create/delete/rename/reorder)
 * is `editor.applyAll(helper(...))` where the helper is one of
 * `page-switcher-dom.ts`'s pure, DOM-free functions (`newPageIntents`/
 * `deletePageIntents`/`movePageIntents`) — this component itself builds no
 * Intent by hand except `RenamePage` (D-3: its math is a bare
 * `{ id, name }` pass-through, no editor read needed, so it has no
 * standalone helper — see that file's module header).
 *
 * Stable hooks for Z1's browser contract (interaction-contracts, next task):
 * `data-canvas-v2-new-page` on the "+" button, `data-canvas-v2-page="<id>"`
 * + `aria-pressed` on each tab.
 */
import type { CSSProperties } from 'react'
import type { CanvasDocument, Page } from '@ensembleworks/canvas-model'
import { orderedPages } from '@ensembleworks/canvas-model'
import type { Editor } from '@ensembleworks/canvas-editor'
import { deletePageIntents, movePageIntents, newPageIntents } from './page-switcher-dom.js'

const barStyle: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	gap: 4,
	padding: '4px 6px',
	borderBottom: '1px solid rgba(15,23,42,0.12)',
	background: '#fafaf7',
	overflowX: 'auto',
}

const tabGroupStyle: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	gap: 2,
	borderRadius: 4,
	border: '1px solid rgba(15,23,42,0.22)',
	overflow: 'hidden',
}

function tabButtonStyle(current: boolean): CSSProperties {
	return {
		padding: '4px 10px',
		border: 'none',
		background: current ? '#004990' : 'transparent',
		color: current ? '#fafaf7' : '#0f172a',
		fontSize: 12,
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	}
}

const microButtonStyle: CSSProperties = {
	padding: '4px 6px',
	border: 'none',
	borderLeft: '1px solid rgba(15,23,42,0.12)',
	background: 'transparent',
	color: '#0f172a',
	fontSize: 11,
	cursor: 'pointer',
	lineHeight: 1,
}

const disabledMicroButtonStyle: CSSProperties = {
	...microButtonStyle,
	color: 'rgba(15,23,42,0.28)',
	cursor: 'default',
}

const newPageButtonStyle: CSSProperties = {
	padding: '4px 10px',
	borderRadius: 4,
	border: '1px solid rgba(15,23,42,0.22)',
	background: 'transparent',
	color: '#0f172a',
	fontSize: 12,
	cursor: 'pointer',
}

export function PageSwitcher({ editor, snapshot, currentPageId }: { readonly editor: Editor; readonly snapshot: CanvasDocument; readonly currentPageId: string }) {
	const pages = orderedPages(snapshot.pages)
	const onlyPage = pages.length <= 1

	function switchTo(page: Page): void {
		if (page.id === currentPageId) return
		editor.applyAll([{ type: 'SetCurrentPage', pageId: page.id }])
	}

	function rename(page: Page): void {
		// Inline rename (D-6): a window.prompt seeded with the current name —
		// RenamePage's math is a bare pass-through (D-3), so it's dispatched
		// directly here rather than through a page-switcher-dom.ts helper.
		const next = window.prompt('Rename page', page.name)
		if (next === null) return
		const trimmed = next.trim()
		if (trimmed.length === 0 || trimmed === page.name) return
		editor.applyAll([{ type: 'RenamePage', id: page.id, name: trimmed }])
	}

	function remove(page: Page): void {
		if (onlyPage) return
		if (!window.confirm(`Delete "${page.name}"? This deletes every shape on it.`)) return
		const intents = deletePageIntents(editor, page.id)
		if (intents.length > 0) editor.applyAll(intents)
	}

	function move(page: Page, dir: 'left' | 'right'): void {
		const intents = movePageIntents(editor, page.id, dir)
		if (intents.length > 0) editor.applyAll(intents)
	}

	function addPage(): void {
		editor.applyAll(newPageIntents(editor))
	}

	return (
		<div style={barStyle} data-canvas-v2-page-switcher>
			{pages.map((page, i) => {
				const current = page.id === currentPageId
				return (
					<span key={page.id} style={tabGroupStyle}>
						<button
							type="button"
							data-canvas-v2-page={page.id}
							aria-pressed={current}
							title="Click to switch pages, double-click to rename"
							onClick={() => switchTo(page)}
							onDoubleClick={() => rename(page)}
							style={tabButtonStyle(current)}
						>
							{page.name}
						</button>
						<button
							type="button"
							aria-label={`Move ${page.name} left`}
							disabled={i === 0}
							onClick={() => move(page, 'left')}
							style={i === 0 ? disabledMicroButtonStyle : microButtonStyle}
						>
							◂
						</button>
						<button
							type="button"
							aria-label={`Move ${page.name} right`}
							disabled={i === pages.length - 1}
							onClick={() => move(page, 'right')}
							style={i === pages.length - 1 ? disabledMicroButtonStyle : microButtonStyle}
						>
							▸
						</button>
						<button
							type="button"
							aria-label={`Delete ${page.name}`}
							disabled={onlyPage}
							onClick={() => remove(page)}
							style={onlyPage ? disabledMicroButtonStyle : microButtonStyle}
						>
							×
						</button>
					</span>
				)
			})}
			<button type="button" data-canvas-v2-new-page aria-label="New page" onClick={addPage} style={newPageButtonStyle}>
				＋
			</button>
		</div>
	)
}
