// Component goldens for canvas-v2 (Task G2) — screenshot-diffs of ISOLATED,
// OFFLINE shape-body/overlay renders (no live sync/terminal-gateway/
// LiveKit/neko/roadmap/file server behind them), as distinct from the
// full-stack multiplayer E2E (canvas-v2.spec.ts / H2). Every fixture is
// served by /component-goldens.html?fixture=<name> (client/component-
// goldens.html + client/src/canvas-v2/goldens/*) — a Vite dev-server-only
// page reached over the SAME already-running webServer this project's other
// specs use (e2e/playwright.config.ts), never wired into the production
// build (see that HTML file's own header).
//
// HONEST SCOPE (per the plan's own G2 task text — "fixture states
// renderable WITHOUT live backends"): BoxShape variants (note/text/geo/
// frame — all four currently fall back to BoxShape; canvas-react's D7 has
// not yet given the core kinds their own bodies, so "BoxShape variant" IS
// the real current render), a rotated multi-select (outline + handles),
// straight + curved arrows, collaborator cursors (self-filtered), and all
// SIX custom embed shapes in their natural DISCONNECTED/empty states:
//   - terminal: initial "Connecting…"/backoff-driven "Connection lost —
//     reconnecting (N)…" overlay — masked below (see that case's own
//     comment: the exact retry count a real WS-connection-refusal settles
//     on before the screenshot is inherently a real-clock race, not
//     something this offline fixture can pin byte-exact).
//   - screenshare: "connecting…" (client/src/screenshare/store.ts's module-
//     level room defaults null — no LiveKit object needed at all).
//   - iframe: `url: 'about:blank'` — deterministic, no network.
//   - neko: the header/mute chrome is fixturable directly; its INNER iframe
//     has no dedicated empty state (unlike the other five), so its `base`
//     points at a small static same-origin fixture page (client/
//     canvas-v2-fixtures/neko-splash.html — Vite project ROOT, dev-server-
//     served only, deliberately NOT client/public/ which vite build copies
//     into every production dist; see that file's LOCATION IS LOAD-BEARING
//     note) rather than the real (offline) `/shared-browser/` target —
//     documented, not faked: the chrome is the real component, the iframe's
//     OWN content is a controlled stand-in.
//   - roadmap: not an embed kind (client/src/canvas-v2/shapes/index.ts) —
//     its own `/api/roadmap/doc` fetch 404s against the real (but
//     roadmap-empty) sync server this project's webServer already runs,
//     settling into the explicit "No roadmap data yet" state.
//   - file-viewer: `path: ''` (the default) — the "no file" placeholder,
//     zero network dependency.
// No body proved genuinely un-fixturable (a dedicated read of all six
// confirmed none throws/hangs without a backend) — see shape-fixtures.ts's
// own module header for the full per-shape citation.
import { test, expect } from '../lib/fixtures'

// Fixtures whose render is deterministic on the first settled paint — no
// masking, no special wait condition beyond the harness mounting.
const SIMPLE_FIXTURES = [
	'box-note',
	'box-text',
	'box-geo',
	'box-frame',
	'selection-rotated',
	'arrow-straight',
	'arrow-curved',
	'cursors',
	'screenshare-no-track',
	'iframe-blank',
	'neko-splash',
	'file-viewer-empty',
] as const

const SETTLE_MS = 300 // one paint cycle's worth of margin past the harness's synchronous mount

for (const name of SIMPLE_FIXTURES) {
	test(`component golden: ${name}`, async ({ page }) => {
		await page.goto(`/component-goldens.html?fixture=${name}`)
		await expect(page.locator(`[data-golden-fixture="${name}"]`)).toBeVisible()
		await page.waitForTimeout(SETTLE_MS)
		await expect(page).toHaveScreenshot(`component-${name}.png`)
	})
}

// roadmap-empty: not deterministic on the FIRST paint (that's "loading…" —
// see RoadmapShape.tsx) — gate on the settled empty-state text instead of a
// blind wait, matching visual.spec.ts's own settle-on-real-state convention.
test('component golden: roadmap-empty', async ({ page }) => {
	await page.goto('/component-goldens.html?fixture=roadmap-empty')
	await expect(page.getByText('No roadmap data yet')).toBeVisible({ timeout: 15_000 })
	await page.waitForTimeout(SETTLE_MS)
	await expect(page).toHaveScreenshot('component-roadmap-empty.png')
})

// terminal-connecting: MASKED (not a blind faith in pixel stability) — a
// real (offline) WS connection-refusal's exact timing, and hence the
// backoff-driven retry COUNT shown in the overlay text ("Connecting…" vs
// "Connection lost — reconnecting (N)…"), is a genuine wall-clock race this
// fixture cannot pin byte-exact without either mocking the WebSocket
// constructor (out of scope for a component-golden harness that renders the
// REAL component) or accepting flakiness. Masking the shape's own body (the
// SAME "documented mask exception for a genuinely nondeterministic element"
// policy visual.spec.ts already establishes for the version stamp/VM
// meters) still lets this golden catch a regression in everything AROUND
// it (grid, camera framing, the shape's border/position) — the actual
// connecting-state TEXT is out of scope for a byte-exact diff by
// construction, not by omission.
test('component golden: terminal-connecting', async ({ page }) => {
	await page.goto('/component-goldens.html?fixture=terminal-connecting')
	await expect(page.locator('[data-golden-fixture="terminal-connecting"]')).toBeVisible()
	await page.waitForTimeout(SETTLE_MS)
	await expect(page).toHaveScreenshot('component-terminal-connecting.png', {
		mask: [page.locator('[data-canvas-v2-shape="terminal"]')],
	})
})
