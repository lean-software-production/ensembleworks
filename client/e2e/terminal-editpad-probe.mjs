// Probe: toggling a terminal's edit mode must not shift its rendered content.
//
// Prereq: dev stack up (bin/dev up), a room with at least one terminal shape
// in view. Run from a directory with playwright installed
// (docs/headless-browser.md):
//   node <repo>/client/e2e/terminal-editpad-probe.mjs 'http://localhost:5173/?room=probe'
import { createRequire } from 'node:module'
const { chromium } = createRequire(process.cwd() + '/')('playwright')

const url = process.argv[2] ?? 'http://localhost:5173/?room=probe'
const browser = await chromium.launch()
try {
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
	// The name prompt is a blocking window.prompt() — answer before navigating.
	page.on('dialog', (d) => d.accept('probe-bot').catch(() => {}))
	await page.goto(url, { waitUntil: 'domcontentloaded' })

	// .xterm-screen is xterm's rendered grid — the thing that must not move.
	const screen = page.locator('.xterm-screen').first()
	await screen.waitFor({ timeout: 15000 })
	const before = await screen.boundingBox()

	// Double-click enters editing; Esc Esc leaves it. Verify each transition via
	// the app's __ewEditor hook (App.tsx) — otherwise a failed toggle would leave
	// before==during==after and the probe would pass having measured nothing.
	await screen.dblclick()
	await page.waitForTimeout(300)
	const editingId = await page.evaluate(() => window.__ewEditor?.getEditingShapeId() ?? null)
	if (!editingId) {
		throw new Error('FAIL: double-click did not enter edit mode — probe cannot measure anything')
	}
	const during = await screen.boundingBox()
	await page.keyboard.press('Escape')
	await page.keyboard.press('Escape')
	await page.waitForTimeout(300)
	const stillEditing = await page.evaluate(() => window.__ewEditor?.getEditingShapeId() ?? null)
	if (stillEditing) {
		throw new Error('FAIL: Esc Esc did not leave edit mode')
	}
	const after = await screen.boundingBox()

	const shift = (a, b) =>
		Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height))
	console.log({ before, during, after, editShift: shift(before, during), roundTrip: shift(before, after) })
	if (shift(before, during) > 0.5 || shift(before, after) > 0.5) {
		throw new Error('FAIL: terminal content moved on edit toggle')
	}
	console.log('PASS: edit toggle is pixel-stable')
} catch (err) {
	console.error(err.message || err)
	process.exitCode = 1
} finally {
	await browser.close().catch(() => {})
}
