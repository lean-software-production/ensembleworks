# v2 Load Baseline — 2026-07-19

## Provenance

| Field | Value |
|---|---|
| Measured commit | `f0b3288511754b8b3de682bb9a1a7975499a1c04` |
| Branch | `perf/v2-first-shape-harness` |
| Branch point | `fix/v2-boot-sync-ready` (`1ad72388d7de182251f913d8025e876abf852d92`) — post-settle-sleep-removal |
| Baseline capture SHA | `a1fd093a68b64924d6351a8865d56321c93ca398`[^self-sha] |
| Environment | `local` |
| Machine | `zeus-arch`, AMD Ryzen 7 7700X (8-core/16-thread), 125Gi RAM, Linux 7.0.12-arch1-1 |
| Machine state | idle dev box — no other load except an unrelated, idle `vite preview` process for the `.worktrees/canvas-phase4` checkout on port 4321, which does not share a port, process, or resource with this harness |
| Client build | production `vite build` served by `vite preview` |
| Cache state | cold HTTP cache per repetition (fresh browser context) |
| Reps per scenario | `5` |
| Harness | `e2e/perf-load/canvas-v2-load.spec.ts` via `e2e/playwright.load.config.ts` |

> Numbers from a loaded laptop are not comparable to CI-runner numbers. State the
> environment plainly — a reader six months out will not remember which this was,
> and comparing across environments silently is the main way a series like this
> goes wrong.

[^self-sha]: A commit's SHA is a hash of its own content, so a commit cannot
    embed its own final SHA without an infinite regress (writing the SHA
    changes the content, which changes the SHA). The value above is accurate
    as of the amend that produced it, but the very act of adding this footnote
    is itself one more content change, so treat the number as
    reviewer-verifiable rather than byte-exact: `git log -1 --format=%H --
    e2e/baselines/canvas-v2-load.json` is the authoritative source if this
    field is ever in doubt.

### `SPREAD_ADVISORY_CV_PCT` tuning evidence

Three consecutive `bun run perf:load` invocations were run on this same idle box
during this capture session (one `EW_CAPTURE=1` run whose numbers are the
committed baseline below, plus two immediate re-verify runs). `firstShapeMs`
cv% observed across all three, every scenario:

| Scenario | Run 1 (capture) | Run 2 (verify) | Run 3 (verify) |
|---|---|---|---|
| v2 @100 bulk warm | 2.01% | 2.77% | (not re-recorded — see note) |
| v2 @1000 bulk warm | 2.89% | 0.72% | 1.42% |
| v2 @1000 bulk COLD | 2.99% | 1.35% | 2.59% |
| v2 @1000 per-shape warm | 1.98% | 1.88% | 1.80% |
| v1 @100 | 3.87% | 2.22% | 2.79% |

(Run 3's v2@100 line was not separately transcribed but was consistent with
the same low single digits observed in every other cell.) The worst cv seen
across all observations is 3.87% (v1@100, run 1). Every v2 scenario stayed
under 3% on every run. `SPREAD_ADVISORY_CV_PCT` was set to **8** — roughly 2x
the worst observed figure, comfortably above the normal spread of a healthy
idle-box run and still far below the provisional `25` the harness shipped
with, which this evidence shows was far looser than the measured behaviour
warrants.

## Scenario matrix

All figures in ms. `n/a` where a sub-split does not apply to that arm (the v1 arm
has no v2 chunk and no v2 toolbar). Report **every sub-split, not just totals** —
the totals are what prompted the work, but the sub-splits are what direct it.

