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
/** Task D6: seeds ONE `terminal` shape directly through the live doc (the
 * SAME `putShape` + `commit()` mechanism as `seedGrid` above), at a SCREEN
 * point (identity-camera 1:1 with world — see `seedGrid`'s COORDINATES
 * note). This is the ONLY way to get a terminal into a v2 room's doc for
 * this rig: `/api/canvas/shape` (lib/seed.ts's `shape()`) writes the OLD
 * tldraw store — a disjoint plane from this room's Loro doc (see
 * tests/canvas-v2.spec.ts's own module header on the two disjoint "v2"
 * features) — and there is no live terminal gateway in this rig to drive a
 * real click-to-create through the terminal tool. `props.title` is a plain
 * doc prop (TerminalShape.tsx's `terminalContentFrom`), rendered and synced
 * with no live gateway/xterm connection required — the title bar, rename
 * input, and drag handler all mount regardless of connection state (verified
 * before this unit's spec was written: the terminal shape renders its title
 * bar with no gateway present, just a "Connecting…"/"reconnecting" overlay
 * over the xterm body). Requires the session to already be booted
 * (waitForBoot). Returns the created shape's id. */
export async function seedTerminal(
	page: Page,
	opts: { x: number; y: number; w?: number; h?: number; title?: string; sessionId?: string },
): Promise<string> {
	const id = `shape:e2e-terminal-${Math.random().toString(36).slice(2, 10)}`
	await page.evaluate(
		({ id, x, y, w, h, title, sessionId }) => {
			const ew = (window as unknown as { __ew: { editor: { pageId: string }; doc: { putShape(s: unknown): void; commit(): void } } }).__ew
			ew.doc.putShape({
				id,
				kind: 'terminal',
				parentId: ew.editor.pageId,
				index: 'a1',
				x,
				y,
				rotation: 0,
				isLocked: false,
				opacity: 1,
				meta: {},
				props: { w, h, sessionId, title, fontSize: 16 },
			})
			ew.doc.commit()
		},
		{ id, x: opts.x, y: opts.y, w: opts.w ?? 480, h: opts.h ?? 320, title: opts.title ?? 'e2e-terminal', sessionId: opts.sessionId ?? 'e2e-term' },
	)
	return id
}

/** Task D6 (optional file-viewer rev-bump coverage): seeds ONE `file-viewer`
 * shape the same doc-level way as `seedTerminal` above. `path` need not
 * resolve to a real file — the `rev`-bump write-path (FileViewerShape.tsx's
 * `fileViewerRefreshIntent`) is what this proves, not the iframe's actual
 * content load. Returns the created shape's id. */
export async function seedFileViewer(page: Page, opts: { x: number; y: number; w?: number; h?: number; path?: string; title?: string }): Promise<string> {
	const id = `shape:e2e-fileviewer-${Math.random().toString(36).slice(2, 10)}`
	await page.evaluate(
		({ id, x, y, w, h, path, title }) => {
			const ew = (window as unknown as { __ew: { editor: { pageId: string }; doc: { putShape(s: unknown): void; commit(): void } } }).__ew
			ew.doc.putShape({
				id,
				kind: 'file-viewer',
				parentId: ew.editor.pageId,
				index: 'a1',
				x,
				y,
				rotation: 0,
				isLocked: false,
				opacity: 1,
				meta: {},
				props: { w, h, path, title, rev: 0 },
			})
			ew.doc.commit()
		},
		{ id, x: opts.x, y: opts.y, w: opts.w ?? 720, h: opts.h ?? 540, path: opts.path ?? 'e2e-smoke.txt', title: opts.title ?? 'e2e-file-viewer' },
	)
	return id
}

/** Task D6 (the drag-at-zoom case): dispatches a `SetCamera` intent directly
 * against THIS client's own Editor (bypassing the wheel-driven zoom gesture
 * canvas-editor/src/camera.ts's `applyWheel` normally computes from) —
 * `editor.applyAll` (the SAME call `ShapeBodyProps.dispatch` itself is —
 * CanvasV2App.tsx's `dispatch = useCallback((intents) => editor.applyAll(intents), …)`)
 * is exposed on `window.__ew.editor`, so this is a real, in-contract camera
 * change, not a DOM/CSS hack. `camera` is editor-LOCAL state (never
 * persisted to the CRDT — editor.ts's EditorState doc comment), so this ONLY
 * affects the calling page's own rendering/hit-testing; a peer's camera is
 * unaffected — exactly the per-client independence a real user's own
 * scroll-zoom would have. */
