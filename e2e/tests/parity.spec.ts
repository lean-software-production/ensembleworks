// Cross-renderer visual-diff harness (Task F1, canvas-phase4 Seam F) —
// renders the SAME seeded golden board under v1 (tldraw) and v2 (canvas-
// editor/canvas-react), screenshots both, computes a masked/toleranced
// parity SCORE, and proves the gate actually has teeth against a
// deliberate regression. REUSES the existing rig throughout: this project's
// `e2e/playwright.config.ts` + `e2e/scripts/start-server.ts`
// (EW_CANVAS_SYNC=1 default), `seedGoldenBoard`/`GOLDEN_BOARD_SHAPE_COUNT`
// (lib/seed.ts, already proven by seed.spec.ts), `waitForBoot` (lib/
// canvas-v2.ts), and the screenshot conventions of visual.spec.ts. No new
// runner, no new server route.
//
// ============================================================================
// CRITICAL PROBLEM #1 — identical content in BOTH engines (solved here):
// v1 renders from the tldraw store (seeded via POST /api/canvas/shape,
// exactly what seedGoldenBoard already does); v2 renders from a Loro doc
// reached over /sync/v2 — two DISJOINT stores. A harness that diffed
// mismatched content would be worthless.
//
// RESOLUTION: reuse the EXISTING Agent-API-v2 read endpoint, `GET
// /api/v2/canvas/document?room=` (server/src/features/canvas-v2.ts). That
// endpoint already converts the LIVE tldraw store into canvas-model
// Shape/Binding objects via `fromTldraw` (server/src/canvas-v2/convert.ts)
// — the SAME converter the shadow mirror (server/src/canvas-v2/shadow.ts)
// and every other Agent-API-v2 reader already trust in production. So:
// seed v1 via seedGoldenBoard -> GET that endpoint for the SAME room -> feed
// its shapes/bindings into the v2 doc via `window.__ew.doc.putShape`/
// `putBinding` (the exact mechanism lib/canvas-v2.ts's seedGrid/seedTerminal
// already use for doc-level seeding). This invents NO new tldraw->model
// conversion logic; every prop (color, richText, w/h, geo variant, ...)
// passes through byte-identical to what v1 itself created. See
// lib/parity.ts's `seedV2FromV1` for the implementation, including the
// parent-before-child ordering `LoroCanvasDoc.putShape` needs and the
// binding-prop-format translation described there (tldraw's
// `normalizedAnchor:{x,y}` -> canvas-model's `anchor:{nx,ny}` — the SAME
// normalized concept, a field rename, not new semantics).
//
// CAMERA: both engines are documented (canvas-editor/src/camera.ts's own
// citation of the installed @tldraw editor package) to share the identical
// `screen = (world + camera.xy) * z` convention, so v1's post-zoomToFit
// camera is read directly off `editor.getCamera()` and applied to v2
// verbatim via a `SetCamera` intent — no unit conversion needed, and both
// engines end up framing the SAME content the SAME way.
//
// ============================================================================
// A REAL BUG THIS HARNESS FOUND (fixed, not masked): ShapeLayer.tsx mapped
// `queryViewport`'s result directly for rendering. `queryViewport` answers
// from a spatial hash grid whose iteration order has NO relationship to
// document/z order — so a frame's own (fully opaque, correct-per-v1) white
// body could render AFTER, and completely occlude, one of its own note
// children. Fixed by reusing canvas-editor's existing `orderParentBeforeChild`
// (now exported; DeleteShapes' undo path already relied on it for the same
// "parent before descendant" guarantee) to sort visible shapes before
// mapping — see ShapeLayer.tsx's PAINT ORDER comment and shape-layer.test.ts
// case 7 for the regression test (proven to fail without the fix).
//
// ============================================================================
// SCORING SURFACE: this does NOT diff "the whole screenshot". v1's page
// background (plain paper color) and v2's (an always-on dotted grid over a
// different flat background — Grid.tsx's own header says "no parity claim"
// for the grid) together make a whole-canvas pixel diff explode once the
// comparator is tuned sensitive enough to catch a real color regression —
// nowhere near a "core-shape parity" concern. So the score is computed over
// an EXPLICIT list of shape-footprint rectangles (title text, each note, the
// geo/arrow area, the draw area) — see lib/parity.ts's computeParity doc
// comment (SCORING SURFACE) for the full empirical writeup, and REGIONS
// below for where each rectangle's world-space coordinates come from
// (seedGoldenBoard's own literal seeding coordinates, lib/seed.ts).
// ============================================================================
import { expect, test } from '../lib/fixtures'
import { GOLDEN_BOARD_SHAPE_COUNT, seedGoldenBoard } from '../lib/seed'
import { waitForBoot } from '../lib/canvas-v2'
import {
	applyV2Camera,
	compareOrWriteGolden,
	computeParity,
	hideV1Chrome,
	hideV2Chrome,
	readV1Camera,
	screenshotV1Canvas,
	screenshotV2Viewport,
	seedV2FromV1,
	writeParityArtifact,
	type Camera,
	type RegionMask,
} from '../lib/parity'
import type { Page } from '@playwright/test'

