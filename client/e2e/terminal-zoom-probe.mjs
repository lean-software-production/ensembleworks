// Probe: box-drawing seams and selection accuracy at fractional zooms.
//
// fontSize = BASE_FONT * editZoom (TerminalShapeUtil.tsx) is fractional at
// most zooms — the prime suspect for box-drawing seams and off-by-one
// drag-selection (docs/superpowers/specs/2026-07-10-terminal-fixes-bundle-design.md
// item 6). This probe attempts to reproduce both symptoms under headless
// Chromium — see the design doc's item 6 "Findings" for the result.
//
// Prereq: dev stack up, room "probe" with one terminal in view, and inside it
// a box-drawing TUI (run: printf '┌────┐\n│ x │\n└────┘\n', or `htop`/`claude`
// for a full-frame TUI).
// Run from a directory with playwright installed (docs/headless-browser.md):
//   node <repo>/client/e2e/terminal-zoom-probe.mjs 'http://localhost:5173/?room=probe'
// PROBE_DPR=2 node ... re-runs the magnified pass used in the findings.
import { createRequire } from 'node:module'
const { chromium } = createRequire(process.cwd() + '/')('playwright')

const url = process.argv[2] ?? 'http://localhost:5173/?room=probe'
const ZOOMS = [0.75, 1.1, 1.33]
const DPR = Number(process.env.PROBE_DPR ?? 1)

const browser = await chromium.launch()
try {
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: DPR })
	// The name prompt is a blocking window.prompt() — answer before navigating.
	page.on('dialog', (d) => d.accept('probe-bot').catch(() => {}))
	await page.goto(url, { waitUntil: 'domcontentloaded' })

	// .xterm-screen is xterm's rendered grid — the thing we screenshot/measure.
	const screen = page.locator('.xterm-screen').first()
	await screen.waitFor({ timeout: 15000 })

	// Double-click enters editing — editZoom only tracks the camera while
	// editing (see the editZoom useValue in TerminalShapeUtil.tsx). Verify via
	// the app's __ewEditor hook (App.tsx:193; NOT window.editor) so a failed
	// toggle fails loudly instead of silently measuring zoom=1 the whole time.
	//
	// NOTE: screen.dblclick() (Playwright's locator action) reliably times out
	// here — its actionability check reports "<div class=\"tl-background\">
	// intercepts pointer events" even though the element is visible/stable and
	// centred correctly. This reproduces on terminal-editpad-probe.mjs too, so
	// it's a tldraw + Playwright locator-actionability quirk, not specific to
	// this probe. Dispatching the double-click via page.mouse at the measured
	// bounding-box centre (no actionability check) works reliably.
	let box0 = await screen.boundingBox()
	if (!box0) throw new Error('FAIL: .xterm-screen has no bounding box before entering edit mode')
	await page.mouse.dblclick(box0.x + box0.width / 2, box0.y + box0.height / 2)
	await page.waitForTimeout(300)
	const editingId = await page.evaluate(() => window.__ewEditor?.getEditingShapeId() ?? null)
	if (!editingId) {
		throw new Error('FAIL: double-click did not enter edit mode — probe cannot measure anything')
	}

	const results = []
	for (const z of ZOOMS) {
		await page.evaluate((zoom) => {
			const ed = window.__ewEditor
			if (!ed) throw new Error('window.__ewEditor missing mid-probe')
			ed.setCamera({ ...ed.getCamera(), z: zoom })
		}, z)
		await page.waitForTimeout(400)

		const box = await screen.boundingBox()
		if (!box) throw new Error(`FAIL: .xterm-screen has no bounding box at zoom ${z}`)
		const shotPath = `zoom-${z}.png`
		// Clipping to the bbox relies on the host counter-scale (scale(1/zoom))
		// keeping the on-screen size ~constant across zooms — a counter-scale
		// regression shows up here as a wrong/failed clip.
		await page.screenshot({ path: shotPath, clip: box })

		// Selection accuracy: shift+drag across the middle row. A fractional
		// cell mismatch can select part of the row above/below too — we want
		// exactly 1 selected row.
		const y = box.y + box.height / 2
		await page.keyboard.down('Shift')
		await page.mouse.move(box.x + 8, y)
		await page.mouse.down()
		await page.mouse.move(box.x + box.width - 8, y, { steps: 12 })
		await page.mouse.up()
		await page.keyboard.up('Shift')
		await page.waitForTimeout(100)

		const sel = await page.evaluate(() => window.getSelection?.()?.toString() ?? '')
		const selLines = sel.split('\n').filter((l) => l.length > 0)
		const selRows = selLines.length
		const selEmpty = sel.length === 0

		// window.getSelection() is read per the plan, but its provenance in
		// this app is uncertain: xterm renders into <canvas> (WebGL raster +
		// 2D link layer) with no `.xterm-accessibility` tree and no DOM text
		// node matching terminal content found on inspection, yet toString()
		// sometimes returns terminal-glyph text anyway. There is also no
		// window-exposed handle to xterm's own SelectionService (only
		// __ewEditor is exposed — App.tsx). Treat selRows as a secondary
		// signal only; the reliable evidence is the selection screenshot
		// below — the highlighted band's row extent is directly visible.
		const selShotPath = `selection-${z}.png`
		await page.screenshot({ path: selShotPath, clip: box })

		results.push({ zoom: z, selRows, selEmpty, sel, screenshot: shotPath, selectionScreenshot: selShotPath })
		console.log(
			`zoom ${z}: window.getSelection() rows = ${selRows} (secondary signal only — see comment above), ` +
				`screenshots ${shotPath} (seams) / ${selShotPath} (selection highlight — inspect visually for row count)`
		)

		// Clear the selection before the next zoom so results don't accumulate.
		await page.mouse.click(box.x + box.width / 2, box.y + 4)
		await page.evaluate(() => window.getSelection?.()?.removeAllRanges?.())
	}

	console.log('PROBE COMPLETE — inspect zoom-*.png for box-drawing seams; per-zoom summary above.')
	console.log(JSON.stringify(results, null, 2))
} catch (err) {
	console.error(err.message || err)
	process.exitCode = 1
} finally {
	await browser.close().catch(() => {})
}