export async function setCameraZoom(page: Page, z: number): Promise<void> {
	await page.evaluate((z) => {
		const ew = (
			window as unknown as {
				__ew: { editor: { get(): { camera: { x: number; y: number; z: number } } }; doc: unknown } & {
					editor: { applyAll(intents: readonly unknown[]): void }
				}
			}
		).__ew
		const cam = ew.editor.get().camera
		ew.editor.applyAll([{ type: 'SetCamera', x: cam.x, y: cam.y, z }])
	}, z)
}

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

/** Task G1 (Seam G, dense-seed perf scenario): seeds `n` note shapes packed
 * INTO the default 1280×720 viewport, unlike `seedGrid` above (whose fixed
 * 260px spacing spreads shapes out — Phase-3 found that ShapeLayer's
 * viewport culling (canvas-react/src/ShapeLayer.tsx's `queryViewport`) then
 * keeps render cost FLAT at any n, because most shapes sit off-screen no
 * matter the count — the exact reason the existing pan/zoom@n scenario
 * can't show degradation). Density here comes from `props.scale` (a note's
 * rendered box is `200*scale × (200+growY)*scale` — canvas-model/src/
 * geometry.ts's `size()`), NOT from shrunk w/h props — a note has no w/h
 * props at all, only the uniform `scale` multiplier — so this shrinks the
 * SAME rich note body (Seam C's colored sticky, not a BoxShape placeholder)
 * rather than swapping in a different, cheaper-to-render kind.
 *
 * The grid's column/row count is chosen so the packed shapes exactly tile
 * the viewport's own aspect ratio (`cols/rows ≈ viewportW/viewportH`), and
 * each cell's side is `min(cellW, cellH)` — so the whole n-shape grid's
 * footprint is `cols·cellW × rows·cellH`, which by construction is
 * `viewportW × viewportH`: at the session's default identity camera (no
 * pan/zoom yet — see `ANCHOR`'s COORDINATES note), essentially every seeded
 * shape lands ON-SCREEN, not just a handful. Requires the session to
 * already be booted (`waitForBoot`). Returns the shape ids actually
 * seeded — callers that want the ACTUAL on-screen count should query the
 * DOM directly (culling is ShapeLayer's decision, not this seeder's), which
 * is exactly what canvas-v2-perf.spec.ts's dense scenario does. */
export async function seedDense(page: Page, n: number, viewport: { w: number; h: number } = { w: 1280, h: 720 }): Promise<string[]> {
	return page.evaluate(
		({ count, viewportW, viewportH }) => {
			const ew = (window as unknown as { __ew: { editor: { pageId: string }; doc: { putShape(s: unknown): void; commit(): void } } }).__ew
			const pageId = ew.editor.pageId
			const aspect = viewportW / viewportH
			const cols = Math.max(1, Math.ceil(Math.sqrt(count * aspect)))
			const rows = Math.max(1, Math.ceil(count / cols))
			const cellW = viewportW / cols
			const cellH = viewportH / rows
			// Slightly under min(cellW, cellH) so adjacent notes don't visually
			// abut/overlap at rounding edges — still packed, not spread.
			const scale = (Math.min(cellW, cellH) * 0.92) / 200
			const ids: string[] = []
			for (let i = 0; i < count; i++) {
				const id = `shape:dense-${i}`
				ids.push(id)
				ew.doc.putShape({
					id,
					kind: 'note',
					parentId: pageId,
					index: 'a1',
					x: (i % cols) * cellW,
					y: Math.floor(i / cols) * cellH,
					rotation: 0,
					isLocked: false,
					opacity: 1,
					meta: {},
					props: { scale },
				})
			}
			ew.doc.commit()
			return ids
		},
		{ count: n, viewportW: viewport.w, viewportH: viewport.h },
	)
}