// Overall gate — CONSERVATIVE on purpose (bounds/plan: "start conservative;
// tighten as bodies land"). Empirically, the real golden board scores
// ~0.96-0.98 at PIXEL_THRESHOLD below; the deliberate note-color regression
// (see the regression-guard test) drops it to ~0.75. 0.90 sits with real
// headroom above the healthy case and well above the broken one — not a
// hair-trigger, but decisive.
const OVERALL_THRESHOLD = 0.9

// Lower than pixelmatch's own stock default (0.1) — the C7 finding (carried
// to this Seam): the DEFAULT comparator is close to hue-blind. 0.05 was
// chosen empirically: at 0.03 even genuinely-matching TEXT regions fail
// (cross-renderer font-antialiasing noise, not content, crosses that
// threshold almost everywhere a glyph is drawn — confirmed by probing both
// engines' real output), while 0.05 and 0.1 both leave text/note regions
// clean in the healthy case AND register the deliberate color regression
// overwhelmingly (a fully wrong-color note scores ~0.01, not a borderline
// dip) — see the regression-guard test below for the proof.
const PIXEL_THRESHOLD = 0.05

// Auto-retrying settle: shape count + a real state (fonts loaded), never a
// blind sleep alone (a short final paint-settle wait still follows, mirroring
// visual.spec.ts's own PAINT_SETTLE_MS convention — two different rendering
// stacks each get a moment to finish their own font/layout settling).
const PAINT_SETTLE_MS = 500

async function settleV1(page: Page): Promise<Camera> {
	await expect(page.locator('.tl-shape')).toHaveCount(GOLDEN_BOARD_SHAPE_COUNT, { timeout: 15_000 })
	await page.evaluate(() => {
		;(window as unknown as { __ewEditor: { zoomToFit(opts: unknown): void } }).__ewEditor.zoomToFit({ animation: { duration: 0 } })
	})
	await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready)
	await page.waitForTimeout(PAINT_SETTLE_MS)
	return readV1Camera(page)
}

async function settleV2(page: Page, camera: Camera): Promise<void> {
	await expect(page.locator('[data-shape-kind]')).toHaveCount(GOLDEN_BOARD_SHAPE_COUNT, { timeout: 15_000 })
	await applyV2Camera(page, camera)
	await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready)
	await page.waitForTimeout(PAINT_SETTLE_MS)
}

