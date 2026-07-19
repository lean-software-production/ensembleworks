// TIME-TO-FIRST-SHAPE harness for canvas v2 (and the v1 comparison arm).
//
// THE METRIC: `firstShapeMs` — page navigation start -> the first PRE-SEEDED
// shape becoming visible in the DOM. Explicitly NOT lib/canvas-v2.ts's
// `waitForBoot` toolbar signal: the toolbar can appear long before shapes do,
// and that gap is exactly the user-visible symptom this harness hunts. The gap
// is recorded as its own sub-split (`toolbarToFirstShapeMs`).
//
// SEEDING GOES OVER THE WIRE (lib/wire-seed.ts): a headless SyncClientPeer
// commits the shapes into the real room actor over a real /sync/v2 WebSocket
// BEFORE the browser navigates, so the browser's first paint travels the
// genuine backfill path. The existing canvas-v2-perf.spec.ts seeds via
// `window.__ew.doc` AFTER boot — deliberately, for its own frame-rate subject,
// but that bypasses the wire path entirely and is therefore useless here.
//
// PRODUCTION BUILD ONLY: this spec runs under playwright.load.config.ts, whose
// webServer serves a real `vite build` via `vite preview`. See that file's
// header for why the dev server would mis-attribute the budget.
//
// GATING — READ THIS BEFORE CHANGING AN ASSERTION. This spec DEPARTS, on
// purpose, from the "p95 hard / max advisory" convention documented in
// e2e/perf/canvas-v2-perf.spec.ts and in the repo's perf-gate memo:
//   - p50 (the MEDIAN) is the HARD gate.
//   - max and cvPct are ADVISORY (::warning:: annotations; the test still
//     passes). min/spread are observed-only.
//   - There is deliberately NO p95. The house percentile formula is
//     sorted[floor(q*len)], and floor(0.95*n) === n-1 for every n <= 20, so at
//     REPS=5 a "p95" would be identically the max — the single worst of five
//     samples, i.e. the noisiest statistic available and the one most likely
//     to flake on a shared runner. That convention is sound in the frame-rate
//     spec because one run there yields HUNDREDS of frame samples and the tail
//     is the subject; one run HERE yields FIVE whole page loads, where the
//     subject is what a user typically gets. See the plan's CHANGE NOTE
//     (docs/plans/2026-07-19-v2-first-shape-perf-harness.md, 2026-07-19).
//   - Accepted blind spot: a median gate will not catch a BIMODAL regression
//     (e.g. 40% of loads slow). That is what the max and cvPct advisories are
//     for — such a regression blows the spread and warns loudly.
//   - The SMALL/WARM scenario is gated against an ABSOLUTE budget.
//   - Every LARGER scenario is gated against its COMMITTED baseline (+15%,
//     times the CI-noise margin).
//   - Baselines are loaded at MODULE SCOPE from the committed file, BEFORE any
//     EW_CAPTURE write, so a capture run can never compare itself to itself.
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect, identityState } from '../lib/fixtures'
import { recordTo, capturing } from '../lib/perf'
import { summarize, attribute, type LoadSample, type Summary } from '../lib/load-metrics'
import { installLoadProbe, readLoadSample, V2_SHAPE_SELECTOR, V2_TOOLBAR_SELECTOR, V1_SHAPE_SELECTOR } from '../lib/load-probe'
import { seedRoomOverWire, evictRoomActor, type SeedMode } from '../lib/wire-seed'
import { shape as httpShape } from '../lib/seed'

const WS_BASE = 'ws://127.0.0.1:8788'
const HTTP_BASE = 'http://127.0.0.1:8788'
const FILE = path.join(import.meta.dirname, '../baselines/canvas-v2-load.json')
const recordedBaselines: Record<string, any> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}

/** Repetitions per scenario. MUST STAY ODD: the house pick(0.5) returns the
 * exact middle sample at odd n (floor(0.5*5)=2, the 3rd of 5) and the
 * upper-middle at even n. 5 buys a median robust to two anomalous reps — the
 * shared-runner failure mode — at 25 full production-build navigations across
 * the whole matrix. Raising it to the 21 a real p95 would need is ~4.2x the
 * measurement wall-clock to buy the second-worst of 21 instead of the worst of
 * 5: still a noise-dominated tail statistic. Not worth it. If you do raise it,
 * go 5 -> 7 -> 9, and raise the CI timeout with it. */
