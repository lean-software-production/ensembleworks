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
import { runActorSoak } from './soak-actor.ts'

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
		// CALIBRATION section and the H4 execution report): 5 clients / 15,000
		// ops / chaos 0.5 measured ~17s wall time locally, converged, disk-
		// growth ratio 2.96x (well inside the calibrated 12x bound). Kept
		// smaller than canvas-sync's own bare-peer nightly (5/20,000/0.5) —
		// this variant ALSO does real SQLite I/O (appendUpdate per persisted
		// update, periodic compaction), so it was validated at its own scale
		// rather than assumed to inherit the bare-peer number.
		ops: get('ops', 15_000),
		seed: get('seed', 1),
		chaos: get('chaos', 0.5),
	}
}

/**
 * Flat-RSS heuristic — same quartile-mean-ratio shape as canvas-sync/
 * soak-cli.ts's assertFlatRss (see that file for the full derivation of WHY
 * quartiles, not first-vs-last sample).
 *
 * TOLERANCE CALIBRATION (measured directly, throwaway calibration harness
 * against runActorSoak, seed 7, `--clients 5 --ops 15000 --chaos 0.5` — the
 * exact default scale above): quartile-mean ratio ~2.11x (firstMean
 * ~233MB, lastMean ~491MB). Notably LOWER than canvas-sync's own bare-peer
 * measurement at a slightly larger scale (~9.97x at 5/20,000/0.5) — plausible
 * (this run is smaller, and the bare-peer number's own doc comment already
 * describes a compounding/superlinear trend whose tail this smaller run may
 * not reach yet), but NOT independently re-verified at 20,000+ ops for the
 * actor variant — that honesty gap is exactly why this tolerance is set with
 * generous headroom (≈7x over the measured 2.11x) rather than tight to it.
 * Revisit if this job ever moves to a larger validated scale.
 */
const FLAT_RSS_TOLERANCE = 15

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
