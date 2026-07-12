// Run: bun src/soak-smoke.test.ts
//
// E4's per-commit smoke: a tiny, fast slice of the nightly soak (see soak.ts
// for the full design + the nightly's real parameters). Runs under `bun run
// test` on every commit, so it must complete in well under a second — the
// nightly workflow (.github/workflows/canvas-soak.yml) is what exercises the
// real scale (10 clients × 200k ops).
import assert from 'node:assert/strict'
import { AVG_SHAPE_SIZE_BYTES, BOUNDED_GROWTH_K, runSoak } from './soak.js'

const started = performance.now()
const result = runSoak({ clients: 3, ops: 500, seed: 1, chaos: 0.3 })
const elapsedMs = performance.now() - started

// `converged` already means "every client's normalized dumpModel equals the
// server's AND checkInvariants is clean everywhere" (see SoakResult's doc
// comment in soak.ts) — that IS the invariants-clean assertion the task
// calls for; there's no separate raw doc exposed here to re-check directly.
assert.equal(result.converged, true, 'the soak must converge after quiescing (invariant-clean on every peer)')
assert.ok(result.finalShapeCount > 0, 'the soak actually produced some live shapes')
assert.ok(
	result.finalSnapshotBytes < BOUNDED_GROWTH_K * result.finalShapeCount * AVG_SHAPE_SIZE_BYTES,
	"bounded-growth check (redundant with runSoak's own internal tripwire — runSoak would already have thrown if this failed)",
)
assert.equal(result.malformedFrames, 0, 'nothing here manufactures garbage bytes — a fuzz corpus is E2\'s job')
assert.ok(elapsedMs < 5_000, `smoke must stay fast for per-commit use (took ${elapsedMs.toFixed(1)}ms)`)

console.log(
	`ok: soak-smoke — converged=${result.converged}, shapes=${result.finalShapeCount}, ` +
		`snapshotBytes=${result.finalSnapshotBytes}, reconnects=${result.reconnectsForced}, ` +
		`repairFirings=${result.repairFirings}, pendingImports=${result.pendingImports} (${elapsedMs.toFixed(1)}ms)`,
)
