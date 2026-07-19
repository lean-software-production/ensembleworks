# Canvas v2 Time-To-First-Shape Perf Harness — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a measurement harness that makes canvas-v2 room load time observable, attributable across its contributing causes, comparable against the v1 (tldraw) engine, and regression-gated in CI.

**Architecture:** A new Playwright project (`perf-load`) with its own config, serving a **production client build** via `vite preview` (not the dev server the existing rig uses), so module-fetch costs are production-representative. Rooms are pre-seeded **over the real WebSocket wire** by a headless `SyncClientPeer` before the browser navigates, so the browser's first paint of shapes travels the genuine backfill path. An in-page probe installed via `addInitScript` records page-time marks (WS-open, lazy-chunk `responseEnd`, toolbar-visible, first-shape-visible) with no Playwright IPC in the measurement loop. Each scenario runs N iterations in fresh browser contexts, and the resulting **p50 is the hard gate**, with max and spread reported as advisory signals — a deliberate departure from the sibling frame-rate spec's p95-hard convention, for reasons given in the CHANGE NOTE below. `EW_CAPTURE=1` rewrites baselines as usual.

**Tech Stack:** Bun workspaces, Playwright, Vite (preview server), `@ensembleworks/canvas-sync` (`SyncClientPeer`), `ws`, existing `e2e/lib/perf.ts` recording helpers.

---

> ### CHANGE NOTE — 2026-07-19 (gating redesign: p50 hard, not p95 — the house percentile is degenerate at small n)
>
> **What happened.** A mutation review of the landed Task 1 (`7cf687c`, `c098adb`) found the gating design in the original plan to be arithmetically degenerate. The defect is the **plan's**, not the implementer's — they built exactly what was specified.
>
> `e2e/lib/load-metrics.ts` reuses the house percentile formula from `e2e/lib/perf.ts`: `sorted[floor(q * len)]`, clamped to the last index. Reusing it was and remains the right call — two percentile definitions in one repo's perf numbers would be a silent, permanent apples-to-oranges bug. But:
>
> ```
> floor(0.95 · n) === n − 1   for every n ≤ 20
> ```
>
> The plan set `REPS = 5`. So **p95 was not "nearly the max" — it was identically the max**, on every scenario, always. Three consequences, all of which the plan stated or implied incorrectly:
>
> 1. The stated "p95 HARD / max ADVISORY" convention was degenerate: both statistics are the same number, so the hard gate bound on **the single worst of five samples** — the noisiest statistic available, and the one most likely to fail flakily on a shared runner.
> 2. The advisory `::warning::` branch was **unreachable**: it could only fire in cases where the hard assert had already thrown.
> 3. The Task 1 unit test *blessed* the degeneracy rather than catching it. `assert.equal(s.p95ms, 100)` beside `assert.equal(s.maxms, 100)`, commented "p95 index = floor(0.95*10) = 9 -> the max", reads as confirmation the formula works. It was a correct assertion about an unfit-for-purpose statistic — which is exactly how this class of defect survives review.
>
> **Why the convention did not transfer.** It was inherited from `e2e/perf/canvas-v2-perf.spec.ts`, where it is sound: there, one run yields **hundreds of frame samples**, p95 is a genuine percentile, and the tail *is* the subject — a dropped frame is a thing a user feels. A load measurement yields **one data point per navigation**. There is no "tail of a page load" within a rep; each rep is one whole user experience, and the population of interest is what a user *typically* gets. The tail of five CI reps is a property of the runner, not of the product.
>
> **Why not simply raise REPS.** To make p95 differ from max under the house formula you need `n ≥ 21`. The matrix is 5 scenarios (v2@100 warm, v2@1000 warm, v2@1000 per-shape, v2@1000 cold, v1@100) × REPS full production-build navigations, each in a fresh context with its own wire seeding. At REPS=5 that is 25 navigations; at REPS=21 it is 105 — **roughly 4.2× the measurement wall-clock** (order of 5 min → 21 min inside a 45-minute job, before install and build overhead). What that buys is a hard gate on the **second-worst of 21** instead of the worst of 5: still a tail order statistic, still noise-dominated. A p95 with a genuinely stable estimate needs n in the hundreds, i.e. an hour of measurement per CI run. The trade is not close.
>
> **The decision.** For a small-n load metric the right hard gate is the **median**:
>
> - **`p50ms` is the HARD gate**, everywhere the plan previously gated on `p95ms`. At n=5 the median is the 3rd sample: it tolerates up to two anomalous reps without moving, which is exactly the shared-runner failure mode. A max gate fails on one. A real code regression shifts the whole distribution and therefore moves the median, so detection power against the thing actually being gated is not meaningfully reduced.
> - **`p95ms` is REMOVED from `Summary`**, not merely un-gated. At every n this harness will plausibly run, it is identical to `maxms`, and a report field that always equals another field is worse than absent — it implies information it does not carry, and a reader diffing two baseline JSONs would see the two move in lockstep and infer something real. If REPS is ever raised above 20, re-add it *and* justify n in the same commit.
> - **`maxms` stays, as an advisory signal** (`::warning::`, test still passes) — and is now genuinely reachable, because it is no longer the same number as the hard gate.
> - **Spread becomes its own advisory signal**: `spreadMs` (max − min; absolute, human-readable) and `cvPct` (coefficient of variation; scale-free, so it is comparable across the 100- and 1000-shape scenarios and across months). On a contended runner a widening spread is usually the *earliest and most honest* indicator that a measurement has stopped being trustworthy, and it tells a reader something no single percentile can.
> - **`REPS` stays 5, and must stay ODD.** The house formula's `pick(0.5)` returns the exact middle sample when n is odd (`floor(0.5·5) = 2`, the 3rd of 5); at even n it returns the upper-middle, a defensible convention but not a symmetric one. Any future raise goes 5 → 7 → 9, never to an even number.
>
> **Known limitation, accepted deliberately.** A median gate is blind to a *bimodal* regression — one that makes, say, 40% of loads slow while the rest stay fast. At n=5 that is ~2 slow reps and the median does not move. This is precisely the job the max and CV advisories do: such a regression blows the spread, the `::warning::` fires, a human looks. That is the honest division of labour between a **gate** (must not flake) and a **signal** (must not be silent). It is not an argument for gating on the tail.
>
> **On the CI margin.** `CI_MARGIN_MULTIPLIER = 2` is retained, but its justification narrows: it now covers *systematic* host-speed difference (a shared runner is genuinely slower hardware than the dev box a baseline was captured on — a whole-distribution shift no choice of statistic can absorb). *Episodic* contention, which the 2× margin was previously over-stretched to also cover, is now handled by the choice of statistic instead. The two are no longer double-counting the same noise. Once CI-native baselines exist (captured on the runner itself), the margin should shrink toward 1.0 — recorded as a follow-up, not done here.
>
> **⚠ DELIBERATE DEPARTURE FROM THE REPO CONVENTION — do not "fix" this back.** The perf/bundle gate memo and `canvas-v2-perf.spec.ts` both say "p95 hard, max advisory." This harness does not follow that, on purpose: that convention is correct for many-samples-per-run *frame* statistics and arithmetically meaningless for one-sample-per-run *load* statistics. Both this plan and the spec's module header must say so in prose, so a future reader who notices the mismatch reads a decision rather than an oversight.
>
> **Two smaller items folded in from the same review:**
>
> - **NaN guard, in two places.** `summarize([10, NaN, 30])` returned `p50ms: NaN`, and because a NaN comparator return makes sort order arbitrary, it corrupted `minms`/`maxms` too. `summarize()` now rejects any non-finite sample — the same spirit as the empty-input guard, and it is the last common chokepoint before a number becomes a gate. Separately, `readLoadSample` (Task 4) drops its `raw.firstShapeMs!` non-null assertion in favour of an explicit finite check that throws with the partial marks attached: `firstShapeMs` is typed non-nullable `number`, so that unchecked assertion is the type-level hole through which a null or NaN would enter the pipeline in the first place. Guarding only one of the two leaves either a corrupt gate or a mystery error message.
> - **`scripts/run-tests.ts` glob (pre-existing, out of scope).** Its first glob is `**/src/**/*.test.ts`, which under bare `bun` would spawn anything under a hypothetical `e2e/**/src/` directory. Not introduced by this plan and not fixed by it — recorded as a future ticket because Task 1 Step 5 edits the adjacent line and a reader will wonder whether it was considered. It was.

---

## Context the implementer must read before starting

You have zero repo context. Read these, in this order, before Task 1:

1. `CLAUDE.md` (repo root) — "Dogfood rooms (canvas v2)" and "Interaction contracts" sections.
2. `e2e/lib/perf.ts` — the house baseline-recording helpers (`record`, `recordTo`, `capturing`, `installSampler`, `measure`). **Reuse these. Do not invent parallel machinery.**
3. `e2e/perf/canvas-v2-perf.spec.ts` — read the whole module header. It documents the house gating conventions (p95 hard / max advisory / `droppedOver25ms` observed-only, the CI-margin multiplier, the merge-preview provenance gotcha). **This plan follows its recording, provenance and CI-margin machinery but deliberately DEPARTS from its p95-hard statistic** — see the CHANGE NOTE above before you write any assertion. In one sentence: that spec summarises hundreds of frame samples per run, this one summarises five whole page loads, and `floor(0.95·5)` is the max.
4. `e2e/playwright.config.ts` and `e2e/scripts/start-server.ts` — the existing server spin-up you will reuse.
5. `e2e/lib/canvas-v2.ts` — existing v2 browser helpers (`waitForBoot`, `viewportBox`, `seedGrid`).

### Commands (exact)

| Purpose | Command |
|---|---|
| Full unit suite | `bun run test` (from repo root) |
| **NOT** the full suite — known footgun | `bun test` ← never use this |
| One unit test file | `bun path/to/file.test.ts` |
| Typecheck all workspaces | `bun run typecheck` |
| Build all workspaces | `bun run build` |
| Existing e2e specs | `cd e2e && bunx playwright test --project=e2e` |
| Existing perf specs | `cd e2e && bunx playwright test --project=perf` |
| **This harness** | `cd e2e && bunx playwright test -c playwright.load.config.ts` |
| Capture baselines | prefix any of the above with `EW_CAPTURE=1` |

Running `bun run test` locally will also run `scripts/ux-contract-presence.test.ts`, which reads `UX_CONTRACT_PR_BODY`. **Set it for every local full-suite run in this plan**, using exactly this value:

```bash
UX_CONTRACT_PR_BODY='ux-contract: none — pure measurement harness under e2e/ plus a flag-gated server test hook; no tool FSM, renderer, or input surface is touched.' bun run test
```

Note this requirement comes from the **branch point** (PR 48 touched `client/src/canvas-v2/`), not from anything this plan adds — so it applies from Task 1 onward, not just in the tasks that mention it.

**Trap:** that opt-out reason is only truthful while the harness stays outside the interaction-bearing prefixes (`canvas-editor/src/tools/`, `canvas-react/src/`, `client/src/canvas-v2/` input/tool files). The tempting refinement of adding finer timing marks *inside* `client/src/canvas-v2/CanvasV2App.tsx` would both trip the presence gate and falsify this stated reason. Keep the probe in `addInitScript` (Task 4) where it belongs.

### Clean-room boundary — non-negotiable

`canvas-model`, `canvas-doc`, `canvas-sync`, `canvas-editor` are clean-room packages. `canvas-sync/src/boundary.test.ts` runs a **plain text scan** over `canvas-sync/src/**/*.ts` (excluding `*.test.ts`) and fails the build if any file contains `from 'ws'` / `require('ws')` / `import('ws')` / `import 'ws'`, the same four forms for `express`, the substring `@tldraw/`, a `from '../server'`-style import, or the literal text `Date.now(` or `Math.random(` — **including inside comments**.

Consequence for you: **never add a file under `canvas-sync/src/`.** All harness code lives in `e2e/` (which may import freely) plus one small, flag-gated addition under `server/src/` in Task 8.

---

## Task 0: Create the working branch

**This task has a specific, deliberate branch point. Read the rationale before running the commands.**

### Rationale — do NOT branch from `main`

Branch from **`fix/v2-boot-sync-ready`** (head `1ad72388d7de182251f913d8025e876abf852d92`), the PR-48 branch. **Not** from `origin/main` (`0334c7e6132bd821a5e3223667a9deff7a752385`).

Why: `main` still contains an **unconditional 400ms boot settle sleep** in the v2 boot path. PR 48 replaces it with a real sync-readiness signal (`Frame.SyncDone` → `SyncClientPeer.ready()`), raced against a bounded safety cap rather than slept through unconditionally. That removal is a condition *sine qua non* of this work — it is happening regardless of what any measurement says, and it will never ship again.

