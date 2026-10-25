// Cross-renderer (v1 tldraw vs v2 canvas-editor/canvas-react) parity harness
// helpers — Task F1 (canvas-phase4 plan, Seam F). Two independent jobs live
// here: (1) get the SAME logical content into both engines' stores (the
// harness is worthless if it diffs mismatched rooms — see module header of
// tests/parity.spec.ts for the full writeup of how this was solved), and
// (2) a masked, region-toleranced pixel diff + parity SCORE over the two
// resulting screenshots, written as a per-run JSON artifact.
import type { Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { API } from './fixtures.ts'

// ============================================================================
// SEEDING: v1 (tldraw store, seeded via seedGoldenBoard/lib/seed.ts) -> v2
// (Loro doc, over /sync/v2). CRITICAL PROBLEM #1's resolution (see the spec
// module header for the full narrative): reuse the EXISTING Agent-API-v2
// read endpoint (`GET /api/v2/canvas/document`, server/src/features/
// canvas-v2.ts), which already converts the live tldraw store into
// canvas-model Shape/Binding objects via `fromTldraw`
// (server/src/canvas-v2/convert.ts) — the SAME converter the shadow mirror
// (server/src/canvas-v2/shadow.ts) and every other Agent-API-v2 reader
// already trust. This harness invents NO new tldraw->model conversion; it
// just feeds that converter's own output into the v2 doc via `putShape`/
// `putBinding` (the same primitives lib/canvas-v2.ts's seedGrid/seedTerminal
// already use for doc-level seeding).
// ============================================================================

export interface ModelShape {
	readonly id: string
	readonly kind: string
	readonly parentId: string
	readonly [key: string]: unknown
}
export interface ModelBinding {
	readonly id: string
	readonly fromId: string
	readonly toId: string
	readonly props: Record<string, unknown>
	readonly meta: Record<string, unknown>
}
export interface ModelDocument {
	readonly pages: unknown[]
	readonly shapes: ModelShape[]
	readonly bindings: ModelBinding[]
}

/** Fetches the v1 room's content already converted to canvas-model shapes —
 * `GET /api/v2/canvas/document?room=`, the Agent-API-v2 read endpoint. */
export async function fetchModelDocument(room: string): Promise<ModelDocument> {
	const res = await fetch(`${API}/api/v2/canvas/document?room=${encodeURIComponent(room)}`)
	if (!res.ok) throw new Error(`GET /api/v2/canvas/document?room=${room} -> ${res.status}: ${await res.text()}`)
	const body = (await res.json()) as { pages: unknown[]; shapes: ModelShape[]; bindings: ModelBinding[] }
	return { pages: body.pages, shapes: body.shapes, bindings: body.bindings }
}

/** Parent-before-child ordering so `LoroCanvasDoc.putShape`'s `placeInTree`
 * (canvas-doc/src/loro-canvas-doc.ts) can resolve a nested shape's parent
 * node on its FIRST insertion — this harness seeds each shape exactly once,
 * so (unlike a live editing session, which self-heals a stale placement on
 * any later re-put of the same shape) the order must be correct up front. */
function topoSortShapes(shapes: readonly ModelShape[]): ModelShape[] {
	const byId = new Map(shapes.map((s) => [s.id, s]))
	const placed = new Set<string>()
	const out: ModelShape[] = []
	const visit = (s: ModelShape) => {
		if (placed.has(s.id)) return
		const parent = byId.get(s.parentId)
		if (parent) visit(parent)
		placed.add(s.id)
		out.push(s)
	}
	for (const s of shapes) visit(s)
	return out
}

export interface SeedV2Options {
	/** Deliberate-regression hook (Task F1 DoD #2 — the gate must have
	 * teeth): mutate the FIRST `note` shape's `props.color` to this value
	 * before seeding, simulating a wrong-fill-color regression (the task's
	 * own suggested break). `'violet'` (#DB91FD) is a strong hue+lightness
	 * contrast against the golden board's `'yellow'` (#FED49A) notes — see
	 * NoteShape.tsx's NOTE_FILL palette. */
	readonly mutateFirstNoteColor?: string
}

/** Seeds a v2 room's live Loro doc with the SAME logical shapes/bindings a
 * v1 (tldraw) room already has, via `window.__ew.doc.putShape`/`putBinding`
 * (the exact mechanism lib/canvas-v2.ts's seedGrid/seedTerminal already
 * use). Requires the v2 session to already be booted (waitForBoot) on
 * `page`, navigated to the SAME room id the v1 content was seeded into.
 *
 * BINDING FORMAT TRANSLATION (a real, load-bearing gap this harness found
 * and had to bridge, NOT invented conversion logic): `fromTldraw` passes
 * binding props through VERBATIM from the tldraw record, so an arrow
 * binding's props look like tldraw's own `{ terminal, normalizedAnchor:
 * {x,y}, isExact, isPrecise, snap }`. canvas-model's OWN arrow-route.ts
 * (`resolveEndpoint`) instead reads `{ terminal, anchor: {nx, ny} }` —
 * calling putBinding with the raw tldraw-shaped props throws inside
 * Arrows.tsx (`anchorToWorld` reads `.anchor.nx` of `undefined`). Both
 * `normalizedAnchor.{x,y}` (tldraw's own TLArrowBinding schema) and
 * `anchor.{nx,ny}` (arrow-route.ts's own ARROW PROPS SCHEMA doc comment) are
 * independently documented as the SAME normalized 0..1 anchor-within-target
 * concept — this is a field rename, not a new semantic, so translating it
 * here is safe. Skipping bindings entirely was considered (an unbound arrow
 * still draws from its own stale x/y + props.end, which happen to
 * reproduce the same endpoints for a board that's never moved since
 * creation) but would silently lose the boundary-clipping v1 actually
 * renders (a bound arrow stops at the target's edge, not its center) —
 * translating the anchor is more faithful and no less safe. */
export async function seedV2FromV1(page: Page, room: string, opts: SeedV2Options = {}): Promise<void> {
	const doc = await fetchModelDocument(room)
	let shapes = topoSortShapes(doc.shapes)
	if (opts.mutateFirstNoteColor) {
		const color = opts.mutateFirstNoteColor
		let mutated = false
		shapes = shapes.map((s) => {
			if (!mutated && s.kind === 'note') {
				mutated = true
				return { ...s, props: { ...(s.props as Record<string, unknown>), color } }
			}
			return s
		})
		if (!mutated) throw new Error('mutateFirstNoteColor requested but the room has no note shapes')
	}
	await page.evaluate(
		({ shapes, bindings }) => {
			const ew = (window as unknown as { __ew: { doc: { putShape(s: unknown): void; putBinding(b: unknown): void; commit(): void } } }).__ew
			for (const s of shapes) ew.doc.putShape(s)
			for (const b of bindings) {
				const na = (b.props as { normalizedAnchor?: { x: number; y: number } } | undefined)?.normalizedAnchor
				const terminal = (b.props as { terminal?: string } | undefined)?.terminal
				const props = na ? { terminal, anchor: { nx: na.x, ny: na.y } } : b.props
				ew.doc.putBinding({ ...b, props })
			}
			ew.doc.commit()
		},
		{ shapes, bindings: doc.bindings }
	)
}

// ============================================================================
// CAMERA: both engines documented (canvas-editor/src/camera.ts's citation of
// the installed @tldraw editor package) to share the IDENTICAL convention
// `screen = (world + camera.xy) * z` — so v1's OWN post-zoomToFit camera can
// be read off `editor.getCamera()` and applied to v2 verbatim via a
// `SetCamera` intent, with no unit/sign conversion needed.
// ============================================================================

export interface Camera {
	readonly x: number
	readonly y: number
	readonly z: number
}

/** Reads tldraw's current camera (call AFTER `ed.zoomToFit(...)`). */
export async function readV1Camera(page: Page): Promise<Camera> {
	return page.evaluate(() => {
		const ed = (window as unknown as { __ewEditor: { getCamera(): { x: number; y: number; z: number } } }).__ewEditor
		const c = ed.getCamera()
		return { x: c.x, y: c.y, z: c.z }
	})
}

/** Applies `camera` to the v2 session via a `SetCamera` intent — mirrors
 * lib/canvas-v2.ts's `setCameraZoom`, generalized to also set x/y so this
 * can match v1's zoomToFit result exactly, not just a zoom level. */
export async function applyV2Camera(page: Page, camera: Camera): Promise<void> {
	await page.evaluate((camera) => {
		const ew = (window as unknown as { __ew: { editor: { applyAll(intents: readonly unknown[]): void } } }).__ew
		ew.editor.applyAll([{ type: 'SetCamera', x: camera.x, y: camera.y, z: camera.z }])
	}, camera)
}

// ============================================================================
// CHROME: each engine's own non-canvas UI would otherwise bleed into a
// locator screenshot of its canvas root (both `.tl-canvas` and
// `[data-canvas-v2-viewport]` span their FULL container, and v1's toolbar/
// license-watermark and v2's DevOverlay are absolutely/fixed-positioned
// OVER that same area, not physically outside it). Hidden via `display:
// none` rather than pixel-masked: simpler, and immune to either chrome
// element's own size changing (a longer connection-state string, a
// different zoom-% readout, ...).
// ============================================================================

export async function hideV1Chrome(page: Page): Promise<void> {
	await page.evaluate(() => {
		for (const sel of ['.tlui-toolbar', '[class*="tl-watermark"]']) {
			for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.display = 'none'
		}
	})
}

export async function hideV2Chrome(page: Page): Promise<void> {
	await page.evaluate(() => {
		// `[data-canvas-v2-dev-overlay]`: debug telemetry panel, always shown
		// under Vite dev (DevOverlay.tsx's shouldShowDevOverlay — true
		// whenever `import.meta.env.DEV`, which every e2e run is).
		// `[data-canvas-layer="grid"]`: canvas-react's dotted background grid
		// (Grid.tsx) is unconditional and its OWN module header says so
		// explicitly — "ZOOM / FADE POLICY (OURS, simple — no parity claim)".
		// v1 shows a plain paper background by default (no grid), so with the
		// grid left in, EVERY background pixel registers as a diff at any
		// pixel threshold sensitive enough to catch a real hue regression
		// (empirically confirmed: unmasked ratio jumped from ~3% to ~59% once
		// the threshold crossed the dot-vs-flat-background color delta) —
		// nowhere near a "core-shape parity" gap, so it's hidden like the
		// other chrome, not scored around.
		for (const sel of ['[data-canvas-v2-dev-overlay]', '[data-canvas-layer="grid"]']) {
			const el = document.querySelector<HTMLElement>(sel)
			if (el) el.style.display = 'none'
		}
	})
}

/** v1's canvas root is narrower than the viewport (App.tsx's fixed layout
 * reserves a column for SidePanel), and v2's is shorter (CanvasV2App
 * reserves vertical space above `[data-canvas-v2-viewport]` for the
 * connection banner) — the two locator screenshots are legitimately
 * DIFFERENT pixel dimensions. `computeParity` below crops both to their
 * shared top-left (min width, min height) region before diffing, so this
 * does not need to be reconciled here. */
export async function screenshotV1Canvas(page: Page): Promise<Buffer> {
	return page.locator('.tl-canvas').screenshot()
}
export async function screenshotV2Viewport(page: Page): Promise<Buffer> {
	return page.locator('[data-canvas-v2-viewport]').screenshot()
}

// ============================================================================
// MASKED DIFF + SCORE
// ============================================================================

export interface RegionMask {
	readonly name: string
	/** Pixel rect in the SHARED (post-crop) coordinate space both
	 * screenshots are compared in. */
	readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
	/** Max acceptable diff ratio WITHIN this region (0..1) — pixels here
	 * still count toward the region's own reported score, just not at the
	 * strict global tolerance. */
	readonly tolerance: number
	/** WHY this region is masked/toleranced — cites the specific carried
	 * finding, never a bare "known gap". */
	readonly reason: string
	/** Whether this region's pixels feed the aggregate `overall` figure.
	 * `true` for an in-scope shape whose parity should hold tightly (a
	 * note, the title text — the DoD #2 regression target lives here);
	 * `false` for a documented, deferred gap (geo/arrow dash-wobble, the
	 * draw-tool BoxShape fallback) that's still independently reported and
	 * tolerance-checked, just not allowed to sink (or inflate) the headline
	 * number. See computeParity's SCORING SURFACE doc comment for why
	 * "overall" is an aggregate over explicit shape regions at all, rather
	 * than the whole screenshot. */
	readonly countsTowardOverall: boolean
}

export interface RegionScore {
	readonly name: string
	readonly diffPixels: number
	readonly totalPixels: number
	readonly score: number
	readonly tolerance: number
	readonly withinTolerance: boolean
	readonly countsTowardOverall: boolean
}

export interface ParityResult {
	readonly width: number
	readonly height: number
	/** Aggregate score over every region with `countsTowardOverall: true` —
	 * 1 - (their summed diffPixels / their summed totalPixels). This is
	 * what the spec gates on. */
	readonly overall: number
	readonly overallDiffPixels: number
	readonly overallTotalPixels: number
	readonly regions: readonly RegionScore[]
	/** Pixelmatch's own color-delta threshold used for this run (see
	 * computeParity's CALIBRATION doc comment) — recorded so the artifact is
	 * self-describing. */
	readonly pixelThreshold: number
}

const DEFAULT_PIXEL_THRESHOLD = 0.03

/**
 * Region-by-region pixel diff between two same-content screenshots of the
 * SAME room (one per engine), aggregated into an overall parity score.
 *
 * SCORING SURFACE (a Task F1 finding — read before changing `regions`):
 * this does NOT diff "the whole screenshot minus a few masked gaps". It was
 * built that way first, then abandoned: v1's page background (a plain paper
 * color) and v2's (an always-on dotted grid, PLUS a different flat
 * background color underneath it — Grid.tsx's own header says "no parity
 * claim" for the grid, and this harness independently found the base
 * background color also differs) together make the RAW background diff
 * ratio explode from ~3% to ~60% the moment the pixel threshold is tuned
 * sensitive enough to catch a real hue-only regression (see git history /
 * the module's empirical probe notes) — nowhere near a "core-shape parity"
 * concern, but big enough to swamp any real signal if left in whole-canvas
 * scoring. So `regions` here is an EXHAUSTIVE, explicit list of named
 * shape-footprint rectangles (title text, each note, the geo/arrow/draw
 * areas) — background pixels outside every listed region are never sampled
 * at all, neither helping nor hurting the score. `countsTowardOverall`
 * then splits that same list into "should closely match" (fed into
 * `overall`) vs. "documented, deferred gap" (reported/tolerance-checked on
 * its own, excluded from `overall` so it can't mask a real regression
 * elsewhere by sheer pixel-count weight, nor get unfairly penalized for a
 * gap this phase already knows about and accepts).
 *
 * CALIBRATION (the C7 finding, carried to Seam F — MUST-HEED): Playwright's
 * own default screenshot comparator uses pixelmatch's default `threshold:
 * 0.1`, which — because pixelmatch's YIQ color-delta weights luma (Y) far
 * more than chroma (I/Q) — is close to BLIND to a same-lightness hue-only
 * change (C7's proof: a body->placeholder swap passed 17/18 screenshot
 * tests at the default `maxDiffPixelRatio: 0.02`). This function defaults to
 * a much lower `threshold` (0.03, vs pixelmatch's stock 0.1) specifically so
 * a hue-only regression (e.g. this file's own `mutateFirstNoteColor`
 * fixture) registers as a real diff-pixel-ratio increase rather than being
 * absorbed by the luma-dominant default — see parity.spec.ts's regression
 * case for the empirical proof this actually moves the score. This is still
 * paired with, never a substitute for, the STRUCTURAL `data-shape-body`
 * assertion the spec also runs (the C7 fix itself) — a hue-sensitive
 * threshold catches a wrong-COLOR regression; only the structural check
 * deterministically catches a wrong-BODY (component) regression, since two
 * different bodies can coincidentally render similar overall luminance.
 */
export function computeParity(
	bufA: Buffer,
	bufB: Buffer,
	regions: readonly RegionMask[],
	opts: { readonly pixelThreshold?: number } = {}
): ParityResult {
	const pixelThreshold = opts.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD
	const a = PNG.sync.read(bufA)
	const b = PNG.sync.read(bufB)
	const width = Math.min(a.width, b.width)
	const height = Math.min(a.height, b.height)
	if (width <= 0 || height <= 0) throw new Error(`no overlapping region to compare: a=${a.width}x${a.height} b=${b.width}x${b.height}`)

	// Crop both to the shared top-left region (screenshotV1Canvas/
	// screenshotV2Viewport's own docs explain why the two engines' canvas
	// roots are legitimately different pixel sizes).
	const cropA = new PNG({ width, height })
	const cropB = new PNG({ width, height })
	PNG.bitblt(a, cropA, 0, 0, width, height, 0, 0)
	PNG.bitblt(b, cropB, 0, 0, width, height, 0, 0)

	const regionScoreOf = (box: RegionMask['box']): { diffPixels: number; totalPixels: number } => {
		const rx = Math.max(0, box.x)
		const ry = Math.max(0, box.y)
		const rw = Math.max(0, Math.min(box.x + box.width, width) - rx)
		const rh = Math.max(0, Math.min(box.y + box.height, height) - ry)
		if (rw <= 0 || rh <= 0) return { diffPixels: 0, totalPixels: 0 }
		const rA = new PNG({ width: rw, height: rh })
		const rB = new PNG({ width: rw, height: rh })
		PNG.bitblt(cropA, rA, rx, ry, rw, rh, 0, 0)
		PNG.bitblt(cropB, rB, rx, ry, rw, rh, 0, 0)
		const rDiff = new PNG({ width: rw, height: rh })
		const d = pixelmatch(rA.data, rB.data, rDiff.data, rw, rh, { threshold: pixelThreshold, includeAA: false })
		return { diffPixels: d, totalPixels: rw * rh }
	}

	const scored: RegionScore[] = regions.map((m) => {
		const { diffPixels, totalPixels } = regionScoreOf(m.box)
		const score = totalPixels === 0 ? 1 : 1 - diffPixels / totalPixels
		return {
			name: m.name,
			diffPixels,
			totalPixels,
			score,
			tolerance: m.tolerance,
			withinTolerance: 1 - score <= m.tolerance,
			countsTowardOverall: m.countsTowardOverall,
		}
	})

	const inScope = scored.filter((r) => r.countsTowardOverall)
	const overallDiffPixels = inScope.reduce((sum, r) => sum + r.diffPixels, 0)
	const overallTotalPixels = inScope.reduce((sum, r) => sum + r.totalPixels, 0)
	const overall = overallTotalPixels <= 0 ? 1 : 1 - overallDiffPixels / overallTotalPixels

	return { width, height, overall, overallDiffPixels, overallTotalPixels, regions: scored, pixelThreshold }
}

// ============================================================================
// ARTIFACT: mirrors lib/perf.ts's `record` merge-by-key pattern, written to
// a gitignored per-run results dir (e2e/.gitignore already carries
// `.artifacts/` — this is its first consumer) rather than a committed
// baseline file: the parity SCORE is a live diagnostic CI uploads per run
// (Task F2), not a golden value future runs are asserted against.
// ============================================================================

const ARTIFACT_FILE = path.join(import.meta.dirname, '../.artifacts/parity/parity-score.json')

export function writeParityArtifact(key: string, value: Record<string, unknown>): void {
	mkdirSync(path.dirname(ARTIFACT_FILE), { recursive: true })
	const all = existsSync(ARTIFACT_FILE) ? JSON.parse(readFileSync(ARTIFACT_FILE, 'utf8')) : {}
	all[key] = { ...value, _meta: { capturedAt: new Date().toISOString() } }
	writeFileSync(ARTIFACT_FILE, JSON.stringify(all, null, 2) + '\n')
}

// ============================================================================
// GOLDENS: committed baseline PNGs under e2e/goldens/parity/ (Task F1's own
// file list) — a HISTORICAL drift check ("has either engine's rendering
// visibly changed since this was last captured"), independent of and
// secondary to the real gate (`computeParity`'s per-run v1-vs-v2 score
// above, which needs no stored baseline at all — it compares the two LIVE
// captures to each other, every run). Deliberately NOT Playwright's own
// `toHaveScreenshot`: that API's snapshot directory is a PROJECT-level
// `snapshotPathTemplate` (playwright.config.ts) shared by every spec file,
// and this task's goldens belong in their OWN `goldens/parity/` directory,
// a sibling of (not nested under) the existing `goldens/visual/` — moving
// or overriding the shared template would touch config every other spec
// (`visual.spec.ts`, `component-goldens.spec.ts`) also depends on. This
// small hand-rolled compare-or-write mirrors the same two-phase workflow
// (`--update-snapshots` captures; a plain run compares) with none of that
// blast radius.
// ============================================================================

const GOLDENS_DIR = path.join(import.meta.dirname, '../goldens/parity')

export interface GoldenCompareResult {
	readonly created: boolean
	/** `null` when freshly created (nothing to compare against yet). */
	readonly diffRatio: number | null
}

/** Writes `buf` as the golden if none exists yet (or `updateSnapshots ===
 * 'all'` — the literal effect of the `--update-snapshots` CLI flag, read
 * off `testInfo.config.updateSnapshots`); otherwise compares against the
 * existing golden at a generous, drift-only tolerance (this is a "did the
 * picture change at all" sanity check, not the calibrated cross-renderer
 * gate — that's `computeParity`, run separately every time on the two live
 * captures). */
export function compareOrWriteGolden(name: string, buf: Buffer, updateSnapshots: string): GoldenCompareResult {
	mkdirSync(GOLDENS_DIR, { recursive: true })
	const file = path.join(GOLDENS_DIR, name)
	if (!existsSync(file) || updateSnapshots === 'all') {
		writeFileSync(file, buf)
		return { created: true, diffRatio: null }
	}
	const golden = PNG.sync.read(readFileSync(file))
	const fresh = PNG.sync.read(buf)
	const width = Math.min(golden.width, fresh.width)
	const height = Math.min(golden.height, fresh.height)
	const g = new PNG({ width, height })
	const f = new PNG({ width, height })
	PNG.bitblt(golden, g, 0, 0, width, height, 0, 0)
	PNG.bitblt(fresh, f, 0, 0, width, height, 0, 0)
	const diff = new PNG({ width, height })
	const diffPixels = pixelmatch(g.data, f.data, diff.data, width, height, { threshold: 0.1, includeAA: false })
	return { created: false, diffRatio: diffPixels / (width * height) }
}
