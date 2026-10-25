import { test, expect } from '../lib/fixtures'

// The room switcher is the one part of its feature with no unit test by
// construction — the bare-bun harness has no DOM. These are the checks the
// plan's Task 7 lists as a manual smoke, driven for real instead.

const SWITCHER = '[data-testid="ew-room-switcher"]'
const MENU = '[data-testid="ew-room-switcher-menu"]'

async function openRoom(page: import('@playwright/test').Page, room: string) {
	await page.goto(`/?room=${room}`)
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
}

test('the header trigger names the current room and opens the list', async ({ page }) => {
	// Touch a second room first so the list has more than one entry.
	await openRoom(page, 'switcher-other')
	await openRoom(page, 'switcher-home')

	const trigger = page.locator(SWITCHER)
	await expect(trigger).toContainText('switcher-home')

	await expect(page.locator(MENU)).toHaveCount(0)
	await trigger.click()
	await expect(page.locator(MENU)).toBeVisible()

	// Both rooms present, and the list agrees with the endpoint that feeds it.
	const rows = page.locator(`${MENU} [data-testid^="ew-room-switcher-row-"]`)
	await expect(rows).not.toHaveCount(0)
	const rendered = await rows.evaluateAll((els) =>
		els.map((el) => el.getAttribute('data-testid')!.replace('ew-room-switcher-row-', ''))
	)
	const served = await page.evaluate(async () => {
		const res = await fetch('/api/rooms')
		return (await res.json()).rooms.map((r: { id: string }) => r.id)
	})
	expect(rendered).toEqual(served)
	expect(rendered).toContain('switcher-home')
	expect(rendered).toContain('switcher-other')

	await page.screenshot({ path: 'test-results/room-switcher-open.png' })
})

test('the popover is not clipped or overlapped at the panel minimum width', async ({ page }) => {
	await openRoom(page, 'switcher-home')

	// Drive the panel to its MIN_WIDTH (panelLayout.ts) — the configuration the
	// whole-branch review flagged, where an absolutely-positioned popover got
	// cropped by the panel root's overflow.
	await page.evaluate(() => {
		localStorage.setItem(
			'ensembleworks.panelLayout.v1',
			JSON.stringify({ width: 180, collapsed: false })
		)
	})
	await page.reload()
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })

	await page.locator(SWITCHER).click()
	const menu = page.locator(MENU)
	await expect(menu).toBeVisible()

	const box = (await menu.boundingBox())!
	const viewport = page.viewportSize()!
	expect(box.x).toBeGreaterThanOrEqual(0)
	expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)

	// Nothing paints over it: the element at the popover's own centre is the
	// popover (or a descendant of it), not a participant tile behind it.
	const onTop = await page.evaluate(
		([x, y]) => {
			const el = document.elementFromPoint(x, y)
			return !!el?.closest('[data-testid="ew-room-switcher-menu"]')
		},
		[box.x + box.width / 2, box.y + box.height / 2]
	)
	expect(onTop).toBe(true)

	await page.screenshot({ path: 'test-results/room-switcher-narrow.png' })
})

test('picking a room navigates; picking the current room does not', async ({ page }) => {
	await openRoom(page, 'switcher-other')
	await openRoom(page, 'switcher-home')

	// The current room is inert.
	await page.locator(SWITCHER).click()
	await page.locator(`[data-testid="ew-room-switcher-row-switcher-home"]`).click()
	await expect(page.locator(MENU)).toHaveCount(0)
	expect(new URL(page.url()).searchParams.get('room')).toBe('switcher-home')

	// A different room navigates, with a full page load.
	await page.locator(SWITCHER).click()
	await page.locator(`[data-testid="ew-room-switcher-row-switcher-other"]`).click()
	await page.waitForURL(/room=switcher-other/)
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
	await expect(page.locator(SWITCHER)).toContainText('switcher-other')
})

test('opening the list issues exactly one request', async ({ page }) => {
	await openRoom(page, 'switcher-home')

	const calls: string[] = []
	page.on('request', (r) => {
		if (r.url().includes('/api/rooms')) calls.push(r.url())
	})

	await page.locator(SWITCHER).click()
	await expect(page.locator(MENU)).toBeVisible()
	await page.waitForTimeout(500)
	expect(calls).toHaveLength(1)
})

test('a failing endpoint shows the error row, and retry re-requests', async ({ page }) => {
	await openRoom(page, 'switcher-home')

	await page.route('**/api/rooms', (route) => route.fulfill({ status: 500, body: 'nope' }))
	await page.locator(SWITCHER).click()
	await expect(page.locator(MENU)).toContainText('couldn’t load rooms')

	await page.unroute('**/api/rooms')
	await page.locator('[data-testid="ew-room-switcher-retry"]').click()
	await expect(page.locator(`${MENU} [data-testid^="ew-room-switcher-row-"]`)).not.toHaveCount(0)
})