A baseline recorded with that sleep still present would therefore be a baseline of **a configuration we will never run**. Every number would carry a fixed 400ms of dead weight, polluting both the absolute figures and the scenario-to-scenario comparisons the harness exists to produce. There is no before/after delta worth preserving, because there is no decision that delta would inform.

**There is no "validate PR 48" task in this plan, and you must not add one.** The harness's job is to attribute the *remaining* load time across the five other candidate contributors: (a) the ~4.3 MB lazy chunk, (b) full-oplog replay vs a snapshot first sync, (c) base64 WASM decode for `loro-crdt`, (d) cold-actor blocking replay on the server, (e) the WS connect + `SyncRequest` round-trip.

**Do not "helpfully" rebase onto `main`** — that would silently reintroduce the sleep into the measured configuration and invalidate every recorded number.

**Merge-order note:** if PR 48 merges into `main` before this harness branch merges, *then* rebase onto `main` (which at that point contains the fix). The invariant to protect is **"the measured configuration has no fixed settle sleep"**, not the literal branch point. Verify after any rebase by confirming `client/src/canvas-v2/CanvasV2App.tsx` still races `peer.ready()` against `settleMs` rather than unconditionally awaiting a timer.

**Step 1: Fetch and branch**

```bash
cd /home/stag/src/projects/ensembleworks
git fetch origin
git checkout -b perf/v2-first-shape-harness 1ad72388d7de182251f913d8025e876abf852d92
```

**Step 2: Verify the branch point**

```bash
git rev-parse HEAD
```
Expected: `1ad72388d7de182251f913d8025e876abf852d92`

```bash
grep -n "SETTLE_MS_DEFAULT\|peer.ready()" client/src/canvas-v2/CanvasV2App.tsx | head
```
Expected: `SETTLE_MS_DEFAULT` present as a **cap raced against** `peer.ready()`, not an unconditional sleep. If you instead find an unconditional `await new Promise(r => setTimeout(r, 400))` with no `ready()` race, **STOP** — you are on the wrong branch point.

**Step 3: Commit nothing yet.** Proceed to Task 1.

---

## Task 1: Pure load-metric helpers

> **⚠ ALREADY LANDED, THEN REVISED.** Task 1 shipped as `7cf687c` + `c098adb`
> against the **pre-revision** gating design, and a mutation review then found
> that design degenerate (CHANGE NOTE, 2026-07-19). The code blocks below are
> the **corrected** target state — `p95ms` gone, `spreadMs`/`cvPct` added, a
> non-finite guard in `summarize()`. If you are executing this plan from
> scratch, just build what is written here. **If you are picking up the branch
> mid-flight, Task 1 is not done: skip to Task 1a**, which lists the diff from
> what actually landed.

The harness needs summarisation over repeated load samples, and a stable record shape. These are pure functions, unit-testable without a browser — build them first.

**Files:**
- Create: `e2e/lib/load-metrics.ts`
- Create: `e2e/lib/load-metrics.test.ts`
- Modify: `scripts/run-tests.ts`

### Why `run-tests.ts` needs modifying

`scripts/run-tests.ts` globs `**/src/**/*.test.ts` and `scripts/*.test.ts`. A test at `e2e/lib/load-metrics.test.ts` matches **neither**, so it would silently never run under `bun run test`. The file's own header says "widen if that changes" — this is that change.

**Step 1: Write the failing test**

Create `e2e/lib/load-metrics.test.ts`:

```ts
// Run: bun e2e/lib/load-metrics.test.ts
// Pure summarisation helpers for the v2 load harness — no browser, no server.
import assert from 'node:assert/strict'
import { summarize, attribute, type LoadSample } from './load-metrics.ts'

{
	// n/p50/max/min/spread over a known set. NOTE the deliberate absence of p95:
	// under the house formula floor(0.95*n) === n-1 for every n <= 20, so at any
	// rep count this harness runs, p95 would be identically maxms. See the plan's
	// CHANGE NOTE — p50 is the hard gate here, not p95.
	const s = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
	assert.equal(s.n, 10)
	assert.equal(s.p50ms, 60)
	assert.equal(s.maxms, 100)
	assert.equal(s.minms, 10)
	assert.equal(s.spreadMs, 90)
	console.log('ok: summarize computes n/p50/max/min/spread over a known set')
}
{
	// Odd n: p50 is the EXACT middle sample. This is the property the gate relies
	// on, and the reason REPS must stay odd (floor(0.5*5) = 2 -> the 3rd of 5).
	const s = summarize([10, 20, 30, 40, 1000])
	assert.equal(s.p50ms, 30)
	// ...and the single wild outlier that a max gate would have failed on shows
	// up loudly in the ADVISORY statistics instead. That division of labour is
	// the whole point of the redesign.
	assert.equal(s.maxms, 1000)
	assert.equal(s.spreadMs, 990)
	assert.ok(s.cvPct > 100, 'a 100x outlier must blow the coefficient of variation')
	console.log('ok: p50 ignores a single wild outlier that max and cvPct both flag')
}
{
	// Single sample: everything collapses to it, spread is 0, cv is 0 — no NaN
	// (cvPct must not divide by a zero mean or produce 0/0).
	const s = summarize([42])
	assert.deepEqual(
		{ n: s.n, p50ms: s.p50ms, maxms: s.maxms, minms: s.minms, spreadMs: s.spreadMs, cvPct: s.cvPct },
		{ n: 1, p50ms: 42, maxms: 42, minms: 42, spreadMs: 0, cvPct: 0 },
	)
	console.log('ok: summarize collapses cleanly on a single sample')
}
{
	// Empty input must throw, not silently return zeros — a zeroed perf number
	// that looks like a pass is the worst possible failure mode here.
	assert.throws(() => summarize([]), /at least one sample/)
	console.log('ok: summarize refuses an empty sample set')
}
{
	// NON-FINITE input must throw, for the same reason as the empty guard and one
	// worse: a NaN comparator return makes Array#sort's order ARBITRARY, so a
	// single NaN corrupts minms/maxms too, not just the stat it landed in. This
	// is the last common chokepoint before a number becomes a CI gate.
	assert.throws(() => summarize([10, NaN, 30]), /finite/)
	assert.throws(() => summarize([10, Infinity]), /finite/)
	console.log('ok: summarize refuses non-finite samples rather than propagating NaN')
}
{
	// Rounding: two decimal places, matching lib/perf.ts's FrameStats convention.
	const s = summarize([1.23456, 2.34567, 3.45678])
	assert.equal(s.p50ms, 2.35)
	console.log('ok: summarize rounds to 2dp like FrameStats')
}
{
	// attribute() turns one raw sample into the named sub-splits. The gap the
	// whole harness exists to expose is toolbarToFirstShapeMs.
	const sample: LoadSample = { wsOpenMs: 120, chunkResponseEndMs: 800, toolbarMs: 900, firstShapeMs: 2400 }
	const a = attribute(sample)
	assert.equal(a.firstShapeMs, 2400)
	assert.equal(a.toolbarToFirstShapeMs, 1500)
	assert.equal(a.chunkToToolbarMs, 100)
	assert.equal(a.wsOpenMs, 120)
	assert.equal(a.chunkResponseEndMs, 800)
	console.log('ok: attribute derives the toolbar->first-shape and chunk->toolbar gaps')
}
{
	// A null chunk timing (dev server: no single named chunk exists) must
	// propagate as null, never as 0 — 0 would read as "instant" and quietly
	// corrupt the attribution.
	const a = attribute({ wsOpenMs: 50, chunkResponseEndMs: null, toolbarMs: 300, firstShapeMs: 900 })
	assert.equal(a.chunkResponseEndMs, null)
	assert.equal(a.chunkToToolbarMs, null)
	assert.equal(a.toolbarToFirstShapeMs, 600)
	console.log('ok: attribute propagates a missing chunk timing as null, never 0')
}

console.log('ok: load-metrics — all cases')
```

**Step 2: Run it to see it fail**

```bash
cd /home/stag/src/projects/ensembleworks && bun e2e/lib/load-metrics.test.ts
```
Expected: FAIL — a module-resolution error, along the lines of `Cannot find module './load-metrics.ts'`.

**Record the verbatim failure output in your task report.** This is the repo's RED-first discipline (CLAUDE.md, "Interaction contracts" → "Pass this down to subagents", obligation 2). **If the test does NOT fail — STOP and report.** Do not force redness, do not skip to the implementation. Every "unreachable RED" in this repo's history turned out to be a wrong belief worth catching.

**Step 3: Write the implementation**

Create `e2e/lib/load-metrics.ts`:

```ts
// Pure summarisation + attribution for the canvas-v2 load harness
// (perf/canvas-v2-load.spec.ts). Deliberately browser-free and server-free so
// it is unit-testable under plain `bun` — the browser-side collection lives in
// lib/load-probe.ts, the scenario driving in the spec.
//
// PERCENTILE CONVENTION: identical to lib/perf.ts's `measure()` —
// sorted[floor(q * len)], clamped to the last index. Reusing the house
// formula on purpose: two different percentile definitions in one repo's perf
// numbers would be a silent, permanent apples-to-oranges bug.
//
// WHY THERE IS NO p95 HERE — deliberate, do not "restore" it. Under that same
// house formula, floor(0.95 * n) === n - 1 for EVERY n <= 20, so at this
// harness's rep counts p95 is not a percentile at all: it is identically
// maxms. A report field that always equals another field is worse than absent,
// because it implies information it does not carry. The sibling frame-rate
// spec (perf/canvas-v2-perf.spec.ts) gates on p95 legitimately because one of
// its runs yields HUNDREDS of frame samples; one of these runs yields FIVE
// whole page loads. p50 is the hard gate here and maxms/spreadMs/cvPct are the
// advisory signals. Full reasoning: docs/plans/2026-07-19-v2-first-shape-perf-
// harness.md, CHANGE NOTE 2026-07-19. If REPS is ever raised above 20, p95
// becomes meaningful again — re-add it AND justify the n in the same commit.

/** One browser navigation's raw page-time marks, in ms since navigation start.
 * `chunkResponseEndMs` is null when no single lazy chunk exists to time (the
 * Vite DEV server serves the v2 graph as hundreds of unbundled modules) or
 * when the arm under test is v1 (no v2 chunk at all). */
export interface LoadSample {
	readonly wsOpenMs: number | null
	readonly chunkResponseEndMs: number | null
	readonly toolbarMs: number | null
	readonly firstShapeMs: number
}

export interface Attribution {
	readonly wsOpenMs: number | null
	readonly chunkResponseEndMs: number | null
	readonly toolbarMs: number | null
	readonly firstShapeMs: number
	/** chunk responseEnd -> toolbar visible: module eval + WASM init + boot. */
	readonly chunkToToolbarMs: number | null
	/** Toolbar visible -> first pre-seeded shape painted. THE metric this whole
	 * harness exists for: the toolbar can appear long before shapes do, and
	 * that gap is the user-visible symptom being hunted. */
	readonly toolbarToFirstShapeMs: number | null
}

export interface Summary {
	readonly n: number
	readonly minms: number
	/** THE HARD GATE. At odd n this is the exact middle sample — robust to the
	 * one-contended-rep failure mode a shared CI runner actually produces. */
	readonly p50ms: number
	/** ADVISORY only. Worst single rep. */
	readonly maxms: number
	/** ADVISORY only. max - min, in ms. Absolute and directly readable. */
	readonly spreadMs: number
	/** ADVISORY only. Coefficient of variation (population stddev / mean), as a
	 * percentage. Scale-free, so it is comparable across the 100-shape and
	 * 1000-shape scenarios and across months — which raw spread is not. A rising
	 * cvPct is usually the earliest honest sign that a measurement has stopped
	 * being trustworthy, well before any gate trips. */
	readonly cvPct: number
}

const round2 = (n: number) => Number(n.toFixed(2))

export function summarize(samples: readonly number[]): Summary {
	if (samples.length === 0) throw new Error('summarize: needs at least one sample')
	// Non-finite guard, BEFORE the sort. A NaN comparator return makes Array#sort
	// order arbitrary, so one NaN corrupts min and max as well as the stat it
	// landed in — and every one of these numbers feeds a CI gate. Refuse loudly.
	for (const v of samples) {
		if (!Number.isFinite(v)) throw new Error(`summarize: every sample must be finite, got ${String(v)}`)
	}
	const sorted = [...samples].sort((a, b) => a - b)
	const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
	const min = sorted[0]!
	const max = sorted[sorted.length - 1]!
	const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
	const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length
	return {
		n: sorted.length,
		minms: round2(min),
		p50ms: round2(pick(0.5)),
		maxms: round2(max),
		spreadMs: round2(max - min),
		// mean === 0 only if every sample is 0, in which case the spread is 0 too
		// and 0 is the honest answer — never NaN from a 0/0.
		cvPct: mean === 0 ? 0 : round2((Math.sqrt(variance) / mean) * 100),
	}
}

/** Null-propagating subtraction: a missing endpoint yields null, NEVER 0. */
const gap = (later: number | null, earlier: number | null): number | null =>
	later === null || earlier === null ? null : round2(later - earlier)

export function attribute(s: LoadSample): Attribution {
	return {
		wsOpenMs: s.wsOpenMs === null ? null : round2(s.wsOpenMs),
		chunkResponseEndMs: s.chunkResponseEndMs === null ? null : round2(s.chunkResponseEndMs),
		toolbarMs: s.toolbarMs === null ? null : round2(s.toolbarMs),
		firstShapeMs: round2(s.firstShapeMs),
		chunkToToolbarMs: gap(s.toolbarMs, s.chunkResponseEndMs),
		toolbarToFirstShapeMs: gap(s.firstShapeMs, s.toolbarMs),
	}
}
```

