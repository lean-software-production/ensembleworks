#!/usr/bin/env bun
// server/src/canvas-v2/soak-actor-cli.ts — Task H4's nightly entrypoint for
// the DocumentActor-backed compacting soak. Mirrors canvas-sync/soak-cli.ts's
// own shape closely (same arg parsing, same flat-RSS quartile-mean
// heuristic, same "print + write a summary JSON, exit nonzero on failure"
// contract) so the two nightly jobs read the same way in CI output — the
// actor variant's OWN numbers (disk growth, `actorCompactEvery`) are added
// alongside, not instead of, the shared shape.
//
// Usage:
//   bun server/src/canvas-v2/soak-actor-cli.ts --clients 5 --ops 15000 --seed 12345 --chaos 0.5
//
// Writes ./canvas-soak-actor-summary.json (relative to CWD — the nightly
// workflow runs from the repo root) and exits nonzero on any failure:
// runActorSoak throwing (convergence failed, OR its own bounded-snapshot-
// growth tripwire, OR its own bounded-DISK-growth tripwire fired) or this
// file's OWN flat-RSS check failing.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { lastQuartileDiskToSnapshotRatio, runActorSoak } from './soak-actor.ts'

interface Args {
	clients: number
	ops: number
	seed: number
	chaos: number
}

function parseArgs(argv: string[]): Args {
	const get = (name: string, fallback: number): number => {
		const i = argv.indexOf(`--${name}`)
		if (i === -1 || i + 1 >= argv.length) return fallback
		const v = Number(argv[i + 1])
		if (!Number.isFinite(v)) throw new Error(`--${name} must be a finite number, got ${JSON.stringify(argv[i + 1])}`)
		return v
	}
	return {
		clients: get('clients', 5),
		// DEFAULT SCALE (validated, not guessed — see soak-actor.ts's own
		// CALIBRATION section and the Task H3 execution notes in the Phase-4
		// plan's Execution notes): H4 first validated 5 clients / 15,000 ops
		// locally; Task H3 then ran THREE runs at ≥20k ops (5/20,000/seed 42,
		// 5/20,000/seed 1, 5/25,000/seed 7, all chaos 0.5) — ~26-38s wall time
		// each, all converged (including the H1/H2 per-shape text-convergence
		// check), disk÷snapshot ratios 2.90x-6.52x (well inside the calibrated
		// 12x bound; see soak-actor.ts's CALIBRATION). 20,000 is now the
		// validated default here, still smaller than canvas-sync's own
		// bare-peer nightly default (200,000, itself calibrated down to 20,000
		// in the nightly workflow) — this variant ALSO does real SQLite I/O
		// (appendUpdate per persisted update, periodic compaction) on top of
		// the same op-routing/chaos work.
		ops: get('ops', 20_000),
		seed: get('seed', 1),
		chaos: get('chaos', 0.5),
	}
}

/**
 * Flat-RSS heuristic — same quartile-mean-ratio shape as canvas-sync/
 * soak-cli.ts's assertFlatRss (see that file for the full derivation of WHY
 * quartiles, not first-vs-last sample).
 *
 * TOLERANCE CALIBRATION — Task H4 (measured directly, throwaway calibration
 * harness against runActorSoak, seed 7, `--clients 5 --ops 15000 --chaos
 * 0.5`): quartile-mean ratio ~2.11x (firstMean ~233MB, lastMean ~491MB).
 *
 * TASK H3 RE-CALIBRATION (≥20k ops, the scale that measurement above was
 * honestly flagged as NOT covering — three runs via THIS cli, foreground,
 * each printing its own `rss:` line):
 *
 *   clients ops    seed  chaos  firstMean     lastMean      ratio
 *   5       20,000 42    0.5    ~256MB        ~595MB        2.320x
 *   5       20,000 1     0.5    ~256MB        ~577MB        2.256x
 *   5       25,000 7     0.5    ~245MB        ~697MB        2.850x
 *
 * The ratio does NOT blow up past 15,000 ops — it stays in the same ~2-3x
 * band the smaller H4 run already showed (2.11x), i.e. no new superlinear
 * tail appeared by 25,000 ops for this compacting variant (unlike
 * canvas-sync's own bare-peer soak, whose no-compaction docs DO show a
 * clearly superlinear climb to ~9.97x by 20,000 ops — see soak-cli.ts's own
 * TOLERANCE CALIBRATION). That's the expected shape: SQLite compaction here
 * periodically folds the append-log, bounding retained in-process state in
 * a way the bare peer's never-compacted oplog cannot.
 *
 * FLAT_RSS_TOLERANCE is tightened from the old placeholder 15x down to 8x —
 * ~2.8x over the worst ≥20k-ops ratio measured (2.85x), with generous
 * nightly-CI-noise headroom on top. This is a NIGHTLY-only job (it never
 * gates a PR — the per-commit smoke, soak-actor.test.ts, does that), so a
 * spurious 5am failure is pure toil, while CI runners have noisier/tighter
 * memory than a dev box; a REAL memory-leak regression (compaction silently
 * stops firing, etc.) blows FAR past either 6x or 8x, so the extra margin
 * costs ~nothing in detection power while removing a real source of
 * false-alarm toil. Not set any looser than that: the whole point of running
 * ≥20k was to stop guessing at a generous placeholder and tie this number to
 * actual observed behavior. Revisit if a future run at meaningfully larger
 * scale (or a different `actorCompactEvery`) shows a materially different
 * ratio.
 */