const REPS = 5

/** Same documented CI-noise multiplier as canvas-v2-perf.spec.ts, but note the
 * narrower justification here: it covers SYSTEMATIC host-speed difference (a
 * shared runner is genuinely slower hardware than the box a baseline was
 * captured on — a whole-distribution shift no statistic can absorb). EPISODIC
 * contention is handled by gating on the median instead, so the two are not
 * double-counting the same noise. One margin constant across both perf specs,
 * not two competing fudge factors. Shrink toward 1.0 once baselines are
 * captured on the runner itself. */
const CI_MARGIN_MULTIPLIER = 2
const REGRESSION_BUDGET = 0.15

/** ADVISORY threshold for the coefficient of variation. Above this, the reps
 * disagree enough that the run's numbers should be read with suspicion even
 * though the median gate passed — the earliest honest signal that a
 * measurement is degrading. Provisional: Task 9 records the CVs actually
 * observed at capture and tunes this from that evidence. Never a hard gate. */
const SPREAD_ADVISORY_CV_PCT = 25

/** ABSOLUTE budget for the small/warm scenario — the one hard gate that does
 * not depend on a recorded baseline. SET THIS FROM YOUR FIRST REAL CAPTURE
 * (plan Task 9, Step 3): round the observed p50 UP to the next 250ms. It is
 * multiplied by CI_MARGIN_MULTIPLIER at the gate, and both the raw and the
 * margined figure are printed, so retuning is a one-constant change with the
 * evidence beside it. */
const SMALL_WARM_BUDGET_MS = 0 // TASK 9 STEP 3 SETS THIS — 0 fails loudly until then

function engineVersion(): string {
	const editorPkg = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../canvas-editor/package.json'), 'utf8'))
	const reactPkg = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../canvas-react/package.json'), 'utf8'))
	return `canvas-editor@${editorPkg.version}+canvas-react@${reactPkg.version}`
}

function measuredCommit(): string {
	if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
	try {
		return execSync('git rev-parse HEAD', { cwd: import.meta.dirname }).toString().trim()
	} catch {
		return '<unknown — git rev-parse failed and GITHUB_SHA is unset>'
	}
}

function maybeRecord(key: string, value: Record<string, unknown>) {
	if (!capturing) return
	mkdirSync(path.dirname(FILE), { recursive: true })
	recordTo(FILE, key, value, engineVersion())
}

/** Runs one scenario `REPS` times, each in a FRESH browser context (cold HTTP
 * cache every iteration — the first-visit experience the complaint is about;
 * a reload would reuse the cache and the compiled-WASM cache and silently
 * measure something else). Returns per-rep attributions.
 *
 * `origin` is threaded through to identityState explicitly rather than relying
 * on its default: that default is 'http://127.0.0.1:5273' (the SHARED e2e
 * rig's port), but this harness's own config (playwright.load.config.ts)
 * serves the client on :5274. fixtures.ts's own doc comment on identityState
 * warns about exactly this — a hardcoded/defaulted origin "silently no-ops on
 * any other origin": the localStorage identity would land on the wrong
 * origin, onboarding's window.prompt would fire, and (because these contexts
 * are created directly from `browser`, bypassing the `test.extend` page
 * fixture's dialog guard) that prompt would be auto-dismissed by Playwright
 * with no error — a silent hang/timeout with a misleading symptom, not a
 * clean failure. */
