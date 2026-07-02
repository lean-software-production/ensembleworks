/**
 * End-to-end probe for screen-share tiles (spec §testing):
 *   1. sharer publishes a (fake) screen capture via the toolbar tool
 *   2. a second client sees the tile go live and render frames
 *   3. panning the viewer away unsubscribes the track at the SFU; back resubscribes
 *   4. the viewer deleting the tile stops the sharer's capture + publication
 *
 * Run from the playwright scratch dir (docs/headless-browser.md):
 *   cd /tmp/canvas-probe && node <repo>/client/e2e/screenshare-probe.mjs
 * Requires the dev stack (vite :5173, sync :8788) and LiveKit enabled.
 */
import { createRequire } from 'node:module'
// Resolve playwright from the CWD (the scratch dir), not this repo.
const require = createRequire(process.cwd() + '/')
const { chromium } = require('playwright')

const BASE = process.env.CANVAS_URL ?? 'http://localhost:5173'
const ROOM = `ss-probe-${Date.now().toString(36)}`
const HOME = 'd=v0.0.1600.900' // deep link back to the origin viewport
const AWAY = 'd=v50000.50000.1600.900' // far off-canvas — nothing subscribed here

function fail(msg) {
	console.error(`FAIL: ${msg}`)
	process.exit(1)
}

/** Poll an async predicate until truthy or timeout; returns the last value. */
async function until(label, fn, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs
	let last
	while (Date.now() < deadline) {
		last = await fn().catch(() => undefined)
		if (last) {
			console.log(`PASS: ${label}`)
			return last
		}
		await new Promise((r) => setTimeout(r, 250))
	}
	fail(`${label} (timed out; last=${JSON.stringify(last)})`)
}

/** Read a named screen publication's isSubscribed on a page, or null. */
const subscriptionState = (page, trackName) =>
	page.evaluate((name) => {
		const room = window.__ewScreenShareRoom
		if (!room) return null
		for (const p of room.remoteParticipants.values()) {
			for (const pub of p.getTrackPublications()) {
				if (pub.trackName === name) return { isSubscribed: pub.isSubscribed }
			}
		}
		return null
	}, trackName)

const browser = await chromium.launch({
	headless: true,
	args: [
		// Auto-consent the capture picker and hand it the (virtual) screen —
		// the only way to exercise getDisplayMedia headlessly.
		'--use-fake-ui-for-media-stream',
		'--auto-select-desktop-capture-source=Entire screen',
		'--use-fake-device-for-media-stream',
	],
})

// ── Sharer ───────────────────────────────────────────────────────────────────
const sharerCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
const sharer = await sharerCtx.newPage()
sharer.on('dialog', (d) => d.accept('sharer-bot').catch(() => {}))
await sharer.goto(`${BASE}/?room=${ROOM}&${HOME}`, { waitUntil: 'domcontentloaded' })
await sharer.waitForSelector('.tl-canvas', { timeout: 20000 })
await until('sharer A/V connected', () => sharer.evaluate(() => !!window.__ewScreenShareRoom))

// tldraw renders aria-label (not title) on toolbar buttons; the DOM contract
// in the brief said [title="Share screen"] but the real attribute is aria-label.
// The button may live in an overflow tray (data-toolbar-visible="false"); dispatch
// a synthetic click so we bypass Playwright's visibility guard on the hidden item.
await sharer.evaluate(() => {
	const btn = document.querySelector('[aria-label="Share screen"]')
	if (!btn) throw new Error('Share screen button not found')
	btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
await until(
	'sharer tile created and live (self-preview)',
	() => sharer.locator('[data-screenshare][data-screenshare-state="live"]').count()
)
const trackName = await sharer
	.locator('[data-screenshare]')
	.first()
	.getAttribute('data-screenshare')
if (!trackName?.startsWith('screen:')) fail(`bad trackName: ${trackName}`)
console.log(`PASS: track published as ${trackName}`)

// ── Viewer sees the stream ───────────────────────────────────────────────────
const viewerCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
const viewer = await viewerCtx.newPage()
viewer.on('dialog', (d) => d.accept('viewer-bot').catch(() => {}))
await viewer.goto(`${BASE}/?room=${ROOM}&${HOME}`, { waitUntil: 'domcontentloaded' })
await viewer.waitForSelector('.tl-canvas', { timeout: 20000 })
await until('viewer A/V connected', () => viewer.evaluate(() => !!window.__ewScreenShareRoom))
await until(
	'viewer tile live',
	() => viewer.locator('[data-screenshare][data-screenshare-state="live"]').count()
)
await until('viewer video has frames', () =>
	viewer.evaluate(() => {
		const v = document.querySelector('[data-screenshare] video')
		return !!v && v.videoWidth > 0
	})
)

// ── Viewport scoping ─────────────────────────────────────────────────────────
await viewer.goto(`${BASE}/?room=${ROOM}&${AWAY}`, { waitUntil: 'domcontentloaded' })
await viewer.waitForSelector('.tl-canvas', { timeout: 20000 })
await until('panned-away viewer unsubscribes at the SFU', async () => {
	const s = await subscriptionState(viewer, trackName)
	return s !== null && s.isSubscribed === false
})
await viewer.goto(`${BASE}/?room=${ROOM}&${HOME}`, { waitUntil: 'domcontentloaded' })
await viewer.waitForSelector('.tl-canvas', { timeout: 20000 })
await until('returning viewer resubscribes', async () => {
	const s = await subscriptionState(viewer, trackName)
	return s !== null && s.isSubscribed === true
})

// ── Teardown: viewer deletes the tile → sharer stops capture + publication ──
await viewer.evaluate(() => {
	const editor = window.__ewEditor
	const shape = editor.getCurrentPageShapes().find((s) => s.type === 'screenshare')
	editor.deleteShape(shape.id)
})
await until(
	'sharer tile removed after remote delete',
	async () => (await sharer.locator('[data-screenshare]').count()) === 0
)
await until('sharer publication withdrawn', () =>
	sharer.evaluate(() => {
		const room = window.__ewScreenShareRoom
		return (
			room &&
			room.localParticipant
				.getTrackPublications()
				.every((pub) => !pub.trackName?.startsWith('screen:'))
		)
	})
)

await browser.close()
console.log('ALL SCREENSHARE E2E CHECKS PASSED')
