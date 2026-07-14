// Shared house helpers for driving a REAL new-engine (canvas-editor/
// canvas-react) dogfood session in a real browser — used by both
// tests/canvas-v2.spec.ts (Task H2) and perf/canvas-v2-perf.spec.ts (Task
// H3), so the "how do I get a booted v2 session and click a known world
// point" logic lives in exactly one place. Every caller navigates with
// `?engine=v2` (client/src/engine.ts's URL override) — never the `team`
// room, which is HARD-EXCLUDED from ever resolving to v2 regardless.
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/** Every helper here places shapes/clicks at SCREEN points relative to
 * `[data-canvas-v2-viewport]`'s own bounding box — dom-events.ts's
 * COORDINATES note: canvas-react's screen space is VIEWPORT-relative
 * (subtracts the viewport element's own getBoundingClientRect()), and the
 * Editor's camera starts at the fixed default `{x:0, y:0, z:1}`
 * (canvas-editor/src/editor.ts) for a fresh session — an identity transform
 * — so a screen point IS the corresponding world point too, with no camera
 * math needed, as long as nothing has panned/zoomed yet. */
export const ANCHOR = { x: 300, y: 220 } as const

export async function viewportBox(page: Page) {
	const box = await page.locator('[data-canvas-v2-viewport]').boundingBox()
	if (!box) throw new Error('[data-canvas-v2-viewport] has no bounding box — did the v2 session fail to boot?')
	return box
}

/** Waits for the v2 session to boot (toolbar visible == window.__ew is set —
 * CanvasV2Session, which renders the toolbar, only mounts once CanvasV2App's
 * boot() has already called `setSession`, and `window.__ew` is assigned
 * synchronously just before that same call — see CanvasV2App.tsx's
 * CONSTRUCTION SEQUENCE step 7). */
export async function waitForBoot(page: Page) {
	await expect(page.locator('[data-canvas-v2-tool="select"]')).toBeVisible({ timeout: 15_000 })
}

/** Click the `note` tool, then click ANCHOR (viewport-relative) to
 * click-create a note (canvas-editor/src/tools/create.ts: a sub-threshold
 * click, not a drag, centers a default-size shape ON the click point), then
 * switch back to the `select` tool (so a later drag/double-click in the same
 * test can pick it up — the note tool stays active after a click-create
 * otherwise, tool-loop.ts's TOOL-SWITCHING MODEL). Returns the created
 * shape's id (read off the rendered `data-shape-id`, not guessed). */
export async function createNoteAt(page: Page, box: { x: number; y: number }): Promise<string> {
	await page.locator('[data-canvas-v2-tool="note"]').click()
	await page.mouse.click(box.x + ANCHOR.x, box.y + ANCHOR.y)
	await page.locator('[data-canvas-v2-tool="select"]').click()
	const shape = page.locator('[data-shape-kind="note"]')
	await expect(shape).toBeVisible({ timeout: 10_000 })
	const id = await shape.getAttribute('data-shape-id')
	if (!id) throw new Error('created note has no data-shape-id')
	return id
}

/** Bulk-seeds `n` note shapes in a uniform grid directly through the live
 * doc (`window.__ew.doc.putShape` + one `commit()`), bypassing pointer
 * events entirely — Task H3's seeding choice (see canvas-v2-perf.spec.ts's
 * own SEEDING note for the client-vs-server tradeoff this resolved).
 * Requires the session to already be booted (waitForBoot). `offset` shifts
 * the WHOLE grid by `(offset, offset)` world units — the default `0` puts
 * the first shape's top-left AT the world origin, which is also screen
 * (0,0) at a fresh session's identity camera (lib/canvas-v2.ts's COORDINATES
 * note); a marquee scenario that needs an EMPTY point to start its drag from
 * (a pointerdown that lands ON a shape starts a translate-drag instead of a
 * marquee — canvas-editor/src/tools/select.ts's FSM) should pass a
 * non-zero `offset` so the screen origin stays clear of every seeded shape. */
export async function seedGrid(page: Page, n: number, offset = 0): Promise<void> {
	await page.evaluate(
		({ count, offset }) => {
			const ew = (window as unknown as { __ew: { editor: { pageId: string }; doc: { putShape(s: unknown): void; commit(): void } } }).__ew
			const pageId = ew.editor.pageId
			const cols = Math.ceil(Math.sqrt(count))
			for (let i = 0; i < count; i++) {
				ew.doc.putShape({
					id: `shape:seed-${i}`,
					kind: 'note',
					parentId: pageId,
					index: 'a1',
					x: offset + (i % cols) * 260,
					y: offset + Math.floor(i / cols) * 260,
					rotation: 0,
					isLocked: false,
					opacity: 1,
					meta: {},
					props: {},
				})
			}
			ew.doc.commit()
		},
		{ count: n, offset },
	)
}