**Step 4: Run the test to see it pass**

```bash
cd /home/stag/src/projects/ensembleworks && bun e2e/lib/load-metrics.test.ts
```
Expected: nine `ok:` lines, exit 0.

**Step 5: Widen the unit-suite glob**

In `scripts/run-tests.ts`, change:

```ts
const globs = ['**/src/**/*.test.ts', 'scripts/*.test.ts']
```

to:

```ts
// e2e/lib/*.test.ts (added 2026-07-19): the load harness's PURE helpers
// (load-metrics.ts) are unit-testable without a browser, but e2e/ has no
// src/ dir so they match neither glob above. Only the flat e2e/lib level is
// globbed — e2e/tests/ and e2e/perf/ are Playwright specs and must NOT be
// spawned under bare `bun`.
const globs = ['**/src/**/*.test.ts', 'scripts/*.test.ts', 'e2e/lib/*.test.ts']
```

**Step 6: Verify the widened glob picks it up**

```bash
cd /home/stag/src/projects/ensembleworks && bun run test 2>&1 | grep -c "e2e/lib/load-metrics.test.ts"
```
Expected: `1` (the `=== e2e/lib/load-metrics.test.ts ===` banner). The whole suite must still end with `all N suites passed`.

**Step 7: Typecheck**

```bash
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/e2e' typecheck
```
Expected: no output, exit 0.

**Step 8: Commit**

```bash
git add e2e/lib/load-metrics.ts e2e/lib/load-metrics.test.ts scripts/run-tests.ts
git commit -m "test(e2e): pure load-metric summarisation + attribution helpers"
```

---

## Task 1a: Amend the landed helpers to the revised gating design

**Skip this task entirely if you built Task 1 from the corrected blocks above** — there is nothing to amend. This exists only for the branch as it actually stands at `c098adb`, where the pre-revision shape is already committed.

**Files:**
- Modify: `e2e/lib/load-metrics.ts`
- Modify: `e2e/lib/load-metrics.test.ts`

**The diff from what landed**, all of it justified in the CHANGE NOTE:

1. **Remove `p95ms` from `Summary`** and from the returned object. At n ≤ 20 it is identically `maxms`; it is a field that implies information it does not carry.
2. **Add `spreadMs`** (`max - min`) and **`cvPct`** (population stddev ÷ mean × 100, `0` when mean is 0).
3. **Add the non-finite guard** to `summarize()`, *before* the sort — a NaN comparator return makes sort order arbitrary, so one NaN corrupts `minms`/`maxms` too.
4. **Replace the `p95` header comment** with the WHY-THERE-IS-NO-p95 block above. This is the load-bearing part: the next person to read this file will otherwise notice the missing p95 and restore it.

**Step 1: RED first — extend the test before touching the implementation**

Add the three new cases from the Task 1 test block (odd-n outlier, non-finite rejection, the `spreadMs`/`cvPct` assertions in the known-set and single-sample cases) and delete the two `p95ms` assertions.

```bash
cd /home/stag/src/projects/ensembleworks && bun e2e/lib/load-metrics.test.ts
```

Expected: **FAIL** — the `spreadMs`/`cvPct` assertions fail against a `Summary` that has no such fields, and `summarize([10, NaN, 30])` does not throw. **Record the verbatim failure.** If it does not fail, STOP and report: it would mean the landed code already differs from what review found, and one of the two beliefs is wrong.

**Step 2: Apply the implementation diff**, then re-run — nine `ok:` lines, exit 0.

**Step 3: Confirm the NaN case genuinely was broken before the guard**

Do not take the guard on faith; this is the repo's independent-verification rule (CLAUDE.md, obligation 4) applied to your own work. Temporarily comment out the guard and run **both** of these:

```bash
cd /home/stag/src/projects/ensembleworks && bun -e 'import("./e2e/lib/load-metrics.ts").then(m => { console.log(m.summarize([10, NaN, 30])); console.log(m.summarize([50, 10, NaN, 30, 20])) })'
```

Expected without the guard (verified 2026-07-19 on Bun 1.3.14 — the exact fields that go bad depend on where the NaN lands in an arbitrary sort order, which is itself the point):

```
{ n: 3, minms: 10, p50ms: NaN, maxms: 30, spreadMs: 20, cvPct: NaN }
{ n: 5, minms: 10, p50ms: 30,  maxms: NaN, spreadMs: NaN, cvPct: NaN }
```

Note the second line especially: **the NaN corrupted `maxms`, a statistic it was never part of**, while `p50ms` came out clean and plausible — a silently wrong number that would have been reported as a real measurement. One NaN does not stay in its lane. Restore the guard.

**Step 4: Typecheck and commit**

```bash
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/e2e' typecheck
git add e2e/lib/load-metrics.ts e2e/lib/load-metrics.test.ts
git commit -m "test(e2e): drop degenerate p95, add spread/cv and a non-finite guard to summarize"
```

---

## Task 2: Headless wire seeder

Seed rooms by driving a real `SyncClientPeer` over a real WebSocket against the running sync server — **not** via the in-page editor API. The existing `e2e/lib/canvas-v2.ts` `seedGrid` writes through `window.__ew.doc` *after* boot completes, which bypasses the entire wire/sync path. That path is precisely what is suspected of being slow, so seeding through it is the whole point.

**Files:**
- Create: `e2e/lib/wire-seed.ts`
- Create: `e2e/lib/wire-seed.test.ts`

### Reference facts (verified — but re-verify if anything surprises you)

- Endpoint: `ws://127.0.0.1:8788/sync/v2/<roomId>`. Exactly one path segment after `v2`. **No auth, no required query params.** Gated on `EW_CANVAS_SYNC=1`, which `e2e/scripts/start-server.ts` sets by default.
- `SyncClientPeer` constructor sends the `SyncRequest` handshake **synchronously**. The socket must already be `OPEN` before you construct the peer, or the handshake is silently dropped.
- `peerId` must be neither `0n` nor `1n` (`1n` is `SERVER_PEER_ID`).
- There is **no `send()` method**. Every `doc.commit()` fires `subscribeLocalUpdates`, which sends a `Frame.Update`. `peer.putShape(s)` is sugar for `doc.putShape(s)` + `doc.commit()` — i.e. **one commit per shape**. For a bulk commit you call `peer.doc.putShape(...)` N times and `peer.doc.commit()` **once**. This distinction is the oplog-volume axis in Task 7 — do not collapse it.
- `peer.ready()` resolves on the server's `Frame.SyncDone`.
- `wsTransport` (Node `ws`-backed) already exists at `server/src/canvas-v2/ws-transport.ts`. **Import it — do not copy it.** `e2e/` importing from `server/src` is house-consistent (`e2e/scripts/start-server.ts` imports `../../server/src/app.ts`).
- A valid minimal note shape literal (from `server/src/canvas-v2/canvas-v2-sync-mount.test.ts`):
  `{ id, kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} }`

**Step 1: Write the failing test**

Create `e2e/lib/wire-seed.test.ts`:

```ts
// Run: bun e2e/lib/wire-seed.test.ts
// Proves the headless wire seeder actually lands shapes in a REAL room actor
// over a REAL WebSocket — the property the whole load harness depends on. A
// second, independent peer reads them back, so this cannot pass by the seeder
// merely mutating its own local doc.
//
// Boots its own server on an ephemeral port with its own temp data dir, so it
// runs under `bun run test` with no Playwright rig present.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { SyncClientPeer } from '@ensembleworks/canvas-sync'
import { wsTransport } from '../../server/src/canvas-v2/ws-transport.ts'
import { createSyncApp } from '../../server/src/app.ts'
import { seedRoomOverWire, openPeer } from './wire-seed.ts'

process.env.EW_CANVAS_SYNC = '1'
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ew-wire-seed-'))
const { server } = createSyncApp({ dataDir })
await new Promise<void>((r) => server.listen(0, r))
const port = (server.address() as { port: number }).port
const base = `ws://127.0.0.1:${port}`

async function waitUntil(pred: () => boolean, ms = 10_000) {
	const t0 = Date.now()
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error('waitUntil timed out')
		await new Promise((r) => setTimeout(r, 20))
	}
}

{
	// Bulk mode: N shapes, ONE commit.
	const room = 'wire-seed-bulk'
	const res = await seedRoomOverWire({ base, room, count: 25, mode: 'bulk' })
	assert.equal(res.count, 25)
	assert.equal(res.commits, 1, 'bulk mode issues exactly one commit')

	const reader = await openPeer(base, room, 7n)
	await reader.ready()
	await waitUntil(() => reader.doc.listShapes().length === 25)
	assert.equal(reader.doc.listShapes().length, 25, 'an independent peer reads back all 25 seeded shapes')
	reader.close()
	console.log('ok: wire-seed bulk mode lands 25 shapes readable by an independent peer')
}
{
	// Per-shape mode: N shapes, N commits — a materially longer oplog for the
	// same visible content. This is the axis that separates "too much data"
	// from "too many ops".
	const room = 'wire-seed-percommit'
	const res = await seedRoomOverWire({ base, room, count: 25, mode: 'per-shape' })
	assert.equal(res.commits, 25, 'per-shape mode issues one commit per shape')

	const reader = await openPeer(base, room, 8n)
	await reader.ready()
	await waitUntil(() => reader.doc.listShapes().length === 25)
	assert.equal(reader.doc.listShapes().length, 25)
	reader.close()
	console.log('ok: wire-seed per-shape mode lands 25 shapes with 25 commits')
}
{
	// The seeded page must be the one the browser will adopt (bootstrap-page.ts's
	// resolvePageId adopts an existing page rather than bootstrapping its own).
	const reader = await openPeer(base, 'wire-seed-bulk', 9n)
	await reader.ready()
	await waitUntil(() => reader.doc.listPages().length > 0)
	assert.deepEqual(reader.doc.listPages().map((p) => p.id), ['page:p'], 'exactly one page, the page:p convention')
	reader.close()
	console.log('ok: wire-seed creates exactly the page:p the client will adopt')
}

server.close()
rmSync(dataDir, { recursive: true, force: true })
console.log('ok: wire-seed — all cases')
process.exit(0)
```

**Step 2: Run it to see it fail**

```bash
cd /home/stag/src/projects/ensembleworks && bun e2e/lib/wire-seed.test.ts
```
Expected: FAIL — `Cannot find module './wire-seed.ts'`.

**Record the verbatim failure. If it does not fail, STOP and report.**

**Step 3: Write the implementation**

Create `e2e/lib/wire-seed.ts`:

```ts
// Headless room seeding over the REAL /sync/v2 WebSocket, for the canvas-v2
// load harness (perf/canvas-v2-load.spec.ts).
//
// WHY NOT lib/canvas-v2.ts's seedGrid: that seeds through `window.__ew.doc`
// AFTER the browser session has already booted, which bypasses the entire
// wire/sync path. The load harness's whole subject is how long the browser
// takes to paint shapes that were ALREADY in the room when it arrived — so the
// shapes must be in the room BEFORE the browser navigates, and must have got
// there the same way a real teammate's shapes would.
//
// LIVES IN e2e/ ON PURPOSE: canvas-sync/src is clean-room (its boundary.test.ts
// text-scans for `ws` imports and fails the build). e2e/ may import freely, and
// already imports from server/src (see scripts/start-server.ts).
import { WebSocket } from 'ws'
import { SyncClientPeer } from '@ensembleworks/canvas-sync'
import { wsTransport } from '../../server/src/canvas-v2/ws-transport.ts'

export const PAGE_ID = 'page:p'

/** How the seeded shapes are committed. Visible content is IDENTICAL between
 * the two; only the oplog differs — `bulk` produces one change, `per-shape`
 * produces `count` changes for the same shapes. Distinguishing them is what
 * separates "the backfill ships too much data" from "the backfill ships too
 * many ops". */
export type SeedMode = 'bulk' | 'per-shape'