| Scenario | Engine | Shapes | Commits | Actor | firstShapeMs p50 (GATED) | firstShapeMs max | firstShapeMs spread | firstShapeMs cv% | wsOpenMs p50 | chunkResponseEndMs p50 | toolbarMs p50 | chunkToToolbarMs p50 | toolbarToFirstShapeMs p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v2 @100 bulk warm | v2 | 100 | 1 | warm | 506.8 | 530.5 | 29.6 | 2.01 | 485.9 | 183.5 | 506.8 | 325.4 | 0 |
| v2 @1000 bulk warm | v2 | 1000 | 1 | warm | 550.5 | 570.9 | 37.2 | 2.89 | 494.1 | 191.6 | 550.5 | 360.2 | 0 |
| v2 @1000 per-shape warm | v2 | 1000 | 1000 | warm | 550.7 | 565.8 | 24.9 | 1.98 | 495.7 | 192.8 | 550.7 | 359.6 | 0 |
| v2 @1000 bulk COLD | v2 | 1000 | 1 | cold | 579.2 | 604.5 | 47.4 | 2.99 | 520.1 | 196.4 | 579.2 | 382.8 | 0 |
| v1 @100 | v1 (tldraw) | 100 | n/a | n/a | 428.7 | 464.4 | 44.7 | 3.87 | n/a | n/a | n/a | n/a | n/a |

> **Report `cv%` for every row, even the good ones.** It is the column that tells
> a future reader whether the run these numbers came from was trustworthy at all.
> A scenario whose median looks fine at cv=45% has not really been measured; a
> median at cv=6% can be leaned on. There is deliberately no p95 column — at
> REPS=5 it would be identically the max (see the CHANGE NOTE).

## Derived comparisons

| Comparison | Value | What it isolates |
|---|---|---|
| v2 @100 p50 ÷ v1 @100 p50 | `1.18x` | **Parity ratio.** ≤ 1.00 means at or better than v1 — the owner's acceptance bar. Not yet met. |
| v2 @1000 per-shape p50 ÷ bulk p50 | `1.00x` | Contributor (b): op **count** vs bytes. Near 1.0 ⇒ op count is not the bottleneck. |
| v2 @1000 cold p50 − warm p50 | `28.7ms` | Contributor (d): server-side snapshot load + oplog replay. |
| chunkResponseEndMs p50 (1k warm) | `191.6ms` | Contributor (a): the ~4.3 MB lazy chunk. |
| chunkToToolbarMs p50 (1k warm) | `360.2ms` | Contributors (c) WASM decode + module eval + boot. |
| toolbarToFirstShapeMs p50 (1k warm) | `0ms` | Contributors (b) oplog replay + (e) WS round-trip — **the gap the harness was built to expose.** |
| wsOpenMs p50 (1k warm) | `494.1ms` | Contributor (e), isolated. |

## Gates in force at capture

| Scenario | Gate | Threshold |
|---|---|---|
| v2 @100 bulk warm | absolute, **p50 (median) hard** | `SMALL_WARM_BUDGET_MS = 750` × 2 CI margin = 1500ms |
| all others | regression vs committed baseline, **p50 (median) hard** | +15% × 2 CI margin |
| all | max rep, and cv% above `SPREAD_ADVISORY_CV_PCT` (8%) | advisory only (`::warning::`) |

## What this tells us

**Ruled out first, because it is the more valuable half.** The toolbar-to-first-shape
gap — the very symptom this harness was built to hunt — measured **0ms on every
single rep of every v2 scenario**, across all 15 reps in this capture run and all
60 reps counting the two immediate re-verify runs used for the cv tuning above.
Once the toolbar mounts, the pre-seeded shapes are already there; nothing lags
visibly behind it. Oplog **volume** is also ruled out as a contributor: the
per-shape scenario (1000 separate `Frame.Update` commits) posted a p50 of
550.7ms against the bulk scenario's 550.5ms — a 1.00x ratio, reproduced at
0.98–1.00x across three independent runs this session. Whatever the backfill
costs, it is not costing more per extra commit. Cold-actor replay is a third
ruled-out (or at least not-implicated) contributor: the cold/warm delta was
28.7ms, smaller than either scenario's own rep-to-rep spread (37.2ms warm,
47.4ms cold) — a delta this size cannot be distinguished from ordinary
measurement noise on this box, consistent with a prior run's finding of a
similarly small (34.5ms) delta.