const FLAT_RSS_TOLERANCE = 8

function assertFlatRss(samples: readonly number[]): void {
	if (samples.length < 8) {
		console.log(`rss: only ${samples.length} sample(s) — too few to judge a trend, skipping the flat-RSS check`)
		return
	}
	const quarter = Math.max(1, Math.floor(samples.length / 4))
	const firstQuartile = samples.slice(0, quarter)
	const lastQuartile = samples.slice(samples.length - quarter)
	const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
	const firstMean = mean(firstQuartile)
	const lastMean = mean(lastQuartile)
	const ratio = lastMean / Math.max(1, firstMean)
	console.log(
		`rss: first-quartile mean=${Math.round(firstMean)} bytes, last-quartile mean=${Math.round(lastMean)} bytes, ratio=${ratio.toFixed(3)}`,
	)
	if (ratio >= FLAT_RSS_TOLERANCE) {
		throw new Error(
			`flat-RSS check failed: last-quartile mean RSS (${Math.round(lastMean)}) is ${ratio.toFixed(2)}x the first-quartile mean (${Math.round(firstMean)}) — >= ${FLAT_RSS_TOLERANCE}x tolerance`,
		)
	}
}

function main(): void {
	const args = parseArgs(process.argv.slice(2))
	console.log(`canvas-v2 actor soak: clients=${args.clients} ops=${args.ops} seed=${args.seed} chaos=${args.chaos}`)
	console.log(`canvas-v2 actor soak: SEED=${args.seed} — replay this exact run with --seed ${args.seed}`)

	// The actor's SQLite file lives in a fresh temp dir this process owns end
	// to end — mirrors e2e/scripts/start-server.ts's "mkdtemp, clean up on the
	// way out" posture (see that file's own header for why: nothing durable
	// here needs to survive past this one nightly run).
	const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-actor-soak-'))
	const startedAt = Date.now()
	let result: ReturnType<typeof runActorSoak>
	try {
		result = runActorSoak({
			clients: args.clients,
			ops: args.ops,
			seed: args.seed,
			chaos: args.chaos,
			dir,
			sampleRss: () => process.memoryUsage().rss,
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
	const wallMs = Date.now() - startedAt

	assertFlatRss(result.rssSamples ?? [])

	if (!result.converged) {
		throw new Error('actor soak did not converge (see the printed summary for shape counts / invariant state)')
	}

	const summary = {
		...args,
		wallMs,
		converged: result.converged,
		finalShapeCount: result.finalShapeCount,
		finalSnapshotBytes: result.finalSnapshotBytes,
		finalDiskBytes: result.finalDiskBytes,
		diskToSnapshotRatio: result.finalDiskBytes / Math.max(1, result.finalSnapshotBytes),
		// S6 sustained high-water metric (last-quartile MEAN, not the
		// single final-point ratio above) — already asserted inside
		// runActorSoak (assertDiskHighWater); recorded here too so the S6
		// decision evidence (Task I1) is readable straight off this JSON
		// summary without re-deriving it from diskSamples/snapshotSamples.
		diskSustainedHighwaterRatio: lastQuartileDiskToSnapshotRatio(result.diskSamples, result.snapshotSamples) ?? null,
		maxUpdateBytes: result.maxUpdateBytes,
		repairFirings: result.repairFirings,
		reconnectsForced: result.reconnectsForced,
		malformedFrames: result.malformedFrames,
		pendingImports: result.pendingImports,
		snapshotSampleCount: result.snapshotSamples.length,
		diskSampleCount: result.diskSamples.length,
		rssSampleCount: result.rssSamples?.length ?? 0,
	}
	console.log('canvas-v2 actor soak: SUMMARY', JSON.stringify(summary))
	writeFileSync('canvas-soak-actor-summary.json', JSON.stringify(summary, null, 2))
}

try {
	main()
	process.exit(0)
} catch (err) {
	console.error('canvas-v2 actor soak: FAILED —', err instanceof Error ? err.message : String(err))
	process.exit(1)
}
