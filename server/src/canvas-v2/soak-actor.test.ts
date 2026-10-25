// Run: bun src/canvas-v2/soak-actor.test.ts
//
// Task H4's per-commit smoke: a tiny, fast slice of the actor-backed
// compacting soak (see soak-actor.ts for the full design + CALIBRATION
// numbers; the nightly workflow, .github/workflows/canvas-soak.yml, is what
// exercises the real scale — 5 clients × 15,000 ops, validated locally
// before being wired in, per the H4 execution report). Mirrors canvas-sync's
// own soak-smoke.test.ts scale (clients:3, ops:500, chaos:0.3) so the two
// smokes are directly comparable — same op count, different server (a real
// DocumentActor here, a bare SyncServerPeer there).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AVG_MIN_DISK_BYTES, DISK_GROWTH_MULTIPLIER, runActorSoak } from './soak-actor.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-soak-actor-smoke-'))
const started = performance.now()
let result: ReturnType<typeof runActorSoak>
try {
	result = runActorSoak({ dir, clients: 3, ops: 500, seed: 1, chaos: 0.3 })
} finally {
	rmSync(dir, { recursive: true, force: true })
}
const elapsedMs = performance.now() - started

assert.equal(result.converged, true, 'the actor-backed soak must converge after quiescing (invariant-clean on every peer, actor included)')
assert.ok(result.finalShapeCount > 0, 'the soak actually produced some live shapes')
assert.equal(result.malformedFrames, 0, "nothing here manufactures garbage bytes — a fuzz corpus is canvas-sync's E2 job")

// Bounded-DISK-growth: redundant with runActorSoak's own internal tripwire
// (it would already have thrown if this failed) — asserted again here so a
// failure reads as an explicit, named assertion in this file's own output,
// not just "runActorSoak threw."
const bound = DISK_GROWTH_MULTIPLIER * Math.max(AVG_MIN_DISK_BYTES, result.finalSnapshotBytes)
assert.ok(
	result.finalDiskBytes < bound,
	`actor sqlite file (${result.finalDiskBytes}B) should stay under the calibrated bound (${bound}B) — see soak-actor.ts's CALIBRATION`,
)

// The disk axis is genuinely DIFFERENT from the in-memory snapshot axis —
// pin that they're not simply equal (the whole point of measuring both;
// see soak-actor.ts's module header TWO GROWTH AXES section). At this tiny
// smoke scale the disk file is very likely just SQLite's own minimum
// allocation (a single ~4KB page) regardless of the tiny snapshot — assert
// the two numbers were tracked independently (both present, both finite),
// not that one is any specific multiple of the other (that varies with
// scale — see the CALIBRATION table's own bouncing ratio).
assert.ok(Number.isFinite(result.finalDiskBytes) && result.finalDiskBytes > 0, 'finalDiskBytes was measured')
assert.ok(Number.isFinite(result.finalSnapshotBytes) && result.finalSnapshotBytes > 0, 'finalSnapshotBytes was measured')
assert.ok(result.diskSamples.length > 0, 'disk-size samples were collected at the same cadence as snapshotSamples')

assert.ok(elapsedMs < 5_000, `smoke must stay fast for per-commit use (took ${elapsedMs.toFixed(1)}ms)`)

console.log(
	`ok: soak-actor-smoke — converged=${result.converged}, shapes=${result.finalShapeCount}, ` +
		`snapshotBytes=${result.finalSnapshotBytes}, diskBytes=${result.finalDiskBytes}, ` +
		`reconnects=${result.reconnectsForced}, repairFirings=${result.repairFirings}, ` +
		`pendingImports=${result.pendingImports} (${elapsedMs.toFixed(1)}ms)`,
)