async function runScenario(
	browser: import('@playwright/test').Browser,
	origin: string,
	opts: { room: string; count: number; mode: SeedMode; engineParam: 'v2' | null; cold?: boolean },
) {
	const samples: LoadSample[] = []
	for (let rep = 0; rep < REPS; rep++) {
		const room = `${opts.room}-r${rep}`
		const seeded = await seedRoomOverWire({ base: WS_BASE, room, count: opts.count, mode: opts.mode })
		expect(seeded.count, 'seeder must have landed the requested shape count').toBe(opts.count)

		// COLD: seedRoomOverWire has already closed both its peers, so no live
		// socket vetoes the sweep. The very next connection — the browser's — pays
		// the full snapshot-load + oplog-replay cost.
		if (opts.cold) await evictRoomActor(HTTP_BASE, room)

		const context = await browser.newContext({
			storageState: identityState('E2E One', 'e2e-user-0000-0000-0001', origin),
			viewport: { width: 1280, height: 720 },
		})
		const page = await context.newPage()
		await installLoadProbe(page, {
			shapeSelector: V2_SHAPE_SELECTOR,
			toolbarSelector: V2_TOOLBAR_SELECTOR,
			chunkPattern: 'CanvasV2App',
		})
		const url = opts.engineParam === 'v2' ? `/?room=${room}&engine=v2` : `/?room=${room}`
		await page.goto(url)
		const sample = await readLoadSample(page, 120_000)
		console.log(`[v2-load][RAW][${opts.room}][rep=${rep}] ${JSON.stringify(sample)}`)
		samples.push(sample)
		await context.close()
	}
	return samples.map(attribute)
}

function report(label: string, attrs: ReturnType<typeof attribute>[]) {
	const pick = (f: (a: ReturnType<typeof attribute>) => number | null): Summary | null => {
		const vals = attrs.map(f).filter((v): v is number => v !== null)
		return vals.length === 0 ? null : summarize(vals)
	}
	const out = {
		firstShapeMs: summarize(attrs.map((a) => a.firstShapeMs)),
		wsOpenMs: pick((a) => a.wsOpenMs),
		chunkResponseEndMs: pick((a) => a.chunkResponseEndMs),
		toolbarMs: pick((a) => a.toolbarMs),
		chunkToToolbarMs: pick((a) => a.chunkToToolbarMs),
		toolbarToFirstShapeMs: pick((a) => a.toolbarToFirstShapeMs),
	}
	// p50 first because it is the gated statistic; spread/cv alongside because a
	// median with no dispersion beside it is a number a reader cannot judge.
	const f = (s: Summary | null) => (s === null ? 'n/a' : `p50=${s.p50ms} min=${s.minms} max=${s.maxms} spread=${s.spreadMs} cv=${s.cvPct}%`)
	console.log(
		`[v2-load] ${label} (n=${out.firstShapeMs.n})\n` +
			`  firstShapeMs         ${f(out.firstShapeMs)}   <- PRIMARY\n` +
			`  wsOpenMs             ${f(out.wsOpenMs)}\n` +
			`  chunkResponseEndMs   ${f(out.chunkResponseEndMs)}\n` +
			`  toolbarMs            ${f(out.toolbarMs)}\n` +
			`  chunkToToolbarMs     ${f(out.chunkToToolbarMs)}   <- module eval + WASM init + boot\n` +
			`  toolbarToFirstShapeMs ${f(out.toolbarToFirstShapeMs)}  <- THE GAP`,
	)
	return out
}

function warn(label: string, message: string) {
	const line = `::warning title=v2-load ${label}::${message}`
	console.log(line)
	test.info().annotations.push({ type: 'warning', description: line })
}

/** The dispersion advisory, shared by both gates. Independent of whether the
 * hard gate passed — which is the whole point: on a shared runner a widening
 * spread is the earliest sign that a measurement is going bad, and it must be
 * able to speak up in a run that is otherwise green. (In the pre-revision
 * design the advisory branch was UNREACHABLE, because it tested the same
 * number the hard assert had already thrown on. See the CHANGE NOTE.) */
function reportDispersion(label: string, s: Summary) {
	console.log(`[v2-load] ${label}: dispersion min=${s.minms}ms max=${s.maxms}ms spread=${s.spreadMs}ms cv=${s.cvPct}% over n=${s.n} [ADVISORY]`)
	if (s.cvPct > SPREAD_ADVISORY_CV_PCT) {
		warn(label, `first-shape reps disagree by cv=${s.cvPct}% (spread ${s.spreadMs}ms over n=${s.n}), above the ${SPREAD_ADVISORY_CV_PCT}% advisory threshold — read this run's numbers with suspicion even though the median gate passed`)
	}
}

/** p50 HARD against an absolute budget; max and dispersion ADVISORY. Follows
 * canvas-v2-perf.spec.ts's assertBudget in shape and in its refusal to pass
 * with an unset budget — but gates on the MEDIAN, not p95. See the module
 * header's GATING block for why. */
