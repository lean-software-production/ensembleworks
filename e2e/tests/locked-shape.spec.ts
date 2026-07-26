/**
 * Browser regression suite for the locked-shape padlock chip.
 *
 * The feature is two lines wide and both of them fail silently:
 *   (a) `options={{ selectLockedShapes: true }}` on the `<Tldraw>` mount in
 *       `client/src/App.tsx` — drop it during an unrelated prop edit and a
 *       locked shape can no longer be selected, so the chip never persists
 *       past a hover;
 *   (b) `<LockedShapeBadge />` inside the `InFrontOfTheCanvas` fragment in
 *       `client/src/ui.tsx` — drop it and the chip is simply never rendered.
 * Either deletion leaves `bun run test` fully green while the affordance is
 * dead on the canvas. Only a real browser catches it, so this suite exists.
 *
 * It also pins the regression boundary: `selectLockedShapes` makes a locked
 * shape *selectable*, and nothing more — it must stay uneditable, unmovable
 * and undeletable.
 *
 * Note: geo shapes are created with `fill: 'solid'` on purpose. tldraw
 * hit-tests hover with `hitInside: false`, so an unfilled rectangle is only
 * "hovered" on its stroke — an unfilled shape makes this suite test the
 * wrong thing.
 */
import { test, expect } from '../lib/fixtures'
import type { Page } from '@playwright/test'

const CHIP = '[aria-label="Locked"]'

async function boot(page: Page, room: string) {
	await page.goto(`/?room=${room}`)
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 20_000 })
	await page.waitForFunction(() => !!(window as any).__ewEditor)
}

/** Window-space centre of a shape, for real mouse input. */
async function centre(page: Page, id: string) {
	return await page.evaluate((shapeId) => {
		const ed = (window as any).__ewEditor
		const b = ed.getShapePageBounds(shapeId)
		const tl = ed.pageToScreen({ x: b.minX, y: b.minY })
		const br = ed.pageToScreen({ x: b.maxX, y: b.maxY })
		return { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 }
	}, id)
}

test('locked geo: at rest none, hover shows, leave hides, click keeps', async ({ page }) => {
	await boot(page, 'lockbadge-1')
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.createShapes([
			{ id: 'shape:locked1', type: 'geo', x: 200, y: 200, props: { w: 200, h: 150, fill: 'solid' } },
			{ id: 'shape:free1', type: 'geo', x: 500, y: 200, props: { w: 200, h: 150, fill: 'solid' } },
		])
		ed.updateShape({ id: 'shape:locked1', type: 'geo', isLocked: true })
	})

	await expect(page.locator(CHIP)).toHaveCount(0)

	const lockedAt = await centre(page, 'shape:locked1')
	await page.mouse.move(lockedAt.x, lockedAt.y)
	await expect(page.locator(CHIP)).toHaveCount(1)

	// Hovering the UNLOCKED sibling must produce nothing.
	const freeAt = await centre(page, 'shape:free1')
	await page.mouse.move(freeAt.x, freeAt.y)
	await expect(page.locator(CHIP)).toHaveCount(0)

	await page.mouse.move(20, 600)
	await expect(page.locator(CHIP)).toHaveCount(0)

	// Click → selects, and the chip survives the pointer leaving.
	await page.mouse.move(lockedAt.x, lockedAt.y)
	await page.mouse.down()
	await page.mouse.up()
	await page.mouse.move(20, 600)
	const selected = await page.evaluate(() => (window as any).__ewEditor.getSelectedShapeIds())
	expect(selected).toEqual(['shape:locked1'])
	await expect(page.locator(CHIP)).toHaveCount(1)
})