export interface SeedOpts {
	/** e.g. `ws://127.0.0.1:8788` — no trailing slash, no path. */
	readonly base: string
	readonly room: string
	readonly count: number
	readonly mode: SeedMode
	/** Grid pitch in world units. 260 matches the existing perf specs' spacing. */
	readonly pitch?: number
}

export interface SeedResult {
	readonly count: number
	readonly commits: number
	readonly seedMs: number
}

function openWs(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		let settled = false
		ws.on('open', () => { if (!settled) { settled = true; resolve(ws) } })
		ws.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
	})
}

/** Opens a connected, sync-requested peer. The socket is opened FIRST and only
 * then handed to SyncClientPeer — the constructor sends its SyncRequest
 * synchronously, and a not-yet-open socket drops it silently. */
export async function openPeer(base: string, room: string, peerId: bigint): Promise<SyncClientPeer> {
	if (peerId === 0n || peerId === 1n) throw new Error(`peerId ${peerId} is reserved (1n is SERVER_PEER_ID)`)
	const ws = await openWs(`${base}/sync/v2/${room}`)
	return new SyncClientPeer({ peerId, transport: wsTransport(ws) })
}

let nextPeerId = 1000n
/** A fresh, never-reserved peer id per seeder. Monotonic rather than random so
 * a failing run's logs are reproducible. */
export const freshPeerId = (): bigint => ++nextPeerId

function note(i: number, pitch: number, cols: number) {
	return {
		id: `shape:wire-${i}`,
		kind: 'note',
		parentId: PAGE_ID,
		index: 'a1',
		x: (i % cols) * pitch,
		y: Math.floor(i / cols) * pitch,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: {},
	}
}

/** Seeds `count` notes into `room` over a real WebSocket, then waits for the
 * server to have acknowledged them (a fresh verification peer reads them back)
 * before resolving — so a caller can navigate a browser immediately after with
 * no race. Closes both peers. */