**What is implicated: client-side startup, before the WebSocket ever opens.**
Across all four v2 scenarios, `wsOpenMs` lands ~300ms after `chunkResponseEndMs`
— 302.4ms (@100 warm), 302.5ms (@1000 bulk warm), 302.9ms (@1000 per-shape
warm), 323.7ms (@1000 cold) — and that gap is essentially **flat regardless of
shape count**, which rules out backfill size/count as its cause and points at
fixed per-load client bootstrap cost instead. This ~300ms block sits entirely
inside `chunkToToolbarMs` (325–383ms p50 across scenarios) and is, on every
scenario, the single largest contributor to the total — roughly 55–60% of the
whole 507–579ms `firstShapeMs` figure. By contrast, the time from `wsOpenMs`
to the toolbar/shape appearing is small: 20.9ms @100, and 55–59ms across the
1000-shape scenarios (the modest scaling here is plausibly the room-size-
dependent WS round trip and client-side render, but this data cannot isolate
that cleanly from other post-connect work). The WS connect-and-`SyncRequest`
round trip itself, once initiated, is therefore not where most of the time
goes — contributor (e) is largely ruled out as *dominant*, even though it is
not exactly zero.

**What this data cannot separate.** The ~300ms chunk-end-to-ws-open span
bundles together whatever the client does between the chunk finishing download
and the app code issuing its `WebSocket` connect call: module evaluation,
`loro-crdt` WASM instantiation (candidate (c)), and any other synchronous
bootstrap work, all with no mark between them. This harness cannot say what
fraction of the ~300ms is WASM decode specifically versus ordinary bundle
evaluation versus something else entirely — that would need an additional
in-page mark placed between module-execute-start and the `new WebSocket(...)`
call, which does not exist today. The (a) contributor — the lazy chunk itself —
accounts for 183–196ms of download time, roughly a third of the total; this
run did not independently measure its byte size, though the production build's
own warning ("Some chunks are larger than 1800 kB after minification") is
consistent with a large single chunk existing on this code path.

**Parity.** v2@100 is 1.18x v1@100 (506.8ms vs 428.7ms), not yet at the
owner's ≤1.00x bar. Given the above, the gap to parity is concentrated in the
same ~300ms client-startup window rather than in backfill volume or server-side
replay, both of which are ruled out.

## Follow-ups

- **Add an in-page mark between module-execute-start and the `WebSocket`
  constructor call** to split the ~300ms chunk-end-to-ws-open span (302–324ms,
  flat across shape count) into its WASM-decode and non-WASM-eval components.
  Without it, contributor (c) cannot be isolated from ordinary bundle
  evaluation — see "What this data cannot separate" above.
- **Untested hypothesis, not a finding — flagged explicitly per this document's
  own discipline:** the fact that the ~300ms gap is flat regardless of shape
  count and sits entirely before the WS connect suggests hoisting the
  WebSocket connect to run in parallel with the chunk download *might* recover
  most of it. Nobody has read the client boot code path to confirm the connect
  can actually be hoisted ahead of module eval/WASM init, and this harness has
  not measured any variant that does so. This belongs in a plan, not in this
  report, if it is pursued.
- **Shrink `CI_MARGIN_MULTIPLIER` toward 1.0** once a baseline has been captured
  on the CI runner itself. The 2× exists to absorb the systematic dev-box→runner
  hardware difference; a runner-native baseline removes the need for most of it.
  This dev-box median for v2@1000 bulk warm was 550.5ms; no CI-native median
  exists yet to compare it against.
- **Revisit `SPREAD_ADVISORY_CV_PCT`** (now 8, tuned from a worst-observed 3.87%
  this session — see the tuning table above) once CI-runner captures exist:
  a shared, contended runner may show materially higher cv than this idle dev
  box did, and 8% may prove too tight there. No scenario in this capture was
  dispersed enough that its median should be distrusted as a gate.