test('chip sits outside the top-right of the bounds and tracks pan/zoom', async ({ page }) => {
	await boot(page, 'lockbadge-2')
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.createShapes([{ id: 'shape:l2', type: 'geo', x: 300, y: 300, props: { w: 240, h: 160, fill: 'solid' } }])
		ed.updateShape({ id: 'shape:l2', type: 'geo', isLocked: true })
		ed.select('shape:l2')
	})
	await expect(page.locator(CHIP)).toHaveCount(1)

	const geometry = async () => {
		const chip = await page.locator(CHIP).boundingBox()
		const shape = await page.evaluate(() => {
			const ed = (window as any).__ewEditor
			const b = ed.getShapePageBounds('shape:l2')
			const tl = ed.pageToScreen({ x: b.minX, y: b.minY })
			const br = ed.pageToScreen({ x: b.maxX, y: b.maxY })
			return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y }
		})
		return { chip: chip!, shape }
	}

	const before = await geometry()
	expect(before.chip.x).toBeGreaterThanOrEqual(before.shape.maxX)
	expect(Math.abs(before.chip.y - before.shape.minY)).toBeLessThan(8)

	// Pan.
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		const c = ed.getCamera()
		ed.setCamera({ x: c.x - 180, y: c.y - 120, z: c.z })
	})
	await page.waitForTimeout(300)
	const panned = await geometry()
	expect(panned.chip.x).toBeGreaterThanOrEqual(panned.shape.maxX)
	expect(Math.abs(panned.chip.y - panned.shape.minY)).toBeLessThan(8)

	// Zoom out.
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		const c = ed.getCamera()
		ed.setCamera({ x: c.x, y: c.y, z: c.z * 0.6 })
	})
	await page.waitForTimeout(300)
	const zoomed = await geometry()
	expect(zoomed.chip.x).toBeGreaterThanOrEqual(zoomed.shape.maxX)
	expect(Math.abs(zoomed.chip.y - zoomed.shape.minY)).toBeLessThan(8)
})

test('a locked FRAME badges its hovered child', async ({ page }) => {
	await boot(page, 'lockbadge-3')
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.createShapes([{ id: 'shape:fr', type: 'frame', x: 100, y: 100, props: { w: 400, h: 300 } }])
		ed.createShapes([{ id: 'shape:kid', type: 'geo', x: 180, y: 180, props: { w: 120, h: 90, fill: 'solid' } }])
		ed.reparentShapes(['shape:kid'], 'shape:fr')
		ed.updateShape({ id: 'shape:fr', type: 'frame', isLocked: true })
	})
	// The child itself is NOT locked — only its frame is.
	expect(await page.evaluate(() => (window as any).__ewEditor.getShape('shape:kid').isLocked)).toBe(false)
	const kidAt = await centre(page, 'shape:kid')
	await page.mouse.move(kidAt.x, kidAt.y)
	await expect(page.locator(CHIP)).toHaveCount(1)
})

