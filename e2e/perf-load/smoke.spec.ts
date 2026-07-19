// TEMPORARY scaffold (Task 3) — replaced by canvas-v2-load.spec.ts in Task 5.
// Its ONE job: prove that a PRODUCTION client build served by `vite preview`
// at 127.0.0.1 renders BOTH engines. The v1 arm is the real question: README
// warns tldraw enforces a per-domain license and "the editor blanks" without
// VITE_TLDRAW_LICENSE_KEY, exempting only dev/watch and localhost. If this
// case fails, the v1-vs-v2 comparison cannot run on a production build and the
// plan's Task 6 fallback applies.
import { test, expect } from '../lib/fixtures'
import { shape } from '../lib/seed'
import { seedRoomOverWire } from '../lib/wire-seed'
import { installLoadProbe, readLoadSample, V2_SHAPE_SELECTOR, V2_TOOLBAR_SELECTOR } from '../lib/load-probe'

test('v2 renders wire-seeded shapes from a production build', async ({ page }) => {
	await seedRoomOverWire({ base: 'ws://127.0.0.1:8788', room: 'load-smoke-v2', count: 5, mode: 'bulk' })
	await page.goto('/?room=load-smoke-v2&engine=v2')
	await expect(page.locator('[data-shape-id]').first()).toBeVisible({ timeout: 60_000 })
})

test('v1 (tldraw) renders from a production build at 127.0.0.1 without a license key', async ({ page }) => {
	await shape('load-smoke-v1', { type: 'note', x: 0, y: 0, text: 'hello', color: 'yellow' })
	await page.goto('/?room=load-smoke-v1')
	await expect(page.locator('.tl-shape').first()).toBeVisible({ timeout: 60_000 })
})

test('load probe reports every sub-split for a v2 navigation', async ({ page }) => {
	await seedRoomOverWire({ base: 'ws://127.0.0.1:8788', room: 'load-smoke-probe', count: 5, mode: 'bulk' })
	await installLoadProbe(page, { shapeSelector: V2_SHAPE_SELECTOR, toolbarSelector: V2_TOOLBAR_SELECTOR, chunkPattern: 'CanvasV2App' })
	await page.goto('/?room=load-smoke-probe&engine=v2')
	const sample = await readLoadSample(page, 60_000)

	expect(sample.firstShapeMs).toBeGreaterThan(0)
	expect(sample.toolbarMs, 'toolbar mark must be present').not.toBeNull()
	expect(sample.wsOpenMs, 'ws-open mark must be present').not.toBeNull()
	expect(sample.chunkResponseEndMs, 'the production build must expose a CanvasV2App chunk resource timing').not.toBeNull()
	// The gap this harness exists to expose: shapes must not be claimed to
	// appear BEFORE the toolbar (that would mean the marks are mis-ordered).
	expect(sample.firstShapeMs).toBeGreaterThanOrEqual(sample.toolbarMs!)
})