function assertBudget(label: string, s: Summary, budgetMs: number) {
	const gate = budgetMs * CI_MARGIN_MULTIPLIER
	console.log(`[v2-load] ${label}: p50=${s.p50ms}ms vs raw budget ${budgetMs}ms, gated at ${gate}ms (${CI_MARGIN_MULTIPLIER}x CI margin) [HARD]`)
	expect(budgetMs, 'SMALL_WARM_BUDGET_MS is unset — capture a baseline and set it (plan Task 9 Step 3)').toBeGreaterThan(0)
	expect(s.p50ms, `${label}: median first-shape time must stay within the margined budget`).toBeLessThanOrEqual(gate)
	// Reachable precisely because the hard gate is a DIFFERENT statistic: the
	// median can pass while the worst rep blew the budget. That is the
	// one-bad-rep case — worth a human's attention, never a CI failure.
	if (s.maxms > gate) {
		warn(label, `worst rep ${s.maxms}ms exceeds gate ${gate}ms while the median (${s.p50ms}ms) passed — one slow load out of ${s.n}, advisory only`)
	}
	reportDispersion(label, s)
}

/** p50 HARD against the COMMITTED baseline; max and dispersion ADVISORY.
 * Follows canvas-v2-perf.spec.ts's assertNoRegression, including its refusal
 * to silently skip when no baseline exists — but gates on the MEDIAN. */
function assertNoRegression(label: string, s: Summary, key: string) {
	const baseline = recordedBaselines[key]?.firstShapeMs
	if (!baseline || typeof baseline.p50ms !== 'number') {
		throw new Error(
			`${label}: no committed firstShapeMs.p50ms baseline to gate against — capture one first ` +
				`(EW_CAPTURE=1 bun run perf:load) and COMMIT e2e/baselines/canvas-v2-load.json, then reruns gate against it.`,
		)
	}
	const gate = baseline.p50ms * (1 + REGRESSION_BUDGET) * CI_MARGIN_MULTIPLIER
	console.log(`[v2-load] ${label}: p50=${s.p50ms}ms (baseline ${baseline.p50ms}ms, gated ${gate.toFixed(2)}ms = +15% x ${CI_MARGIN_MULTIPLIER}x) [HARD]`)
	expect(s.p50ms, `${label}: median first-shape time should stay within 15% (CI-margined) of the committed baseline`).toBeLessThanOrEqual(gate)
	if (typeof baseline.maxms === 'number' && s.maxms > baseline.maxms * (1 + REGRESSION_BUDGET) * CI_MARGIN_MULTIPLIER) {
		warn(label, `worst rep ${s.maxms}ms exceeds the advisory max gate (baseline max ${baseline.maxms}ms) while the median passed`)
	}
	reportDispersion(label, s)
}

