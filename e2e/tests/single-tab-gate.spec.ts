import { test, expect } from '../lib/fixtures'

/**
 * The gate's recovery path must leave the room with ONE presence record for
 * this user — not two.
 *
 * A duplicate tab is refused (SingleTabGate), and when the holder closes, the
 * blocked tab's queued lock request is granted and it mounts on its own. That
 * recovery mount is the path under test: a second presence record published
 * for our own userId renders as a "collaborator" beside ourselves (the panel
 * mosaic keys on the raw user id), so one person appears twice and React
 * warns about duplicate keys for as long as the tab lives.
 *
 * Both pages share one browser context on purpose: navigator.locks is scoped
 * per-origin per-process, so same-context pages contend for the same lock the
 * way two tabs of one browser profile do. Separate contexts would not.
 */
test('recovery after the holder closes leaves one presence record for this user', async ({
	page,
	context,
}) => {
	// Two 15s container waits plus the grace/lock waits exceed the 30s default.
	test.setTimeout(60_000)

	const room = 'gate-recovery'

	// A holds the lock and mounts the app.
	await page.goto(`/?room=${room}`)
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })

	// B is the duplicate: same context ⇒ same origin, same stored identity, so
	// the same (room, user) lock. It must be refused, and refusal means the app
	// never mounts — no canvas at all, just the notice.
	const pageB = await context.newPage()
	pageB.on('dialog', (d) => {
		throw new Error(`unexpected dialog (identity fixture broken?): ${d.message()}`)
	})
	await pageB.goto(`/?room=${room}`)
	await expect(pageB.getByText('This canvas is open in another tab')).toBeVisible({
		timeout: 15_000,
	})
	await expect(pageB.locator('.tl-container')).toHaveCount(0)

	// Closing the holder releases the lock; B's still-queued request is granted
	// and the gate mounts the app with no reload and no click.
	await page.close()
	await expect(pageB.locator('.tl-container')).toBeVisible({ timeout: 15_000 })

	// Presence is published on a timer after mount, so give it a beat to arrive
	// before counting tiles.
	//
	// This wait is also what makes the test meaningful: B mounts about a
	// millisecond after A's tab closed, well inside the window where tldraw's
	// room still holds A's session (SESSION_REMOVAL_WAIT_TIME, 5s), so B really
	// does receive a presence record for its OWN user. Verified by dumping
	// getCollaborators() here — the ghost is present and the roster still shows
	// one tile. Without the fix this assertion sees 2.
	await pageB.waitForTimeout(3_000)

	// One person, one tile. The roster is keyed on the raw user id, so a second
	// entry for our own user is both a visual duplicate and a React key
	// collision (roster.test.ts pins the grouping rule itself).
	const tiles = pageB.locator('[data-testid="ew-mosaic-grid"] [data-mosaic-id]')
	await expect(tiles).toHaveCount(1)
})