export async function seedRoomOverWire(opts: SeedOpts): Promise<SeedResult> {
	const { base, room, count, mode } = opts
	const pitch = opts.pitch ?? 260
	const cols = Math.ceil(Math.sqrt(count))
	const t0 = Date.now()

	const peer = await openPeer(base, room, freshPeerId())
	await peer.ready()

	peer.doc.putPage({ id: PAGE_ID, name: 'P' })
	peer.doc.commit()
	let commits = 0

	if (mode === 'bulk') {
		for (let i = 0; i < count; i++) peer.doc.putShape(note(i, pitch, cols) as never)
		peer.doc.commit()
		commits = 1
	} else {
		for (let i = 0; i < count; i++) {
			peer.doc.putShape(note(i, pitch, cols) as never)
			peer.doc.commit()
			commits++
		}
	}

	// Read-back barrier: a SECOND peer proves the server actor has the shapes,
	// not merely that we sent them. Without this the browser can arrive before
	// the server has applied the last frame and measure a phantom-fast load.
	const verify = await openPeer(base, room, freshPeerId())
	await verify.ready()
	const deadline = Date.now() + 30_000
	while (verify.doc.listShapes().length < count) {
		if (Date.now() > deadline) throw new Error(`wire-seed: server never reached ${count} shapes in ${room} (saw ${verify.doc.listShapes().length})`)
		await new Promise((r) => setTimeout(r, 25))
	}
	verify.close()
	peer.close()

	return { count, commits, seedMs: Date.now() - t0 }
}
```

**Step 4: Run the test to see it pass**

```bash
cd /home/stag/src/projects/ensembleworks && bun e2e/lib/wire-seed.test.ts
```
Expected: four `ok:` lines, exit 0.

**Step 5: Confirm you did not break the clean-room boundary**

```bash
cd /home/stag/src/projects/ensembleworks && bun canvas-sync/src/boundary.test.ts
```
Expected: `ok: boundary (scanned N file(s): ...)`.

**Step 6: Typecheck and commit**

```bash
bun run --filter '@ensembleworks/e2e' typecheck
git add e2e/lib/wire-seed.ts e2e/lib/wire-seed.test.ts
git commit -m "test(e2e): headless wire seeder driving a real SyncClientPeer over /sync/v2"
```

---

## Task 3: Production-build harness config

### Why this task exists — a correction to the naive design

The existing e2e rig's `webServer` runs **`bunx vite`, the Vite DEV server**. In dev, Vite serves the v2 module graph as hundreds of individually-transformed ES modules; there is no single ~4.3 MB `CanvasV2App-*.js` chunk to time, and `loro-crdt`'s WASM arrives through the dep-optimizer rather than the production path.

Measuring "lazy-chunk `responseEnd`" against the dev server would therefore measure **an artifact that does not exist in production**, and dev-server module-fetch cost would dominate and mis-attribute the whole budget. Since attribution is this harness's entire purpose, the harness must run against a **production build**.

So: a separate Playwright config with its own `webServer` pair — the existing sync server, plus `vite preview` serving `client/dist`. It is a **separate config file**, not extra entries in `e2e/playwright.config.ts`, because adding a full client build to the shared config would tax every existing e2e run for no benefit.

**Files:**
- Modify: `client/vite.config.ts` (add a `preview` block mirroring `server.proxy`)
- Create: `e2e/playwright.load.config.ts`
- Create: `e2e/perf-load/smoke.spec.ts` (temporary scaffold, replaced in Task 5)
- Modify: `e2e/package.json`

### Assumption you MUST verify empirically, not trust

README says tldraw enforces a per-domain license on **a real production domain**, and that "Dev/watch and localhost are exempt either way." Playwright serves at `127.0.0.1`. This plan assumes a production client build renders tldraw fine at `127.0.0.1` with **no** `VITE_TLDRAW_LICENSE_KEY`. **Step 5 below verifies this.** If tldraw blanks, do not work around it silently — see the fallback in Step 5 and report the finding.

**Step 1: Add the preview proxy to the client Vite config**

`vite preview` does **not** inherit `server.proxy`. Without a `preview.proxy` block the preview server 404s `/sync` and `/api`, and the v2 app cannot dial its WebSocket at all.

In `client/vite.config.ts`, extract the proxy map so both servers share one definition. Replace the `proxy: { ... }` object inside `server:` with a reference to a hoisted constant, and add a `preview` block. Concretely, insert this **above** `export default defineConfig({`:

```ts
// Shared by BOTH the dev server and `vite preview`. Vite does NOT inherit
// server.proxy into preview, and the e2e load-perf harness
// (e2e/playwright.load.config.ts) drives a PRODUCTION build through preview —
// without this the preview server 404s /sync and /api and the v2 app can never
// dial its WebSocket. One definition, two consumers: a drifted copy would make
// the harness measure a different backend wiring than dev uses.
const PROXY = {
	'/sync': { target: `ws://localhost:${SYNC_PORT}`, ws: true },
	'/uploads': `http://localhost:${SYNC_PORT}`,
	'/files': `http://localhost:${SYNC_PORT}`,
	'^/api/terminal/(health|sessions|ws)': { target: `ws://localhost:${TERM_PORT}`, ws: true },
	'/api': { target: `http://localhost:${SYNC_PORT}`, ws: true },
} as const
```

Then inside `defineConfig({ ... })`, replace the `server.proxy` literal with `proxy: PROXY,` and add a sibling `preview` block after the `server` block:

```ts
	preview: {
		host: '127.0.0.1',
		strictPort: true,
		proxy: PROXY,
	},
```

Leave `server.port`/`strictPort`/`allowedHosts`/`hmr` exactly as they are. The preview port is supplied on the command line by the harness config (Step 3) rather than pinned here, so it can never collide with the dev stack.

**Step 2: Verify the client still builds**

```bash
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/client' build
```
Expected: a successful `vite build`, with `dist/assets/CanvasV2App-*.js` among the emitted files.

```bash
ls client/dist/assets/ | grep CanvasV2App
```
Expected: exactly one `CanvasV2App-<hash>.js`. **Record its size** — this is the ~4.3 MB figure the harness will attribute against.

**Step 3: Create the harness Playwright config**

Create `e2e/playwright.load.config.ts`:

```ts
// The canvas-v2 LOAD harness's own Playwright config — deliberately separate
// from playwright.config.ts.
//
// WHY A SEPARATE CONFIG: the shared config serves the client from the Vite DEV
// server. In dev the v2 module graph is hundreds of unbundled, individually
// transformed modules — there is no single ~4.3 MB CanvasV2App chunk to time,
// and loro-crdt's WASM arrives via the dep optimizer, not the production path.
// Timing "the lazy chunk" there would measure an artifact that does not exist
// in production, and dev-server module-fetch cost would dominate and
// mis-attribute the whole budget. Attribution IS this harness's purpose, so it
// must run against a real `vite build` served by `vite preview`. Folding that
// build into the shared config would tax every existing e2e run for nothing.
//
// PORTS: preview on 5274, deliberately NOT the shared rig's 5273 — the two
// configs must be runnable back-to-back without a stale-port collision. The
// sync server stays on 8788 (the preview proxy target, and what
// scripts/start-server.ts hardcodes).
import { defineConfig } from '@playwright/test'

export default defineConfig({
	testDir: './perf-load',
	// Load timing is the subject. Parallel workers would contend for CPU and
	// network and corrupt every number; retries would launder a flaky baseline
	// into a green one. Both off, matching playwright.config.ts's reasoning.
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 300_000,
	use: {
		baseURL: 'http://127.0.0.1:5274',
		viewport: { width: 1280, height: 720 },
		deviceScaleFactor: 1,
		colorScheme: 'light',
		locale: 'en-US',
		timezoneId: 'UTC',
		trace: 'off', // tracing perturbs exactly what is being measured
	},
	webServer: [
		{
			command: 'bun scripts/start-server.ts',
			url: 'http://127.0.0.1:8788/api/health',
			reuseExistingServer: false,
			gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
		},
		{
			// PRODUCTION build, served by preview. `--strictPort` so a busy port
			// fails loudly instead of silently serving from somewhere else and
			// producing numbers for the wrong bundle.
			command: 'bunx vite build && bunx vite preview --host 127.0.0.1 --port 5274 --strictPort',
			cwd: '../client',
			url: 'http://127.0.0.1:5274',
			reuseExistingServer: false,
			timeout: 300_000, // a cold `vite build` of this client is slow
		},
	],
})
```

**Step 4: Add the run script**

In `e2e/package.json`, add to `scripts`:

```json
    "perf:load": "bunx playwright test -c playwright.load.config.ts"
```

**Step 5: Scaffold a smoke spec that verifies BOTH engines render under the preview server**

This is the empirical check of the tldraw-license assumption. Create `e2e/perf-load/smoke.spec.ts`:

```ts
// TEMPORARY scaffold (Task 3) — replaced by canvas-v2-load.spec.ts in Task 5.
// Its ONE job: prove that a PRODUCTION client build served by `vite preview`
// at 127.0.0.1 renders BOTH engines. The v1 arm is the real question: README
// warns tldraw enforces a per-domain license and "the editor blanks" without
// VITE_TLDRAW_LICENSE_KEY, exempting only dev/watch and localhost. If this
// case fails, the v1-vs-v2 comparison cannot run on a production build and the
// plan's Task 6 fallback applies.
import { test, expect } from '../lib/fixtures'
import { shape } from '../lib/seed'
import { seedRoomOverWire } from '../lib/wire-seed'

test('v2 renders wire-seeded shapes from a production build', async ({ page }) => {
	await seedRoomOverWire({ base: 'ws://127.0.0.1:8788', room: 'load-smoke-v2', count: 5, mode: 'bulk' })
	await page.goto('/?room=load-smoke-v2&engine=v2')
	await expect(page.locator('[data-shape-id]').first()).toBeVisible({ timeout: 60_000 })
})

test('v1 (tldraw) renders from a production build at 127.0.0.1 without a license key', async ({ page }) => {
	await shape('load-smoke-v1', { type: 'note', x: 0, y: 0, text: 'hello', color: 'yellow' })
	await page.goto('/?room=load-smoke-v1')
	await expect(page.locator('.tl-shape').first()).toBeVisible({ timeout: 60_000 })
})
```

**Step 6: Run the smoke spec**

```bash
cd /home/stag/src/projects/ensembleworks/e2e && bun run perf:load
```
Expected: `2 passed`.

- **If the v2 case fails**, the preview proxy is likely wrong — check the WS upgrade reaches `:8788`. Debug before continuing; nothing downstream works without it.
- **If ONLY the v1 case fails with a blank canvas**, the localhost license exemption does not cover this configuration. **Do not paper over it.** Record the failure verbatim, and apply the Task 6 fallback: the v1 comparison arm runs against the **dev** server (`playwright.config.ts`'s `--project=perf`) instead, with the v1-vs-v2 comparison reported as a **dev-server-conditions ratio** and both v1 and v2 dev numbers captured so the ratio stays apples-to-apples. Note the deviation in the plan doc and the PR body.

**Step 7: Commit**

```bash
git add client/vite.config.ts e2e/playwright.load.config.ts e2e/perf-load/smoke.spec.ts e2e/package.json
git commit -m "test(e2e): production-build load-perf harness config (vite preview + shared proxy)"
```

---

## Task 4: In-page load probe

Collect the timing marks **inside the page**, in page time, with no Playwright IPC in the measurement loop. Polling from the test process would add round-trip latency to the very quantity being measured.

**Files:**
- Create: `e2e/lib/load-probe.ts`

**Step 1: Write the failing test — as an assertion inside the smoke spec**

There is no pure-unit way to test an `addInitScript` payload; its contract is browser behaviour. Extend `e2e/perf-load/smoke.spec.ts` with a third case that asserts the probe's shape, then watch it fail.

Append to `e2e/perf-load/smoke.spec.ts`:

```ts
import { installLoadProbe, readLoadSample, V2_SHAPE_SELECTOR, V2_TOOLBAR_SELECTOR } from '../lib/load-probe'

test('load probe reports every sub-split for a v2 navigation', async ({ page }) => {
	await seedRoomOverWire({ base: 'ws://127.0.0.1:8788', room: 'load-smoke-probe', count: 5, mode: 'bulk' })
	await installLoadProbe(page, { shapeSelector: V2_SHAPE_SELECTOR, toolbarSelector: V2_TOOLBAR_SELECTOR, chunkPattern: 'CanvasV2App' })
	await page.goto('/?room=load-smoke-probe&engine=v2')
	const sample = await readLoadSample(page, 60_000)

	expect(sample.firstShapeMs).toBeGreaterThan(0)
	expect(sample.toolbarMs, 'toolbar mark must be present').not.toBeNull()
	expect(sample.wsOpenMs, 'ws-open mark must be present').not.toBeNull()
	expect(sample.chunkResponseEndMs, 'the production build must expose a CanvasV2App chunk resource timing').not.toBeNull()
	// The gap this harness exists to expose: shapes must not be claimed to
	// appear BEFORE the toolbar (that would mean the marks are mis-ordered).
	expect(sample.firstShapeMs).toBeGreaterThanOrEqual(sample.toolbarMs!)
})
```

**Step 2: Run it to see it fail**

```bash
cd /home/stag/src/projects/ensembleworks/e2e && bun run perf:load
```
Expected: FAIL — `Cannot find module '../lib/load-probe'`.

**Record the verbatim failure. If it does not fail, STOP and report.**

**Step 3: Write the implementation**

Create `e2e/lib/load-probe.ts`:

```ts
// In-page timing probe for the canvas-v2 load harness.
//
// MEASUREMENT PRINCIPLE: every mark is taken INSIDE the page, in page time
// (performance.now(), i.e. ms since navigation start), and read out ONCE at the
// end. Polling from the Playwright process would put a CDP round trip inside
// the quantity being measured — the harness would then be partly measuring
// itself.
//
// WHY NOT waitForBoot's toolbar signal AS the metric (lib/canvas-v2.ts): the
// toolbar becomes visible as soon as CanvasV2App's boot() calls setSession,
// which can happen LONG before any pre-seeded shape has been backfilled,
// imported and painted. The toolbar->first-shape gap is exactly the
// user-visible symptom this harness was built to hunt, so the toolbar is
// recorded as a SUB-SPLIT and the first-shape paint is the PRIMARY metric.
import type { Page } from '@playwright/test'
import type { LoadSample } from './load-metrics.ts'

/** canvas-react stamps these on every rendered shape body (ShapeBody.tsx). */
export const V2_SHAPE_SELECTOR = '[data-shape-id]'
export const V2_TOOLBAR_SELECTOR = '[data-canvas-v2-tool="select"]'
/** tldraw's own rendered-shape class — the v1 comparison arm. */
export const V1_SHAPE_SELECTOR = '.tl-shape'

export interface ProbeOpts {
	readonly shapeSelector: string
	/** Null for the v1 arm (no v2 toolbar exists there). */
	readonly toolbarSelector: string | null
	/** Substring matched against Resource Timing entry names to find the lazy
	 * chunk, e.g. 'CanvasV2App'. Null for the v1 arm. */
	readonly chunkPattern: string | null
}

/** Installs the probe. MUST be called BEFORE `page.goto` — addInitScript takes
 * effect on the NEXT navigation (same ordering rule lib/perf.ts's
 * installSampler documents). */
export async function installLoadProbe(page: Page, opts: ProbeOpts): Promise<void> {
	await page.addInitScript((o: ProbeOpts) => {
		const w = window as unknown as { __ewLoad: Record<string, number | null> }
		w.__ewLoad = { wsOpenMs: null, chunkResponseEndMs: null, toolbarMs: null, firstShapeMs: null }

		// --- WS open. Patch the constructor rather than reading Resource Timing:
		// WebSocket upgrades do not appear as resource entries. Only the v2 sync
		// socket is timed; Vite's HMR socket and any other socket are ignored.
		const NativeWS = window.WebSocket
		const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
			const sock = new NativeWS(url as string, protocols as string[])
			if (String(url).includes('/sync/v2/')) {
				sock.addEventListener('open', () => {
					if (w.__ewLoad.wsOpenMs === null) w.__ewLoad.wsOpenMs = performance.now()
				})
			}
			return sock
		} as unknown as typeof WebSocket
		Patched.prototype = NativeWS.prototype
		;(window as { WebSocket: typeof WebSocket }).WebSocket = Patched

		// --- Lazy-chunk responseEnd, via PerformanceObserver so the entry cannot
		// be missed by a late poll (the resource buffer can also be evicted).
		if (o.chunkPattern) {
			const pattern = o.chunkPattern
			new PerformanceObserver((list) => {
				for (const e of list.getEntries()) {
					if (e.name.includes(pattern) && w.__ewLoad.chunkResponseEndMs === null) {
						w.__ewLoad.chunkResponseEndMs = (e as PerformanceResourceTiming).responseEnd
					}
				}
			}).observe({ type: 'resource', buffered: true })
		}

		// --- DOM marks. One MutationObserver over the whole document, checking
		// both selectors on every batch. A MutationObserver (not polling) so the
		// mark lands within the same task the node was inserted in — polling at
		// any interval would quantise the very gap being measured.
		const check = () => {
			if (w.__ewLoad.toolbarMs === null && o.toolbarSelector && document.querySelector(o.toolbarSelector)) {
				w.__ewLoad.toolbarMs = performance.now()
			}
			if (w.__ewLoad.firstShapeMs === null && document.querySelector(o.shapeSelector)) {
				w.__ewLoad.firstShapeMs = performance.now()
			}
			return w.__ewLoad.firstShapeMs !== null
		}
		const mo = new MutationObserver(() => { if (check()) mo.disconnect() })
		const start = () => { if (!check()) mo.observe(document.documentElement, { childList: true, subtree: true }) }
		if (document.documentElement) start()
		else document.addEventListener('readystatechange', start, { once: true })
	}, opts)
}

/** Waits for the first-shape mark, then reads the whole sample out in ONE
 * evaluate. Throws with the partial marks attached on timeout — a bare
 * "timed out" would hide which stage the boot actually died at. */
export async function readLoadSample(page: Page, timeoutMs: number): Promise<LoadSample> {
	try {
		await page.waitForFunction(
			() => (window as unknown as { __ewLoad?: { firstShapeMs: number | null } }).__ewLoad?.firstShapeMs !== null,
			undefined,
			{ timeout: timeoutMs },
		)
	} catch (err) {
		const partial = await page.evaluate(() => (window as unknown as { __ewLoad?: unknown }).__ewLoad ?? null)
		throw new Error(`load probe never saw a first shape within ${timeoutMs}ms. Partial marks: ${JSON.stringify(partial)}`)
	}
	const raw = await page.evaluate(() => (window as unknown as { __ewLoad: Record<string, number | null> }).__ewLoad)
	// `firstShapeMs` is typed non-nullable on LoadSample, so THIS is the only
	// place a null or a NaN could enter the pipeline — a `!` here would be the
	// type-level hole. It must be a real check, not an assertion: summarize()
	// rejects non-finite input downstream, but by then the sample has lost all
	// context about which stage of which rep produced it. Fail here, with the
	// partial marks, where the message can still say something useful.
	if (!Number.isFinite(raw.firstShapeMs)) {
		throw new Error(`load probe returned a non-finite firstShapeMs (${String(raw.firstShapeMs)}). Partial marks: ${JSON.stringify(raw)}`)
	}
	return {
		wsOpenMs: raw.wsOpenMs,
		chunkResponseEndMs: raw.chunkResponseEndMs,
		toolbarMs: raw.toolbarMs,
		firstShapeMs: raw.firstShapeMs as number,
	}
}
```

**Step 4: Run to see it pass**

```bash
cd /home/stag/src/projects/ensembleworks/e2e && bun run perf:load
```
Expected: `3 passed`.

If `chunkResponseEndMs` comes back null, the emitted chunk is not named `CanvasV2App` — check `ls client/dist/assets/` and adjust `chunkPattern`. **Report the actual name if it differs.**

**Step 5: Typecheck and commit**

```bash
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/e2e' typecheck
git add e2e/lib/load-probe.ts e2e/perf-load/smoke.spec.ts
git commit -m "test(e2e): in-page load probe for ws-open/chunk/toolbar/first-shape marks"
```

---

## Task 5: The v2 load spec — warm scenarios

**Files:**
- Create: `e2e/perf-load/canvas-v2-load.spec.ts`
- Delete: `e2e/perf-load/smoke.spec.ts` (its assertions move into the real spec)

### Design decisions baked in here

- **Repetitions.** Each scenario runs `REPS = 5` navigations, each in a **fresh browser context** — so every iteration is a cold HTTP cache, which is the first-visit experience users actually complained about. Five is chosen to make a **median** meaningful, not a p95: see the CHANGE NOTE for why p95 is unreachable at any rep count this harness can afford, and why the median is the better hard gate anyway. **REPS must stay odd** so `pick(0.5)` lands on an exact middle sample.
- **The hard gate is p50; max and spread are advisory.** This is a deliberate, documented departure from the sibling `canvas-v2-perf.spec.ts` convention — one that summarises hundreds of frame samples per run, where p95 is a real percentile. Do not "restore" p95 here without first raising REPS above 20 and justifying the CI cost.
- **Fresh context, not fresh page.** `page.reload()` or a second page in the same context would reuse the HTTP cache and the compiled-WASM cache, producing a warm-cache number mislabelled as a load number.
- **Room per scenario per rep.** Reusing a room across reps warms the server actor, which is the axis Task 8 measures deliberately — it must not leak into the warm-baseline scenarios by accident.

**Step 1: Write the failing spec**

Create `e2e/perf-load/canvas-v2-load.spec.ts`:

```ts
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
import { installLoadProbe, readLoadSample, V2_SHAPE_SELECTOR, V2_TOOLBAR_SELECTOR } from '../lib/load-probe'
import { seedRoomOverWire, type SeedMode } from '../lib/wire-seed'

const WS_BASE = 'ws://127.0.0.1:8788'
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
 * measure something else). Returns per-rep attributions. */