test.describe('canvas-v2 time-to-first-shape', () => {
	test.beforeAll(() => {
		const isPR = process.env.GITHUB_EVENT_NAME === 'pull_request'
		console.log(
			`[v2-load] provenance: measured commit ${measuredCommit()}` +
				(isPR ? ' — GITHUB_EVENT_NAME=pull_request: this is the MERGE PREVIEW of the PR branch merged into its base, NOT the PR branch alone' : ''),
		)
		const p = recordedBaselines._provenance
		console.log(p ? `[v2-load] baseline provenance: host=${p.host} date=${p.date} — ${p.note}` : `[v2-load] baseline provenance: none recorded in ${path.relative(process.cwd(), FILE)}`)
	})

	test('v2 load @ 100 shapes, bulk commit, warm actor', async ({ browser, baseURL }) => {
		const attrs = await runScenario(browser, baseURL ?? 'http://127.0.0.1:5274', { room: 'v2load-small-warm', count: 100, mode: 'bulk', engineParam: 'v2' })
		const out = report('v2 @100 bulk warm', attrs)
		maybeRecord('v2-100-bulk-warm', out)
		assertBudget('v2 @100 bulk warm', out.firstShapeMs, SMALL_WARM_BUDGET_MS)
	})

	test('v2 load @ 1000 shapes, bulk commit, warm actor', async ({ browser, baseURL }) => {
		const attrs = await runScenario(browser, baseURL ?? 'http://127.0.0.1:5274', { room: 'v2load-1k-warm', count: 1000, mode: 'bulk', engineParam: 'v2' })
		const out = report('v2 @1000 bulk warm', attrs)
		maybeRecord('v2-1000-bulk-warm', out)
		assertNoRegression('v2 @1000 bulk warm', out.firstShapeMs, 'v2-1000-bulk-warm')
	})

	/** Task 8 — the cold-actor axis. Same content and mode as the warm scenario
	 * above, but the room actor is force-evicted (server/src/canvas-v2/
	 * test-evict.test.ts's flag-gated hook) after seeding closes its peers and
	 * before the browser connects, so the browser's connection is the one that
	 * pays snapshot-load + oplog-replay from SQLite — candidate contributor
	 * (d) in the Task 0 rationale. */
	test('v2 load @ 1000 shapes, bulk commit, COLD actor', async ({ browser, baseURL }) => {
		const attrs = await runScenario(browser, baseURL ?? 'http://127.0.0.1:5274', { room: 'v2load-1k-cold', count: 1000, mode: 'bulk', engineParam: 'v2', cold: true })
		const out = report('v2 @1000 bulk COLD', attrs)
		maybeRecord('v2-1000-bulk-cold', out)

		const warm = recordedBaselines['v2-1000-bulk-warm']?.firstShapeMs
		if (warm && typeof warm.p50ms === 'number') {
			console.log(
				`[v2-load] COLD-ACTOR AXIS @1000: cold p50=${out.firstShapeMs.p50ms}ms vs warm p50=${warm.p50ms}ms — ` +
					`delta ${(out.firstShapeMs.p50ms - warm.p50ms).toFixed(2)}ms. That delta IS candidate contributor (d), server-side replay.`,
			)
		}
		assertNoRegression('v2 @1000 bulk COLD', out.firstShapeMs, 'v2-1000-bulk-cold')
	})

	/** Task 7 — the oplog-volume axis. Same rendered content (1000 shapes) as
	 * the bulk scenario above, but committed as 1000 SEPARATE Frame.Update
	 * frames instead of one. Distinguishes "the backfill ships too much data"
	 * from "the backfill ships too many ops" (candidate contributor (b) in the
	 * Task 0 rationale). The axis itself — that bulk really is commits:1 and
	 * per-shape really is commits:1000 on the wire, not merely self-reported —
	 * is pinned independently by wire-seed.test.ts's FIX-1 Frame.Update tally,
	 * not re-proven here; this test only spends that guarantee on a load
	 * measurement. */
	test('v2 load @ 1000 shapes, PER-SHAPE commits — the oplog-volume axis', async ({ browser, baseURL }) => {
		const attrs = await runScenario(browser, baseURL ?? 'http://127.0.0.1:5274', { room: 'v2load-1k-percommit', count: 1000, mode: 'per-shape', engineParam: 'v2' })
		const out = report('v2 @1000 per-shape warm', attrs)
		maybeRecord('v2-1000-percommit-warm', out)

		// The comparison this scenario EXISTS for: identical rendered content,
		// 1000x the oplog entries. Printed against the bulk baseline so a reader
		// can see immediately whether ops-count or bytes dominates.
		const bulk = recordedBaselines['v2-1000-bulk-warm']?.firstShapeMs
		if (bulk && typeof bulk.p50ms === 'number') {
			console.log(
				`[v2-load] OPLOG AXIS @1000: per-shape p50=${out.firstShapeMs.p50ms}ms vs bulk p50=${bulk.p50ms}ms — ` +
					`ratio ${(out.firstShapeMs.p50ms / bulk.p50ms).toFixed(2)}x. A ratio near 1.0 means op COUNT is not the bottleneck ` +
					`(look at bytes/WASM/chunk instead); a large ratio means it is.`,
			)
		}
		assertNoRegression('v2 @1000 per-shape warm', out.firstShapeMs, 'v2-1000-percommit-warm')
	})

	/** The v1 (tldraw) arm. Seeds over the legacy HTTP agent API rather than the
	 * /sync/v2 wire, because the two engines have genuinely different backends
	 * — v1 has no Loro actor and /api/canvas/shape has no v2 equivalent (see
	 * canvas-v2-perf.spec.ts's module header, which records the same finding).
	 * The comparison stays honest because both arms measure the SAME
	 * user-visible quantity — navigation -> first shape painted — at the same
	 * shape count. */
	// `origin` is threaded through for the same reason runScenario above takes
	// it explicitly: identityState's default origin is 'http://127.0.0.1:5273'
	// (the SHARED e2e rig's port), but this harness serves the client on 5274
	// (playwright.load.config.ts). These contexts are created directly from
	// `browser`, bypassing fixtures.ts's `page` fixture dialog guard — so a
	// wrong-origin identity doesn't throw, it makes onboarding's
	// window.prompt fire and Playwright auto-dismiss it silently, which reads
	// as a bare page.goto timeout with no indication of the real cause. (Hit
	// this empirically on the first run of this test: `Protocol error
	// (Page.handleJavaScriptDialog): Internal server error, session closed`
	// followed by a 300s test timeout on page.goto — see plan-defect note in
	// the task report.)
	async function runV1(browser: import('@playwright/test').Browser, origin: string, room: string, count: number) {
		const samples: LoadSample[] = []
		for (let rep = 0; rep < REPS; rep++) {
			const r = `${room}-r${rep}`
			const cols = Math.ceil(Math.sqrt(count))
			// Sequential batches: Promise.all over 1k HTTP posts saturates the
			// server and distorts nothing measured here, but does make failures
			// unreadable. Batched-parallel is the compromise.
			for (let i = 0; i < count; i += 50) {
				await Promise.all(
					Array.from({ length: Math.min(50, count - i) }, (_, k) => {
						const j = i + k
						return httpShape(r, { type: 'note', x: (j % cols) * 260, y: Math.floor(j / cols) * 260, text: `n${j}`, color: 'yellow' })
					}),
				)
			}
			const context = await browser.newContext({
				storageState: identityState('E2E One', 'e2e-user-0000-0000-0001', origin),
				viewport: { width: 1280, height: 720 },
			})
			const page = await context.newPage()
			await installLoadProbe(page, { shapeSelector: V1_SHAPE_SELECTOR, toolbarSelector: null, chunkPattern: null })
			await page.goto(`/?room=${r}`)
			const sample = await readLoadSample(page, 120_000)
			console.log(`[v2-load][RAW][v1load-small][rep=${rep}] ${JSON.stringify(sample)}`)
			samples.push(sample)
			await context.close()
		}
		return samples.map(attribute)
	}

	test('v1 (tldraw) load @ 100 shapes — the parity reference', async ({ browser, baseURL }) => {
		const attrs = await runV1(browser, baseURL ?? 'http://127.0.0.1:5274', 'v1load-small', 100)
		const out = report('v1 @100', attrs)
		maybeRecord('v1-100', out)

		// Side-by-side, printed unconditionally: the acceptance bar the owner set
		// is a RATIO against v1, so the harness must always state it, not leave a
		// reader to diff two log lines from two different jobs.
		const v2 = recordedBaselines['v2-100-bulk-warm']?.firstShapeMs
		// Medians, matching the gated statistic. Comparing two engines on their
		// worst-of-five would compare two runner hiccups, not two engines.
		if (v2 && typeof v2.p50ms === 'number') {
			const ratio = out.firstShapeMs.p50ms === 0 ? Infinity : v2.p50ms / out.firstShapeMs.p50ms
			console.log(`[v2-load] PARITY @100: v2 p50=${v2.p50ms}ms vs v1 p50=${out.firstShapeMs.p50ms}ms — v2 is ${ratio.toFixed(2)}x v1 (<=1.00 means at or better than parity)`)
		} else {
			console.log('[v2-load] PARITY @100: no committed v2-100-bulk-warm baseline yet — capture one to get the ratio')
		}

		// OBSERVED-ONLY, deliberately NOT gated: v1 is the reference this work is
		// measured against, not a surface this branch changes. Gating it here
		// would make an unrelated tldraw-side regression fail the v2 harness.
		expect(out.firstShapeMs.n).toBe(REPS)
	})
})