test('arrow and draw stroke badge too; select-all badges every locked shape (no cap)', async ({ page }) => {
	await boot(page, 'lockbadge-4')

	// A real draw stroke, drawn with the draw tool — its `path` prop is
	// delta-encoded base64, so it cannot be hand-authored via createShapes.
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.setCurrentTool('draw')
	})
	await page.mouse.move(300, 300)
	await page.mouse.down()
	for (const [x, y] of [
		[340, 330],
		[390, 320],
		[440, 380],
	]) {
		await page.mouse.move(x, y, { steps: 5 })
	}
	await page.mouse.up()
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.setCurrentTool('select')
		ed.createShapes([{ id: 'shape:arr', type: 'arrow', x: 700, y: 250, props: { start: { x: 0, y: 0 }, end: { x: 180, y: 120 } } }])
		ed.updateShape({ id: 'shape:arr', type: 'arrow', isLocked: true })
		const drawn = ed.getCurrentPageShapes().find((s: any) => s.type === 'draw')
		if (!drawn) throw new Error('draw stroke was not created')
		ed.updateShape({ id: drawn.id, type: 'draw', isLocked: true })
	})

	// Park the pointer off every shape first — the draw stroke it was just
	// released over is itself locked, and a hovered chip plus a selected chip
	// is two chips, correctly.
	await page.mouse.move(30, 660)
	await page.evaluate(() => {
		;(window as any).__ewEditor.select('shape:arr')
	})
	await expect(page.locator(CHIP)).toHaveCount(1)

	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		const drawn = ed.getCurrentPageShapes().find((s: any) => s.type === 'draw')
		ed.select(drawn.id)
	})
	await expect(page.locator(CHIP)).toHaveCount(1)

	// Eight more locked shapes → select-all shows ten chips, no truncation.
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		for (let i = 0; i < 8; i++) {
			const id = `shape:bulk${i}`
			ed.createShapes([
				{ id, type: 'geo', x: 100 + (i % 4) * 220, y: 600 + Math.floor(i / 4) * 180, props: { w: 160, h: 120, fill: 'solid' } },
			])
			ed.updateShape({ id, type: 'geo', isLocked: true })
		}
		ed.zoomToFit()
	})
	await page.waitForTimeout(400)

	// Ctrl+A / selectAll() does NOT pick up locked shapes: Editor.selectAll()
	// ends in setSelectedShapes(this._getUnlockedShapeIds(ids)) (Editor.ts:2174),
	// which strips them unconditionally — `selectLockedShapes` does not reach it.
	// So the spec's worry about a select-all lighting up dozens of padlocks
	// cannot happen through Ctrl+A at all.
	await page.mouse.move(30, 660)
	await page.evaluate(() => {
		;(window as any).__ewEditor.selectAll()
	})
	await page.waitForTimeout(300)
	const afterSelectAll = await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		return { selected: ed.getSelectedShapeIds().length, chips: document.querySelectorAll('[aria-label="Locked"]').length }
	})
	expect(afterSelectAll.selected).toBe(0)
	expect(afterSelectAll.chips).toBe(0)

	// The no-cap claim, proven the way the user actually reaches it: select every
	// locked shape explicitly, and count one chip per locked shape.
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.setSelectedShapes(ed.getCurrentPageShapes().map((s: any) => s.id))
	})
	await page.waitForTimeout(400)
	const counts = await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		const shapes = ed.getCurrentPageShapes()
		return {
			total: shapes.length,
			selected: ed.getSelectedShapeIds().length,
			locked: shapes.filter((s: any) => ed.isShapeOrAncestorLocked(s.id)).length,
			chips: document.querySelectorAll('[aria-label="Locked"]').length,
		}
	})
	expect(counts.locked).toBe(10)
	expect(counts.selected).toBe(10)
	expect(counts.chips).toBe(10)
})

test('move-to-page relocates a locked shape (upstream tldraw asymmetry)', async ({ page }) => {
	await boot(page, 'lockbadge-6')
	const observed = await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.createShapes([{ id: 'shape:mv', type: 'geo', x: 200, y: 200, props: { w: 200, h: 150, fill: 'solid' } }])
		ed.updateShape({ id: 'shape:mv', type: 'geo', isLocked: true })
		const firstPageId = ed.getCurrentPageId()
		ed.createPage({ name: 'second' })
		const secondPageId = ed.getPages().find((p: any) => p.id !== firstPageId).id
		ed.setCurrentPage(firstPageId)
		ed.moveShapesToPage(['shape:mv'], secondPageId)
		const rec = ed.store.get('shape:mv')
		return {
			exists: !!rec,
			parentId: rec ? rec.parentId : null,
			isLocked: rec ? rec.isLocked : null,
			shapeRecordCount: ed.store
				.allRecords()
				.filter((r: any) => r.typeName === 'shape').length,
			onFirst: [...ed.getPageShapeIds(firstPageId)],
			onSecond: [...ed.getPageShapeIds(secondPageId)],
			secondPageId,
		}
	})

	// Observed truth in tldraw 5.1.0: the lock does NOT hold. moveShapesToPage
	// captures content with getContentFromCurrentPage (no lock filter), then
	// deletes with deleteShapes (lock-filtered, so the locked original survives
	// the delete), then re-puts with preserveIds: true — which overwrites the
	// surviving record in place with its new parentId. Net effect: exactly one
	// record, relocated to the destination page, still locked. No duplicate is
	// left behind and the original page ends up empty.
	// (Editor.ts:7099-7128. `selectLockedShapes: true` is what makes tldraw's
	// MoveToPageMenu reachable for a locked shape; the asymmetry is upstream's.)
	expect(observed.exists).toBe(true)
	expect(observed.shapeRecordCount).toBe(1)
	expect(observed.parentId).toBe(observed.secondPageId)
	expect(observed.isLocked).toBe(true)
	expect(observed.onFirst).toEqual([])
	expect(observed.onSecond).toEqual(['shape:mv'])
})