// ============================================================================
// REGIONS: one rectangle per top-level shape seedGoldenBoard creates (lib/
// seed.ts), in WORLD coordinates copied verbatim from that function's own
// literal x/y/w/h arguments — converted to the shared screen-space via
// `toScreen` at runtime against whatever camera v1's zoomToFit actually
// lands on. `countsTowardOverall: true` shapes are expected to match
// tightly (this is the harness's real acceptance bar); `false` ones are
// documented, already-known-deferred gaps, independently reported and
// tolerance-checked but excluded from the headline number (lib/parity.ts's
// computeParity SCORING SURFACE comment explains why).
// ============================================================================
function goldenBoardRegions(camera: Camera): RegionMask[] {
	const toScreen = (x: number, y: number, w: number, h: number) => ({
		x: Math.round((x + camera.x) * camera.z),
		y: Math.round((y + camera.y) * camera.z),
		width: Math.round(w * camera.z),
		height: Math.round(h * camera.z),
	})
	return [
		// text 'Golden Board' — lib/seed.ts: `{ type: 'text', x: 100, y: 40, ... }`.
		// w:300 is tldraw's own autoSize default for a short single-line text at
		// the default 's' size; h:40 matches the rendered footprint measured
		// directly off both engines during calibration.
		{ name: 'title', box: toScreen(100, 40, 300, 40), tolerance: 0.15, reason: 'title text — in scope, tight', countsTowardOverall: true },
		// notes — lib/seed.ts: frame-local (40, 40/260/480/…) inside the
		// `Planning` frame at (100,120), plus one outlier at page coords
		// (420,320) — both offsets pre-added here since this fixture nests only
		// one level deep. tldraw notes are a FIXED 200x200 (seed.ts's own
		// comment), matching NoteShape's rendered size exactly.
		{ name: 'note-alpha', box: toScreen(140, 160, 200, 200), tolerance: 0.1, reason: 'note (color fill) — in scope, tight; the DoD #2 regression target', countsTowardOverall: true },
		{ name: 'note-beta', box: toScreen(140, 380, 200, 200), tolerance: 0.1, reason: 'note (color fill) — in scope, tight', countsTowardOverall: true },
		{ name: 'note-gamma', box: toScreen(140, 600, 200, 200), tolerance: 0.1, reason: 'note (color fill) — in scope, tight', countsTowardOverall: true },
		{ name: 'note-outlier', box: toScreen(520, 440, 200, 200), tolerance: 0.1, reason: 'note (color fill) — in scope, tight', countsTowardOverall: true },
		// geo (rectangle 'A' + ellipse 'B') + the bound arrow between them —
		// lib/seed.ts: rect at (820,160,160,100), ellipse at (820,420,160,100),
		// arrow bound rect->ellipse. Combined into ONE region (their real
		// footprints + the arrow's own spurious BoxShape placeholder — 'arrow'
		// isn't excluded from ShapeLayer's generic per-shape body pass the way
		// embed kinds are, so it renders BOTH the correct SVG-overlay line AND
		// an extra generic box — all sit inside this bounding rect). Toleranced,
		// not tight: v1's default `dash: 'draw'` renders a hand-wobble stroke
		// (canvas-phase4-parity.md's Carried Findings, C4) that v2's GeoShape
		// draws as a clean stroke — a real, DOCUMENTED, deferred gap, not a
		// regression.
		{
			name: 'geo-arrow',
			box: toScreen(820, 160, 180, 360),
			tolerance: 0.4,
			reason: "C4: v1 hand-wobble stroke (dash:'draw') not replicated in v2's clean stroke, PLUS arrow's own extra BoxShape-fallback box (arrow isn't excluded from ShapeLayer's generic body pass) — both documented, deferred gaps",
			countsTowardOverall: false,
		},
		// draw (ink stroke) — lib/seed.ts's deterministic points span roughly
		// (1040..1120, 200..400); v2's BoxShape fallback for 'draw' renders at
		// a FIXED 100x100 default (no w/h in props) at the shape's own x/y —
		// this rect covers both. tolerance 1.0: ink/draw tools are explicitly
		// OUT of Phase-4 scope (bounds doc's scope ceiling) — v2 has no real
		// ink-stroke body at all yet, so this region is fully excluded from any
		// pass/fail judgment, just reported for visibility.
		{ name: 'draw', box: toScreen(1040, 200, 100, 200), tolerance: 1, reason: 'bounds scope ceiling: ink/draw/eraser/line/highlight tools OUT of Phase-4 — v2 has no real ink body yet, BoxShape fallback only', countsTowardOverall: false },
	]
}

// Structural guard (the C7 fix, carried to Seam F — MUST-HEED per the
// plan): a pixel-only gate is blind to a same-lightness hue swap. Assert
// each core kind's REAL `data-shape-body` marker is present (and that the
// generic BoxShape fallback never rendered for one of these ids) —
// deterministic, independent of color/threshold tuning entirely.
async function assertCoreBodies(page: Page): Promise<void> {
	await expect(page.locator('[data-shape-body="note"]')).toHaveCount(4)
	await expect(page.locator('[data-shape-body="frame"]')).toHaveCount(1)
	await expect(page.locator('[data-shape-body="text"]')).toHaveCount(1)
	await expect(page.locator('[data-shape-body="geo"]')).toHaveCount(2)
}

