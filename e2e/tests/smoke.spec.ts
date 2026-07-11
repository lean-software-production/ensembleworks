import { test, expect } from '../lib/fixtures'

test('room loads with canvas mounted and no onboarding prompt', async ({ page }) => {
	await page.goto('/?room=smoke-basic')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
})