async function runScenario(
	browser: import('@playwright/test').Browser,
	opts: { room: string; count: number; mode: SeedMode; engineParam: 'v2' | null },
) {
	const samples: LoadSample[] = []
	for (let rep = 0; rep < REPS; rep++) {
		const room = `${opts.room}-r${rep}`
		const seeded = await seedRoomOverWire({ base: WS_BASE, room, count: opts.count, mode: opts.mode })
		expect(seeded.count, 'seeder must have landed the requested shape count').toBe(opts.count)

		const context = await browser.newContext({
			storageState: identityState('E2E One', 'e2e-user-0000-0000-0001'),
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
		samples.push(await readLoadSample(page, 120_000))
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

	test('v2 load @ 100 shapes, bulk commit, warm actor', async ({ browser }) => {
		const attrs = await runScenario(browser, { room: 'v2load-small-warm', count: 100, mode: 'bulk', engineParam: 'v2' })
		const out = report('v2 @100 bulk warm', attrs)
		maybeRecord('v2-100-bulk-warm', out)
		assertBudget('v2 @100 bulk warm', out.firstShapeMs, SMALL_WARM_BUDGET_MS)
	})

	test('v2 load @ 1000 shapes, bulk commit, warm actor', async ({ browser }) => {
		const attrs = await runScenario(browser, { room: 'v2load-1k-warm', count: 1000, mode: 'bulk', engineParam: 'v2' })
		const out = report('v2 @1000 bulk warm', attrs)
		maybeRecord('v2-1000-bulk-warm', out)
		assertNoRegression('v2 @1000 bulk warm', out.firstShapeMs, 'v2-1000-bulk-warm')
	})
})
```

**Step 2: Run it to see it fail**

```bash
cd /home/stag/src/projects/ensembleworks/e2e && bun run perf:load
```

Expected: BOTH tests FAIL, for two *different* and both-correct reasons:
- `v2 @100` fails on `expect(budgetMs).toBeGreaterThan(0)` — `SMALL_WARM_BUDGET_MS` is still the placeholder `0`.
- `v2 @1000` fails with `no committed firstShapeMs.p50ms baseline to gate against`.

**Record both verbatim failures.** These are the intended RED. They are resolved in Task 9, not now. **If either test PASSES at this step, STOP and report** — a passing gate with no baseline and a zero budget would mean the gates are dead code, which is exactly the failure mode `canvas-v2-perf.spec.ts`'s module header records having been caught once before.

**Step 3: Delete the scaffold**

```bash
rm /home/stag/src/projects/ensembleworks/e2e/perf-load/smoke.spec.ts
```

**Step 4: Typecheck and commit**

```bash
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/e2e' typecheck
git add -A e2e/perf-load e2e/lib
git commit -m "test(e2e): v2 time-to-first-shape scenarios with wire seeding and sub-split attribution"
```

---

## Task 6: The v1 comparison arm

The owner's acceptance bar is "at least performance parity with v1, if not an improvement." A v2 number alone cannot answer that — report v1's load time side by side.

**Files:**
- Modify: `e2e/perf-load/canvas-v2-load.spec.ts`

### Note on the asymmetry — it is intentional and must be documented in the code

The two arms seed differently, because the two engines have genuinely different backends: v1 writes through the legacy tldraw store (HTTP `/api/canvas/shape`, `e2e/lib/seed.ts`), v2 through the Loro room actor (`/sync/v2` WebSocket). There is no single seeding mechanism that reaches both — `canvas-v2-perf.spec.ts`'s module header records this same finding. The comparison is still valid because both arms measure the identical user-visible quantity (navigation → first shape painted) for the identical shape count.

**Step 1: Write the failing test**

Add to `canvas-v2-load.spec.ts` — imports first:

```ts
import { shape as httpShape } from '../lib/seed'
import { V1_SHAPE_SELECTOR } from '../lib/load-probe'
```

Then a v1 runner and the test, inside the `test.describe`:

```ts
	/** The v1 (tldraw) arm. Seeds over the legacy HTTP agent API rather than the
	 * /sync/v2 wire, because the two engines have genuinely different backends
	 * — v1 has no Loro actor and /api/canvas/shape has no v2 equivalent (see
	 * canvas-v2-perf.spec.ts's module header, which records the same finding).
	 * The comparison stays honest because both arms measure the SAME
	 * user-visible quantity — navigation -> first shape painted — at the same
	 * shape count. */
	async function runV1(browser: import('@playwright/test').Browser, room: string, count: number) {
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
				storageState: identityState('E2E One', 'e2e-user-0000-0000-0001'),
				viewport: { width: 1280, height: 720 },
			})
			const page = await context.newPage()
			await installLoadProbe(page, { shapeSelector: V1_SHAPE_SELECTOR, toolbarSelector: null, chunkPattern: null })
			await page.goto(`/?room=${r}`)
			samples.push(await readLoadSample(page, 120_000))
			await context.close()
		}
		return samples.map(attribute)
	}

	test('v1 (tldraw) load @ 100 shapes — the parity reference', async ({ browser }) => {
		const attrs = await runV1(browser, 'v1load-small', 100)
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
```

**Step 2: Run it**

```bash
cd /home/stag/src/projects/ensembleworks/e2e && bun run perf:load -g "v1 \(tldraw\)"
```
Expected: PASS, and a `[v2-load] v1 @100 ...` block in stdout with a real `firstShapeMs` p50/min/max/spread/cv. The `PARITY @100` line will report "no committed baseline yet" until Task 9.

**If the v1 test fails with a blank canvas / no `.tl-shape` ever appearing**, the tldraw license exemption does not cover the preview server — apply the Task 3 Step 6 fallback (run the v1 arm under the dev-server config) and **report the deviation**.

**Step 3: Commit**

```bash
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/e2e' typecheck
git add e2e/perf-load/canvas-v2-load.spec.ts
git commit -m "test(e2e): v1 tldraw load arm reported side by side with v2"
```

---

## Task 7: The oplog-volume axis

Shape count and oplog volume are **independent** variables. 1000 shapes committed as 1000 separate commits is a very different oplog from the same 1000 shapes in one bulk commit — same rendered content, very different replay and backfill cost. Distinguishing them is what separates "the backfill ships too much data" from "the backfill ships too many ops" (candidate contributor (b)).

`lib/wire-seed.ts` already supports both modes. This task adds the scenario that exploits the difference and asserts the axis is actually discriminating.

**Files:**
- Modify: `e2e/perf-load/canvas-v2-load.spec.ts`

**Step 1: Write the failing test**

Add inside the `test.describe`:

```ts
	test('v2 load @ 1000 shapes, PER-SHAPE commits — the oplog-volume axis', async ({ browser }) => {
		const attrs = await runScenario(browser, { room: 'v2load-1k-percommit', count: 1000, mode: 'per-shape', engineParam: 'v2' })
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
```

**Step 2: Run it to see it fail**

```bash
cd /home/stag/src/projects/ensembleworks/e2e && bun run perf:load -g "PER-SHAPE"
```
Expected: FAIL — `no committed firstShapeMs.p50ms baseline to gate against`, from `assertNoRegression`. **Record it verbatim.** Resolved in Task 9.

**Step 3: Sanity-check the axis is real, before trusting it**

Comment out the `assertNoRegression` line temporarily and run both 1k scenarios, then compare the printed `firstShapeMs` p50s:

```bash
cd /home/stag/src/projects/ensembleworks/e2e && bun run perf:load -g "@ 1000"
```

If per-shape and bulk come out **identical to within a millisecond**, that is suspicious — either the seeder is not actually producing different oplogs, or the backfill is snapshot-shaped. Verify with a direct check before proceeding:

```bash
cd /home/stag/src/projects/ensembleworks && bun -e "
import { seedRoomOverWire, openPeer } from './e2e/lib/wire-seed.ts'
console.log(await seedRoomOverWire({ base: 'ws://127.0.0.1:8788', room: 'axis-bulk', count: 200, mode: 'bulk' }))
console.log(await seedRoomOverWire({ base: 'ws://127.0.0.1:8788', room: 'axis-per', count: 200, mode: 'per-shape' }))
"
```
(Requires a server on :8788 — start one with `cd e2e && bun scripts/start-server.ts` in another shell.)
Expected: `commits: 1` vs `commits: 200`. If both report the same commit count, the seeder is wrong — fix it before recording any baseline. **Restore the `assertNoRegression` line before committing.**

**Step 4: Commit**

```bash
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/e2e' typecheck
git add e2e/perf-load/canvas-v2-load.spec.ts
git commit -m "test(e2e): oplog-volume axis — 1k shapes as one commit vs 1k commits"
```

---

## Task 8: Cold-actor scenario

Candidate contributor (d) is the server blocking on replay while a **cold** room actor loads its snapshot + oplog from SQLite. Every scenario so far measures a **warm** actor, because the wire seeder itself just warmed it.

There is currently **no way to force an actor cold from outside the process.** `CanvasActors.sweepIdle(idleTtlMs)` exists (`server/src/canvas-v2/actors.ts`) but is driven by an internal interval with no env knob, and a live socket vetoes eviction. So this task adds a **flag-gated, test-only HTTP endpoint** that forces a sweep.

**Files:**
- Modify: `server/src/app.ts`
- Create: `server/src/canvas-v2/test-evict.test.ts`
- Modify: `e2e/lib/wire-seed.ts`
- Modify: `e2e/perf-load/canvas-v2-load.spec.ts`
- Modify: `e2e/scripts/start-server.ts`

**Step 1: Write the failing server test**

Create `server/src/canvas-v2/test-evict.test.ts`:

```ts
// Run: bun server/src/canvas-v2/test-evict.test.ts
// The test-only cold-actor hook: POST /api/canvas-v2/test/evict/:roomId forces
// an immediate idle sweep, so a perf harness can measure a genuinely COLD room
// (snapshot + oplog reload from SQLite) rather than the warm actor its own
// seeding just created. Gated behind EW_CANVAS_TEST_EVICT=1 and 404s otherwise
// — a production deployment must not be able to evict a room over HTTP.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from '../app.ts'

async function boot(env: Record<string, string | undefined>) {
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete process.env[k]
		else process.env[k] = v
	}
	const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ew-evict-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((r) => server.listen(0, r))
	const port = (server.address() as { port: number }).port
	return { server, dataDir, url: `http://127.0.0.1:${port}` }
}

{
	// Flag OFF: the route must not exist.
	const { server, dataDir, url } = await boot({ EW_CANVAS_SYNC: '1', EW_CANVAS_TEST_EVICT: undefined })
	const res = await fetch(`${url}/api/canvas-v2/test/evict/some-room`, { method: 'POST' })
	assert.equal(res.status, 404, 'the evict hook must 404 when EW_CANVAS_TEST_EVICT is unset')
	server.close()
	rmSync(dataDir, { recursive: true, force: true })
	console.log('ok: evict hook is absent without EW_CANVAS_TEST_EVICT')
}
{
	// Flag ON: the route exists and reports the sweep.
	const { server, dataDir, url } = await boot({ EW_CANVAS_SYNC: '1', EW_CANVAS_TEST_EVICT: '1' })
	const res = await fetch(`${url}/api/canvas-v2/test/evict/some-room`, { method: 'POST' })
	assert.equal(res.status, 200, 'the evict hook responds 200 when enabled')
	assert.deepEqual(await res.json(), { ok: true })
	server.close()
	rmSync(dataDir, { recursive: true, force: true })
	console.log('ok: evict hook responds when EW_CANVAS_TEST_EVICT=1')
}

console.log('ok: test-evict — all cases')
process.exit(0)
```

**Step 2: Run it to see it fail**

```bash
cd /home/stag/src/projects/ensembleworks && bun server/src/canvas-v2/test-evict.test.ts
```
Expected: FAIL on the second case — `expected 200, got 404`. **Record it verbatim. If it does not fail, STOP and report** (a pre-existing route by that name would be a genuine surprise worth investigating).

**Step 3: Implement the hook**

In `server/src/app.ts`, near the other `/api` route registrations and **after** `canvasActors` is constructed (currently line ~182), add:

```ts
	// TEST-ONLY cold-actor hook (2026-07-19, docs/plans/2026-07-19-v2-first-shape-perf-harness.md).
	// Forces an immediate idle sweep so the load-perf harness can measure a
	// genuinely COLD room actor — one that must reload its snapshot + replay its
	// oplog from SQLite — instead of the warm actor the harness's own wire
	// seeding just created. There is no other way to force this from outside the
	// process: sweepIdle is driven by an internal interval with no env knob.
	//
	// DOUBLE-GATED: requires BOTH EW_CANVAS_SYNC=1 (canvasActors exists at all)
	// AND EW_CANVAS_TEST_EVICT=1. Absent the second flag the route is never
	// registered, so a production deployment cannot evict a live room over HTTP
	// even if someone guesses the path.
	if (canvasActors && process.env.EW_CANVAS_TEST_EVICT === '1') {
		app.post('/api/canvas-v2/test/evict/:roomId', (_req, res) => {
			// TTL 0 = "every actor is idle enough". A live socket still vetoes
			// eviction (sweepIdle's own rule), which is correct: the harness closes
			// its seeder peers before calling this.
			canvasActors.sweepIdle(0)
			res.json({ ok: true })
		})
	}
```

Adjust `app.post`/`res.json` to match the surrounding router's actual idiom — read the neighbouring route registrations in `server/src/app.ts` and copy their style exactly rather than assuming Express defaults.

**Step 4: Run to see it pass**

```bash
cd /home/stag/src/projects/ensembleworks && bun server/src/canvas-v2/test-evict.test.ts
```
Expected: three `ok:` lines.

**Step 5: Enable the flag in the e2e rig**

In `e2e/scripts/start-server.ts`, beside the existing `EW_CANVAS_SYNC` default, add:

```ts
// EW_CANVAS_TEST_EVICT=1 (default ON for the e2e rig, unless a caller sets it):
// registers the test-only cold-actor eviction hook the load-perf harness needs
// (perf-load/canvas-v2-load.spec.ts's cold scenario). Purely ADDITIVE — it only
// ever ADDS one route, gated on this flag, which no other spec calls.
if (process.env.EW_CANVAS_TEST_EVICT === undefined) process.env.EW_CANVAS_TEST_EVICT = '1'
```

**Step 6: Add the harness helper**

Append to `e2e/lib/wire-seed.ts`:

```ts
/** Forces the server to evict `room`'s in-memory actor, so the NEXT connection
 * pays a genuinely cold load (snapshot + oplog replay from SQLite) — candidate
 * contributor (d). Requires the server to run with EW_CANVAS_TEST_EVICT=1
 * (e2e/scripts/start-server.ts defaults it on). `base` here is the HTTP origin,
 * not the ws:// one. Every seeder peer must be CLOSED before calling: a live
 * socket vetoes eviction by design, and this would then silently no-op and
 * quietly measure a warm actor. */
export async function evictRoomActor(httpBase: string, room: string): Promise<void> {
	const res = await fetch(`${httpBase}/api/canvas-v2/test/evict/${room}`, { method: 'POST' })
	if (!res.ok) throw new Error(`evictRoomActor(${room}) failed: ${res.status} ${await res.text()}`)
}
```

**Step 7: Add the cold scenario**

In `canvas-v2-load.spec.ts`, import `evictRoomActor`, add `const HTTP_BASE = 'http://127.0.0.1:8788'`, extend `runScenario`'s opts with `cold?: boolean`, and insert immediately after the `seedRoomOverWire(...)` call inside the rep loop:

```ts
		// COLD: seedRoomOverWire has already closed both its peers, so no live
		// socket vetoes the sweep. The very next connection — the browser's — pays
		// the full snapshot-load + oplog-replay cost.
		if (opts.cold) await evictRoomActor(HTTP_BASE, room)
```

Then add the test:

```ts
	test('v2 load @ 1000 shapes, bulk commit, COLD actor', async ({ browser }) => {
		const attrs = await runScenario(browser, { room: 'v2load-1k-cold', count: 1000, mode: 'bulk', engineParam: 'v2', cold: true })
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
```

**Step 8: Run to see the expected RED**

```bash
cd /home/stag/src/projects/ensembleworks/e2e && bun run perf:load -g "COLD"
```
Expected: FAIL on the missing baseline (resolved in Task 9). **Record it verbatim.**

**Step 9: Full unit suite + typecheck + commit**

```bash
cd /home/stag/src/projects/ensembleworks
bun run typecheck
UX_CONTRACT_PR_BODY='ux-contract: none — pure measurement harness under e2e/ plus a flag-gated server test hook; no tool FSM, renderer, or input surface is touched.' bun run test
git add server/src/app.ts server/src/canvas-v2/test-evict.test.ts e2e/scripts/start-server.ts e2e/lib/wire-seed.ts e2e/perf-load/canvas-v2-load.spec.ts
git commit -m "test(e2e,server): flag-gated cold-actor eviction hook and cold load scenario"
```

---

## Task 9: Capture and commit baselines; set the hard budget

Every gate is currently RED-by-construction. This task turns them green **from real measurements**, not from guesses.

**Files:**
- Create: `e2e/baselines/canvas-v2-load.json`
- Modify: `e2e/perf-load/canvas-v2-load.spec.ts` (set `SMALL_WARM_BUDGET_MS`)

**Step 1: Capture**

```bash
cd /home/stag/src/projects/ensembleworks/e2e && EW_CAPTURE=1 bun run perf:load
```

The run will still **fail** its gates (that is expected — the gates compare against baselines that did not exist when the module loaded), but `EW_CAPTURE=1` writes `e2e/baselines/canvas-v2-load.json` regardless. This is the documented behaviour of the house `recordTo` mechanism and of `canvas-v2-perf.spec.ts`'s always-on-gate pattern: baselines are loaded at module scope **before** any capture write, so a capture run can never trivially satisfy its own gate.

**Step 2: Add provenance**

Hand-edit `e2e/baselines/canvas-v2-load.json` to add a top-level `_provenance` key, matching `e2e/baselines/canvas-v2-perf.json`'s existing shape:

```json
  "_provenance": {
    "host": "<your hostname>",
    "date": "2026-07-19",
    "note": "dev-box capture, production client build via vite preview, cold HTTP cache per rep. Gated statistic is the MEDIAN (p50) of REPS=5; max and cv% are advisory, because at n=5 the house p95 formula returns the max. CI runners are more contended, hence the 2x margin. Branch point: fix/v2-boot-sync-ready (no fixed boot settle sleep)."
  },
```

**Step 3: Set the absolute budget**

Read the captured `v2-100-bulk-warm.firstShapeMs.p50ms`. Round **up** to the next 250 ms. Set `SMALL_WARM_BUDGET_MS` in `canvas-v2-load.spec.ts` to that value, and replace the placeholder comment with the actual evidence:

```ts
/** ABSOLUTE budget for the small/warm scenario. Set from the 2026-07-19
 * capture: observed p50 = <X>ms on <host>, rounded up to the next 250ms.
 * Multiplied by CI_MARGIN_MULTIPLIER at the gate; both the raw and margined
 * figures are printed, so retuning is a one-constant change with its evidence
 * beside it. */
const SMALL_WARM_BUDGET_MS = <rounded value>
```

**Step 4: Re-run without capture — everything must now be GREEN**

```bash
cd /home/stag/src/projects/ensembleworks/e2e && bun run perf:load
```
Expected: all 5 tests pass. Every scenario prints its full sub-split block.

**If any scenario fails on its second consecutive run against its own just-captured baseline, the metric is too noisy to gate.** Do not widen `REGRESSION_BUDGET` to make it pass. Raise `REPS` — **to the next ODD value (5 → 7 → 9)**, since `pick(0.5)` only lands on an exact middle sample at odd n — re-capture, and if it is still unstable, **report**. A flaky baseline is a broken baseline (`playwright.config.ts`: "a flaky baseline is a broken baseline — fix, don't retry").

Note that with a **median** gate this failure mode should now be rare: it takes three of five reps moving together to shift p50, which is a real signal, not a hiccup. If a median gate is flaking, suspect the measurement rather than the runner — and the `cv%` line printed beside every scenario is the first place to look.

**Step 4a: Tune the dispersion advisory from the evidence you just gathered**

`SPREAD_ADVISORY_CV_PCT` shipped at a provisional `25`. Read the `cv=` figure printed by every scenario across both runs and set it so it sits **above the normal spread of a healthy run but below an obviously degraded one** — roughly 1.5–2× the worst cv you saw on a clean dev-box capture. Record the observed cvs in the results document's provenance section so the next person can re-tune against evidence rather than re-guessing.

If a scenario's cv is already above 25% on an idle dev box, **do not simply raise the threshold** — that is the harness telling you the scenario is not measuring a stable thing, and it is worth understanding before any of its numbers are trusted. Report it.

**Step 5: Write the results document**

This is the deliverable that justifies the whole harness. It does **not** go in this plan document — see "The `docs/performance/` results convention" immediately below for the directory, the naming rule, the required structure, and the never-edit-in-place rule. Create `docs/performance/` and write `docs/performance/2026-07-19-v2-load-baseline.md` using the template given there, filling every field from the run you just captured.

**Do not speculate beyond what the numbers show.** If a split is ambiguous, say so in the "What this tells us" section and name the follow-up measurement that would disambiguate it.

**Step 6: Commit**

```bash
cd /home/stag/src/projects/ensembleworks
git add e2e/baselines/canvas-v2-load.json e2e/perf-load/canvas-v2-load.spec.ts docs/performance/2026-07-19-v2-load-baseline.md
git commit -m "perf(e2e): capture v2 first-shape baselines and record the load-baseline results doc"
```

---

## The `docs/performance/` results convention

*(Introduced by this plan. Task 9 Step 5 produces the first document in the series; every future load/perf measurement campaign adds another.)*

### Why results do not live in plan documents

A plan is a record of **intent**. It goes stale the moment it is executed, and it is never revisited except as history. These numbers are the opposite: a **longitudinal artifact** that the coming optimisation work will compare against repeatedly. Burying them inside a merged plan doc means that six months of load measurements can only be read as archaeology across a scatter of unrelated plan files. Given their own dated directory they read as a series — which is the only way a trend is visible at all.

### Naming

```
docs/performance/YYYY-MM-DD-<type>.md
```

`<type>` names the **measurement family**, not the individual run, so successors sort and read naturally beside their predecessors. This plan produces:

```
docs/performance/2026-07-19-v2-load-baseline.md
```

A later campaign measuring the same family after a snapshot-mode first sync lands would be `docs/performance/2026-08-14-v2-load-postsnapshot.md`. Same family, same shape, directly diffable against the baseline. Do not invent a new `<type>` for what is really a re-measurement of an existing family — that is what defeats the series.

### Relationship to the machine-readable baselines — they must not drift

Two artifacts, two jobs, one rule binding them:

| Artifact | Role |
|---|---|
| `e2e/baselines/canvas-v2-load.json` | **Source of truth for the CI gate.** Machine-read. Rewritten by `EW_CAPTURE=1`. |
| `docs/performance/YYYY-MM-DD-<type>.md` | **Human-facing interpretation** of one specific capture. Never machine-read. |

The rule: **every results document records the commit SHA of the baseline capture it describes**, in its front-matter block. That SHA is what lets a reader confirm whether a given document still describes the currently-committed baseline JSON, or whether it has been superseded.

**Old documents are never edited after the fact.** Re-capturing baselines means writing a **new** dated document, not amending the old one. A document that gets quietly corrected months later is a document nobody can trust to mean what it said at the time — and the whole value of the series is that each entry is a fixed point. If an earlier document turns out to be wrong, the new document says so and cites it; the old file stays as written.

### Required structure — fill this in, do not invent a format

Every document in this series carries these headings, in this order. Copy the template verbatim and fill it.

```markdown
# v2 Load Baseline — 2026-07-19

## Provenance

| Field | Value |
|---|---|
| Measured commit | `<full SHA of HEAD at capture>` |
| Branch | `perf/v2-first-shape-harness` |
| Branch point | `fix/v2-boot-sync-ready` (`1ad72388d7de182251f913d8025e876abf852d92`) — post-settle-sleep-removal |
| Baseline capture SHA | `<SHA of the commit that added/updated e2e/baselines/canvas-v2-load.json>` |
| Environment | `local` or `CI` — say which, explicitly |
| Machine | `<hostname>`, `<CPU>`, `<RAM>`, `<OS>` |
| Machine state | e.g. "idle dev box, no other load" / "GitHub-hosted ubuntu-latest runner, shared/contended" |
| Client build | production `vite build` served by `vite preview` |
| Cache state | cold HTTP cache per repetition (fresh browser context) |
| Reps per scenario | `<REPS>` |
| Harness | `e2e/perf-load/canvas-v2-load.spec.ts` via `e2e/playwright.load.config.ts` |

> Numbers from a loaded laptop are not comparable to CI-runner numbers. State the
> environment plainly — a reader six months out will not remember which this was,
> and comparing across environments silently is the main way a series like this
> goes wrong.

## Scenario matrix

All figures in ms. `n/a` where a sub-split does not apply to that arm (the v1 arm
has no v2 chunk and no v2 toolbar). Report **every sub-split, not just totals** —
the totals are what prompted the work, but the sub-splits are what direct it.

| Scenario | Engine | Shapes | Commits | Actor | firstShapeMs p50 (GATED) | firstShapeMs max | firstShapeMs spread | firstShapeMs cv% | wsOpenMs p50 | chunkResponseEndMs p50 | toolbarMs p50 | chunkToToolbarMs p50 | toolbarToFirstShapeMs p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v2 @100 bulk warm | v2 | 100 | 1 | warm | | | | | | | | | |
| v2 @1000 bulk warm | v2 | 1000 | 1 | warm | | | | | | | | | |
| v2 @1000 per-shape warm | v2 | 1000 | 1000 | warm | | | | | | | | | |
| v2 @1000 bulk COLD | v2 | 1000 | 1 | cold | | | | | | | | | |
| v1 @100 | v1 (tldraw) | 100 | n/a | n/a | | | | | n/a | n/a | n/a | n/a | n/a |

> **Report `cv%` for every row, even the good ones.** It is the column that tells
> a future reader whether the run these numbers came from was trustworthy at all.
> A scenario whose median looks fine at cv=45% has not really been measured; a
> median at cv=6% can be leaned on. There is deliberately no p95 column — at
> REPS=5 it would be identically the max (see the CHANGE NOTE).

## Derived comparisons

| Comparison | Value | What it isolates |
|---|---|---|
| v2 @100 p50 ÷ v1 @100 p50 | `<ratio>x` | **Parity ratio.** ≤ 1.00 means at or better than v1 — the owner's acceptance bar. |
| v2 @1000 per-shape p50 ÷ bulk p50 | `<ratio>x` | Contributor (b): op **count** vs bytes. Near 1.0 ⇒ op count is not the bottleneck. |
| v2 @1000 cold p50 − warm p50 | `<delta>ms` | Contributor (d): server-side snapshot load + oplog replay. |
| chunkResponseEndMs p50 (1k warm) | `<ms>` | Contributor (a): the ~4.3 MB lazy chunk. |
| chunkToToolbarMs p50 (1k warm) | `<ms>` | Contributors (c) WASM decode + module eval + boot. |
| toolbarToFirstShapeMs p50 (1k warm) | `<ms>` | Contributors (b) oplog replay + (e) WS round-trip — **the gap the harness was built to expose.** |
| wsOpenMs p50 (1k warm) | `<ms>` | Contributor (e), isolated. |

## Gates in force at capture

| Scenario | Gate | Threshold |
|---|---|---|
| v2 @100 bulk warm | absolute, **p50 (median) hard** | `SMALL_WARM_BUDGET_MS = <X>` × 2 CI margin |
| all others | regression vs committed baseline, **p50 (median) hard** | +15% × 2 CI margin |
| all | max rep, and cv% above `SPREAD_ADVISORY_CV_PCT` | advisory only (`::warning::`) |

## What this tells us

Two to five paragraphs of prose. Name **which of the candidate contributors the
data actually implicates**, and in what proportion — that is the entire point of
the document. The six candidates, for reference:

- (a) the ~4.3 MB `React.lazy` chunk behind `Suspense fallback={null}`
- (b) full-oplog replay vs a snapshot-mode first sync
- (c) base64 WASM decode for `loro-crdt`
- (d) cold-actor blocking replay on the server
- (e) the WS connect + `SyncRequest` round-trip
- (f) the fixed 400 ms boot settle sleep — **already removed** at this branch point;
  it is not present in these numbers and is listed only so the set reads complete.

Rules for this section:

- **Do not speculate beyond the numbers.** If two contributors are confounded in a
  single sub-split, say so and name the follow-up measurement that would separate
  them. An honest "this data cannot distinguish (b) from (e)" is worth more than a
  confident guess.
- **State what was ruled OUT**, not only what was implicated. A contributor the
  data exonerates is a contributor nobody needs to spend a week optimising.
- **Do not propose the fix here.** This document reports what is; the decision
  about what to do belongs in the plan that follows it.

## Follow-ups

Bulleted, each naming a concrete next measurement or a concrete optimisation
candidate with the number that motivates it. No unmotivated items.

Two carried in from the harness's own design, to be restated here with the
numbers this capture produced:

- **Shrink `CI_MARGIN_MULTIPLIER` toward 1.0** once a baseline has been captured
  on the CI runner itself. The 2× exists to absorb the systematic dev-box→runner
  hardware difference; a runner-native baseline removes the need for most of it.
  Quote the dev-box and CI medians side by side to say how much is actually
  needed.
- **Revisit `SPREAD_ADVISORY_CV_PCT`** against the cvs recorded above, and note
  whether any scenario is dispersed enough that its median should not be trusted
  as a gate at all.
```

---

## Task 10: CI wiring

**Files:**
- Create: `.github/workflows/canvas-v2-load.yml`

### The merge-preview gotcha — read before wiring

On a `pull_request` event, GitHub checks out the **merge preview** (your branch merged into its base), not your branch alone. A perf number measured there reflects base + branch, so a base-branch regression can surface as an apparent regression in your PR. `canvas-v2-perf.spec.ts` handles this by **printing provenance** (`GITHUB_EVENT_NAME=pull_request` ⇒ "this is the MERGE PREVIEW…") rather than by trying to defeat it — the same `beforeAll` block is already in `canvas-v2-load.spec.ts` from Task 5. Do not attempt a `checkout: ref: ${{ github.event.pull_request.head.sha }}` workaround: that would diverge from the sibling perf job's convention and produce two incomparable provenance stories in one repo.

**Step 1: Write the workflow**

Create `.github/workflows/canvas-v2-load.yml`:

```yaml
name: canvas-v2-load
on:
  pull_request:
    # Same renderer-PR gating philosophy as canvas-v2-perf.yml: only PRs that
    # touch the load path pay for this job. The server paths are here (unlike
    # in canvas-v2-perf.yml) because THIS harness's subject includes server-side
    # backfill and cold-actor replay.
    paths:
      - 'canvas-react/**'
      - 'canvas-editor/**'
      - 'canvas-doc/**'
      - 'canvas-sync/**'
      - 'client/src/canvas-v2/**'
      - 'client/src/main.tsx'
      - 'client/vite.config.ts'
      - 'server/src/canvas-v2/**'
      - 'e2e/perf-load/**'
      - 'e2e/lib/wire-seed.ts'
      - 'e2e/lib/load-probe.ts'
      - 'e2e/lib/load-metrics.ts'
      - 'e2e/playwright.load.config.ts'
      - '.github/workflows/canvas-v2-load.yml'
  schedule:
    - cron: '53 5 * * *'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  canvas-v2-load:
    runs-on: ubuntu-latest
    # Sized for REPS=5 across 5 scenarios = 25 full production-build navigations,
    # plus install + playwright + vite build. RAISE THIS IF REPS IS EVER RAISED:
    # the measurement time scales linearly with it (REPS=7 is ~1.4x, REPS=21 is
    # ~4.2x and would not fit). See the spec's REPS comment.
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - uses: actions/setup-node@v4
        with: { node-version: 22.12.0 }
      - run: bun install --frozen-lockfile
      - run: cd e2e && bunx playwright install --with-deps chromium
      # EW_CAPTURE=1 matches canvas-v2-perf.yml: every run is worth recording,
      # and the gates still compare against the COMMITTED baseline because the
      # spec loads it at module scope BEFORE any capture write. The uploaded
      # JSON is an artifact for a reviewer, never a repo commit — a deliberate
      # baseline update is a human running capture locally and committing it.
      - run: cd e2e && EW_CAPTURE=1 bunx playwright test -c playwright.load.config.ts
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: canvas-v2-load-failures-${{ github.run_id }}
          path: |
            e2e/test-results/
            e2e/playwright-report/
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: canvas-v2-load-baseline-${{ github.run_id }}
          path: e2e/baselines/canvas-v2-load.json
          retention-days: 14
```

**Step 2: Validate the YAML**

```bash
cd /home/stag/src/projects/ensembleworks && bunx js-yaml .github/workflows/canvas-v2-load.yml > /dev/null && echo "YAML OK"
```
Expected: `YAML OK`. (If `js-yaml` is unavailable, any YAML parser will do — the point is to catch an indentation error before pushing.)

**Step 3: Commit**

```bash
git add .github/workflows/canvas-v2-load.yml
git commit -m "ci: canvas-v2 load-perf workflow with baseline artifact upload"
```

---

## Task 11: Final verification and PR

**Step 1: Full verification sweep**

Run every check, and read the output rather than assuming it passed:

```bash
cd /home/stag/src/projects/ensembleworks
bun run typecheck
UX_CONTRACT_PR_BODY='ux-contract: none — pure measurement harness under e2e/ plus a flag-gated server test hook; no tool FSM, renderer, or input surface is touched.' bun run test
bun run build
cd e2e && bunx playwright test --project=e2e
cd e2e && bunx playwright test --project=perf
cd e2e && bun run perf:load
```

All must pass. The two pre-existing Playwright projects are in the list because Task 3 modified `client/vite.config.ts` and Task 8 modified `e2e/scripts/start-server.ts` — both are shared with the existing rig, and a regression there is this branch's to answer for.

**Step 2: Confirm the branch point is still intact**

```bash
git merge-base --is-ancestor 1ad72388d7de182251f913d8025e876abf852d92 HEAD && echo "PR-48 fix present in the measured configuration"
```
Expected: the confirmation line. If it fails, someone rebased onto pre-PR-48 `main` and every recorded baseline is invalid — **re-capture before proceeding.**

**Step 3: Open the PR**

The PR body **must** contain the interaction-contract opt-out line verbatim:

```
ux-contract: none — pure measurement harness under e2e/ plus a flag-gated server test hook; no tool FSM, renderer, or input surface is touched.
```

### Why an opt-out rather than a contract

CLAUDE.md requires that any unit touching an interaction-bearing surface either declares a contract in `@ensembleworks/interaction-contracts` or records `ux-contract: none — <reason>` in the PR body. `scripts/ux-contract-presence.test.ts` enforces the declaration mechanically, keyed on three prefixes: `canvas-editor/src/tools/`, `canvas-react/src/`, `client/src/canvas-v2/`.

This branch touches **none** of them — its diff is `e2e/`, `scripts/run-tests.ts`, `client/vite.config.ts`, `server/src/`, `.github/`, `docs/`. So the gate would pass with no marker at all. The marker goes in anyway, because the CLAUDE.md **policy** is broader than the mechanical gate, and because a reviewer should see the reasoning stated rather than inferred from the gate's silence.

**Watch out:** if you end up adding boot-path instrumentation inside `client/src/canvas-v2/CanvasV2App.tsx` — a tempting way to get finer marks — you **will** trip the gate, and the opt-out reason above becomes false. In that case either keep the marker but rewrite its reason honestly, or declare a real contract. Do not edit the gate.

Full PR body:

```markdown
## Canvas v2 time-to-first-shape measurement harness

Makes v2 room load performance observable, attributable, comparable to v1, and regression-gated — so subsequent optimisation work is measurement-driven rather than guesswork.

### What it measures
- **Primary:** `firstShapeMs` — navigation start → first *pre-seeded* shape painted. Deliberately NOT the toolbar signal; the toolbar-to-first-shape gap is the symptom being hunted and is reported as its own sub-split.
- **Sub-splits:** WS-open, lazy-chunk `responseEnd`, chunk→toolbar (module eval + WASM init), toolbar→first-shape.
- **Axes:** shape count; oplog volume (1 bulk commit vs N commits for identical content); cold vs warm server actor.
- **v1 parity:** tldraw's load time reported side by side, since parity with v1 is the acceptance bar.

### How it differs from the existing perf rig
- Seeds **over the real `/sync/v2` WebSocket** with a headless `SyncClientPeer` before the browser navigates, so first paint travels the genuine backfill path. The existing v2 perf spec seeds after boot via `window.__ew.doc`, which bypasses the wire entirely.
- Runs against a **production `vite build` served by `vite preview`**, not the Vite dev server. In dev there is no single ~4.3 MB `CanvasV2App` chunk to time and WASM arrives via the dep optimiser — timing it there would measure an artifact that does not exist in production.

### Branch point
Cut from `fix/v2-boot-sync-ready`, not `main`, deliberately. `main` still has the unconditional 400 ms boot settle sleep; that removal is unconditional and will never ship again, so a baseline containing it would describe a configuration we never run. All baselines here are post-sleep-removal.

### Gating
**p50 (median) is the hard gate; max and coefficient-of-variation are advisory (`::warning::`); min/spread observed-only.** This is a deliberate departure from `canvas-v2-perf.spec.ts`'s "p95 hard" policy, and the spec header says so at length: the house percentile is `sorted[floor(q*len)]`, and `floor(0.95*n) === n-1` for all n ≤ 20, so at 5 reps per scenario a "p95" is identically the max — gating a load metric on the single worst of five samples is the most flake-prone choice available. That convention is correct in the frame-rate spec, where one run yields hundreds of frame samples; it does not transfer to one-sample-per-navigation load measurements. Small/warm gates against an absolute budget; larger scenarios against the committed baseline (+15% × 2× CI margin). `EW_CAPTURE=1` rewrites baselines.

### Results
**📊 [docs/performance/2026-07-19-v2-load-baseline.md](../blob/perf/v2-first-shape-harness/docs/performance/2026-07-19-v2-load-baseline.md)** — the measured numbers, the full scenario matrix with all sub-splits, the v1 parity ratio, and which of the candidate contributors the data actually implicates. Read this rather than digging the figures out of the CI log.

`e2e/baselines/canvas-v2-load.json` remains the machine-readable source of truth for the gate; the document above is its human-facing interpretation and records the SHA of the capture it describes. Future re-captures add a new dated document under `docs/performance/` rather than editing this one.

ux-contract: none — pure measurement harness under e2e/ plus a flag-gated server test hook; no tool FSM, renderer, or input surface is touched.
```

**Step 4: Push and open**

```bash
git push -u origin perf/v2-first-shape-harness
gh pr create --title "perf(e2e): canvas-v2 time-to-first-shape measurement harness" --body-file <(...)
```

---

## Results — where they live

**Not in this document.** Task 9 Step 5 writes `docs/performance/2026-07-19-v2-load-baseline.md`; see "The `docs/performance/` results convention" above for the naming rule, the required structure, its relationship to the machine-readable baseline JSON, and the rule that old results documents are never edited in place.

This plan records intent and goes stale on execution. The results are a longitudinal artifact and outlive it.