test('golden board parity: v1 vs v2 (Task F1)', async ({ page, context }, testInfo) => {
	const room = `parity-golden-${testInfo.workerIndex}`
	await seedGoldenBoard(room)

	// --- v1 ---
	await page.goto(`/?room=${room}`)
	const camera = await settleV1(page)
	await hideV1Chrome(page)
	const bufV1 = await screenshotV1Canvas(page)

	// --- v2 (same room, same content via seedV2FromV1, same camera) ---
	const page2 = await context.newPage()
	await page2.goto(`/?room=${room}&engine=v2`)
	await waitForBoot(page2)
	await seedV2FromV1(page2, room)
	await settleV2(page2, camera)
	await assertCoreBodies(page2) // structural guard — independent of the pixel score below
	await hideV2Chrome(page2)
	const bufV2 = await screenshotV2Viewport(page2)

	// --- goldens (historical drift archive — see lib/parity.ts's GOLDENS doc) ---
	const updateSnapshots = testInfo.config.updateSnapshots
	compareOrWriteGolden('golden-board-v1.png', bufV1, updateSnapshots)
	compareOrWriteGolden('golden-board-v2.png', bufV2, updateSnapshots)

	// --- the real gate: masked, region-toleranced cross-renderer score ---
	const regions = goldenBoardRegions(camera)
	const result = computeParity(bufV1, bufV2, regions, { pixelThreshold: PIXEL_THRESHOLD })

	writeParityArtifact('golden-board', {
		overall: result.overall,
		overallThreshold: OVERALL_THRESHOLD,
		pixelThreshold: result.pixelThreshold,
		width: result.width,
		height: result.height,
		regions: result.regions,
	})

	for (const r of result.regions) {
		// eslint-disable-next-line no-console -- CI-visible per-region breakdown, mirrors perf.ts's console reporting convention
		console.log(`[parity] ${r.name}: score=${r.score.toFixed(4)} tolerance=${r.tolerance} withinTolerance=${r.withinTolerance} countsTowardOverall=${r.countsTowardOverall}`)
	}

	expect(result.overall, `overall parity ${result.overall.toFixed(4)} below threshold ${OVERALL_THRESHOLD} — regions: ${JSON.stringify(result.regions)}`).toBeGreaterThanOrEqual(OVERALL_THRESHOLD)
})

// ============================================================================
// DELIBERATE-REGRESSION GUARD (bounds DoD #2 — the gate must have teeth).
// Same seeding/camera/masking as the real case above, EXCEPT the v2 seed
// mutates the first note's color to 'violet' (#DB91FD — a strong hue AND
// lightness contrast against the golden board's yellow notes, #FED49A;
// simulates a plausible real regression: a color-mapping table entry gone
// wrong) before `putShape`. `test.fail()` declares this test as EXPECTED to
// fail — Playwright verifies it actually does, so this is a PERMANENT,
// GREEN part of the suite that nonetheless proves the gate trips: if a
// future change to computeParity/the thresholds ever stopped catching this
// regression, THIS test would unexpectedly PASS, and test.fail() would flag
// that as a failure — the gate losing its teeth is itself a red CI signal.
// ============================================================================
test.fail(
	'regression guard: wrong note fill color drops parity below threshold',
	async ({ page, context }, testInfo) => {
		const room = `parity-regression-${testInfo.workerIndex}`
		await seedGoldenBoard(room)

		await page.goto(`/?room=${room}`)
		const camera = await settleV1(page)
		await hideV1Chrome(page)
		const bufV1 = await screenshotV1Canvas(page)

		const page2 = await context.newPage()
		await page2.goto(`/?room=${room}&engine=v2`)
		await waitForBoot(page2)
		await seedV2FromV1(page2, room, { mutateFirstNoteColor: 'violet' })
		await settleV2(page2, camera)
		await hideV2Chrome(page2)
		const bufV2 = await screenshotV2Viewport(page2)

		const regions = goldenBoardRegions(camera)
		const result = computeParity(bufV1, bufV2, regions, { pixelThreshold: PIXEL_THRESHOLD })

		writeParityArtifact('golden-board-regression-guard', {
			overall: result.overall,
			overallThreshold: OVERALL_THRESHOLD,
			pixelThreshold: result.pixelThreshold,
			regions: result.regions,
		})

		// EXPECTED to fail: the mutated note's own region should collapse
		// (empirically ~0.01, not a borderline dip), dragging `overall` well
		// below OVERALL_THRESHOLD — proving the gate has teeth.
		expect(result.overall).toBeGreaterThanOrEqual(OVERALL_THRESHOLD)
	}
)
