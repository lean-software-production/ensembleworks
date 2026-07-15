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
// masking, no special wait condition beyond the harness mounting (and, as of
// Task C7, the webfonts settling — see waitForGoldenFonts below).
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
	// Task C7 — component goldens for the note/frame/text/geo RICH BODIES
	// (registerCoreShapes(), wired into GoldenHarness.tsx by this task; see
	// that file's own comment). Distinct from box-note/box-text/box-geo/
	// box-frame above (fixtures.ts's G2-era fixtures, which — now that
	// registerCoreShapes() is wired in — exercise the same real bodies at
	// their DEFAULT prop values): these four exercise the representative
	// non-default states bounds DoD #1 calls out (note colors + author
	// badge, a labeled frame, styled text, and the geo SVG variants).
	'note-colors',
	'frame-labeled',
	'text-styled',
	'geo-variants',
] as const

const SETTLE_MS = 300 // one paint cycle's worth of margin past the harness's synchronous mount

// Task C7 (follow-up) — the STRUCTURAL regression guard, the real teeth of
// this spec. A pixel screenshot ALONE does not catch a rich-body → BoxShape
// placeholder regression: proven empirically, with registerCoreShapes()
// commented out (so note/frame/text/geo all fall back to the generic blue
// BoxShape), 17/18 of these screenshot tests STILL PASSED, because
// `maxDiffPixelRatio: 0.02` (playwright.config.ts) combined with pixelmatch's
// luminance-weighted default per-pixel delta is effectively BLIND to a
// hue-only swap — a pastel-blue placeholder box and a pastel-yellow sticky
// have similar LIGHTNESS, so few pixels cross the diff threshold. So each
// core-kind fixture below asserts, deterministically and independent of any
// pixel tuning, that the REAL body's own `data-shape-body` marker
// (NoteShape/FrameShape/TextShape/GeoShape each emit their kind string;
// BoxShape emits "box") is present — and, for fixtures whose shapes are ALL
// core kinds, that NO `data-shape-body="box"` fallback slipped in.
//
// `box`-in-fixture EXCEPTION: the arrow fixtures legitimately contain a
// BoxShape — `arrow` is not a registered kind (registerCoreShapes only
// registers note/frame/text/geo; registerCanvasV2Shapes only the six
// embeds), so an arrow shape's BODY falls back to BoxShape (the overlay
// draws the arrow line separately). Those fixtures therefore assert the geo
// anchors' real body is present but do NOT assert box-count-0. Embed
// fixtures (screenshare/iframe/neko/file-viewer) render through EmbedLayer,
// not ShapeBody, so they carry no `data-shape-body` at all and are absent
// from this map.
interface CoreBodyExpectation {
	/** The real body marker that MUST be present (`data-shape-body="<body>"`). */
	readonly body: 'note' | 'frame' | 'text' | 'geo'
	/** Assert NO `data-shape-body="box"` fallback is present. False only for
	 * fixtures that legitimately contain a non-core kind (the arrows). */
	readonly noBox: boolean
}
const CORE_BODY_EXPECTATIONS: Readonly<Record<string, CoreBodyExpectation>> = {
	'box-note': { body: 'note', noBox: true },
	'box-text': { body: 'text', noBox: true },
	'box-geo': { body: 'geo', noBox: true },
	'box-frame': { body: 'frame', noBox: true },
	'note-colors': { body: 'note', noBox: true },
	'frame-labeled': { body: 'frame', noBox: true },
	'text-styled': { body: 'text', noBox: true },
	'geo-variants': { body: 'geo', noBox: true },
	'selection-rotated': { body: 'geo', noBox: true },
	cursors: { body: 'geo', noBox: true },
	'arrow-straight': { body: 'geo', noBox: false }, // arrow kind → BoxShape (see above)
	'arrow-curved': { body: 'geo', noBox: false },
}

async function assertCoreBody(page: import('@playwright/test').Page, name: string): Promise<void> {
	const expected = CORE_BODY_EXPECTATIONS[name]
	if (!expected) return // embed fixture — no ShapeBody marker to assert
	await expect(page.locator(`[data-shape-body="${expected.body}"]`).first()).toBeVisible()
	if (expected.noBox) await expect(page.locator('[data-shape-body="box"]')).toHaveCount(0)
}

// FIX 2 (defense-in-depth) — a MODERATELY tighter pixel gate for the
// small/precise core-body fixtures than the project-wide 0.02
// (playwright.config.ts). At 0.008 (0.8%, "well under 1%") a gross
// within-body regression (a big fill/geometry change the luminance-blind 2%
// gate would tolerate) trips the pixel diff too, while still leaving headroom
// for font anti-aliasing variance across environments. NOT applied to the
// embed/arrow fixtures (iframe/neko/screenshare render less predictable
// content — their goldens keep the looser project default). The structural
// assertion above is the REAL guard; this is backup, not a substitute.
const CORE_MAX_DIFF_PIXEL_RATIO = 0.008

// Task C7 — the 4 tldraw webfonts (client/src/canvas-v2/fonts.css, self-
// hosted since Task C6b) load ASYNCHRONOUSLY; a screenshot taken before a
// face finishes loading would nondeterministically bake in the sans-serif/
// serif/monospace fallback instead of the real handwriting/IBM-Plex glyphs
// (NoteShape.tsx/TextShape.tsx/GeoShape.tsx all declare these families).
// `document.fonts.ready` resolves once every face the page has requested
// (the harness's CSS `@font-face` rules, `font-display: block`) has either
// loaded or failed — waiting on it, PLUS an explicit `document.fonts.load`
// for each family (belt-and-suspenders: `.ready` alone can resolve before a
// lazily-triggered face used only inside dynamically-rendered shape DOM has
// actually been requested), makes every golden below deterministic across
// runs/machines rather than a font-load race.
async function waitForGoldenFonts(page: import('@playwright/test').Page): Promise<void> {
	await page.evaluate(async () => {
		const families = ["16px tldraw_draw", "16px tldraw_sans", "16px tldraw_serif", "16px tldraw_mono"]
		await Promise.all(families.map((f) => document.fonts.load(f)))
		await document.fonts.ready
	})
}

for (const name of SIMPLE_FIXTURES) {
	test(`component golden: ${name}`, async ({ page }) => {
		await page.goto(`/component-goldens.html?fixture=${name}`)
		await expect(page.locator(`[data-golden-fixture="${name}"]`)).toBeVisible()
		await waitForGoldenFonts(page)
		await page.waitForTimeout(SETTLE_MS)
		await assertCoreBody(page, name) // structural guard — see CORE_BODY_EXPECTATIONS
		const options = CORE_BODY_EXPECTATIONS[name] ? { maxDiffPixelRatio: CORE_MAX_DIFF_PIXEL_RATIO } : undefined
		await expect(page).toHaveScreenshot(`component-${name}.png`, options)
	})
}

// roadmap-empty: not deterministic on the FIRST paint (that's "loading…" —
// see RoadmapShape.tsx) — gate on the settled empty-state text instead of a
// blind wait, matching visual.spec.ts's own settle-on-real-state convention.
test('component golden: roadmap-empty', async ({ page }) => {
	await page.goto('/component-goldens.html?fixture=roadmap-empty')
	await expect(page.getByText('No roadmap data yet')).toBeVisible({ timeout: 15_000 })
	await waitForGoldenFonts(page)
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
	await waitForGoldenFonts(page)
	await page.waitForTimeout(SETTLE_MS)
	await expect(page).toHaveScreenshot('component-terminal-connecting.png', {
		mask: [page.locator('[data-canvas-v2-shape="terminal"]')],
	})
})
