import { test, expect, identityState } from '../lib/fixtures'

test('two clients converge: shapes and presence', async ({ page, browser }) => {
	// The sequential waits below (2×15s container + 10s shape + 10s presence)
	// can total past Playwright's default 30s test timeout (feel.spec.ts sets
	// its own for the same reason).
	test.setTimeout(60_000)

	await page.goto('/?room=mp-smoke')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })

	const ctxB = await browser.newContext({
		storageState: identityState('E2E Two', 'e2e-user-0000-0000-0002'),
		viewport: { width: 1280, height: 720 },
	})
	// try/finally so ctxB always closes: with workers:1 the browser is reused
	// across later specs, so a mid-test failure would otherwise leak B's
	// context + open sync connection into every subsequent test.
	try {
		const pageB = await ctxB.newPage()
		// ctxB is a raw browser context, not the `page` fixture from lib/fixtures.ts,
		// so the fixtures' dialog->throw handler does NOT auto-apply here — add it
		// explicitly (a dialog on B means its identity storageState is broken).
		pageB.on('dialog', (d) => {
			throw new Error(`unexpected dialog (identity fixture broken?): ${d.message()}`)
		})
		await pageB.goto('/?room=mp-smoke')
		await expect(pageB.locator('.tl-container')).toBeVisible({ timeout: 15_000 })

		// A creates a note through the real editor (flows through real sync).
		await page.evaluate(() => {
			const ed = (window as any).__ewEditor
			ed.createShape({ type: 'note', x: 200, y: 200, props: {} })
		})
		await expect(pageB.locator('.tl-shape')).toHaveCount(1, { timeout: 10_000 })

		// B moves the mouse over the canvas; A sees B's presence cursor.
		//
		// Verified empirically (DOM dump of every element whose className matches
		// /cursor/i or /collaborator/i after B moved its mouse: zero matches) and
		// confirmed in tldraw 5.1's source: collaborator cursors are NOT individual
		// DOM nodes in this version. They're painted by CollaboratorCursorOverlayUtil
		// directly onto one shared `<canvas class="tl-canvas-overlays">` via Canvas2D
		// draw calls (node_modules/tldraw/src/lib/overlays/CollaboratorCursorOverlayUtil.ts),
		// so there is no `.tl-cursor` / `.tl-collaborator-cursor` selector to assert
		// on — pinning one would be asserting on something that can never match.
		//
		// Instead, assert presence through the same public data the overlay itself
		// reads (editor.getVisibleCollaboratorsOnCurrentPage()): A must see exactly
		// one collaborator (B), whose broadcast cursor position matches where B's
		// mouse actually landed — proving live propagation of a real mouse move,
		// not just a stale/default presence record (every connected peer has a
		// non-null `cursor` field from the moment it connects).
		await pageB.mouse.move(640, 360)
		await pageB.mouse.move(660, 380)

		const bPagePoint = await pageB.evaluate(() => {
			const ed = (window as any).__ewEditor
			const p = ed.inputs.getCurrentPagePoint()
			return { x: p.x, y: p.y }
		})

		// Poll (not a one-shot read) because presence throttles: the first synced
		// record can be a stale intermediate (e.g. from the first mouse.move, not
		// the second) — waiting until it matches B's *final* page point is what
		// proves convergence, not just that presence exists at all. The poll
		// returns {count, cursor} rather than bailing to null on a wrong count,
		// so a timeout failure names the actual state (0 vs 2+ collaborators,
		// or a cursor stuck at the wrong position).
		await expect
			.poll(
				async () => {
					const collaborators = await page.evaluate(() => {
						const ed = (window as any).__ewEditor
						return ed
							.getVisibleCollaboratorsOnCurrentPage()
							.map((c: { cursor: { x: number; y: number } }) => c.cursor)
					})
					const [cursor] = collaborators
					return {
						count: collaborators.length,
						cursor: cursor ? { x: Math.round(cursor.x), y: Math.round(cursor.y) } : null,
					}
				},
				{ timeout: 10_000 }
			)
			.toEqual({
				count: 1,
				cursor: { x: Math.round(bPagePoint.x), y: Math.round(bPagePoint.y) },
			})
	} finally {
		await ctxB.close()
	}
})