test('regression: selectLockedShapes did NOT make locked shapes editable, movable or deletable', async ({ page }) => {
	await boot(page, 'lockbadge-5')
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.createShapes([
			{ id: 'shape:lk', type: 'geo', x: 200, y: 200, props: { w: 200, h: 150, fill: 'solid' } },
			{ id: 'shape:fr2', type: 'geo', x: 500, y: 200, props: { w: 200, h: 150, fill: 'solid' } },
		])
		ed.updateShape({ id: 'shape:lk', type: 'geo', isLocked: true })
	})
	const at = await centre(page, 'shape:lk')

	// Double-click must not enter edit mode.
	await page.mouse.dblclick(at.x, at.y)
	expect(await page.evaluate(() => (window as any).__ewEditor.getEditingShapeId())).toBeNull()

	// Drag must not move it.
	const before = await page.evaluate(() => {
		const s = (window as any).__ewEditor.getShape('shape:lk')
		return { x: s.x, y: s.y }
	})
	await page.mouse.move(at.x, at.y)
	await page.mouse.down()
	await page.mouse.move(at.x + 150, at.y + 90, { steps: 10 })
	await page.mouse.up()
	const after = await page.evaluate(() => {
		const s = (window as any).__ewEditor.getShape('shape:lk')
		return { x: s.x, y: s.y }
	})
	expect(after).toEqual(before)

	// Delete/Backspace with it selected must not delete it.
	await page.evaluate(() => {
		;(window as any).__ewEditor.select('shape:lk')
	})
	await page.keyboard.press('Delete')
	await page.keyboard.press('Backspace')
	expect(await page.evaluate(() => !!(window as any).__ewEditor.getShape('shape:lk'))).toBe(true)

	// Marquee over both, then drag the unlocked one: only it moves.
	await page.evaluate(() => {
		;(window as any).__ewEditor.selectNone()
	})
	await page.mouse.move(100, 100)
	await page.mouse.down()
	await page.mouse.move(950, 620, { steps: 12 })
	await page.mouse.up()
	const selected = await page.evaluate(() => (window as any).__ewEditor.getSelectedShapeIds())
	expect(selected).toContain('shape:lk')
	expect(selected).toContain('shape:fr2')

	const posBefore = await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		const a = ed.getShape('shape:lk')
		const b = ed.getShape('shape:fr2')
		return { lk: { x: a.x, y: a.y }, fr: { x: b.x, y: b.y } }
	})
	const freeAt = await centre(page, 'shape:fr2')
	await page.mouse.move(freeAt.x, freeAt.y)
	await page.mouse.down()
	await page.mouse.move(freeAt.x + 120, freeAt.y + 60, { steps: 10 })
	await page.mouse.up()
	const posAfter = await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		const a = ed.getShape('shape:lk')
		const b = ed.getShape('shape:fr2')
		return { lk: { x: a.x, y: a.y }, fr: { x: b.x, y: b.y } }
	})
	expect(posAfter.lk).toEqual(posBefore.lk)
	expect(posAfter.fr).not.toEqual(posBefore.fr)

	// Unlock (the same store write right-click → Unlock performs) → chip gone.
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.updateShape({ id: 'shape:lk', type: 'geo', isLocked: false })
		ed.select('shape:lk')
	})
	await expect(page.locator(CHIP)).toHaveCount(0)
})
