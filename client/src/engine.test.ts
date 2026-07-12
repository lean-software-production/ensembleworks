/**
 * Run: bun src/engine.test.ts
 *
 * House-style coverage lifted straight from the phase-3 plan's own Task G6
 * exposure-audit sketch (docs/plans/2026-07-12-canvas-phase3-editor-renderer.md)
 * — this file is the "engine.test.ts" half; scripts/exposure-audit.ts (Task
 * G6, not this unit) is the repo-level script that imports selectEngine and
 * re-runs the same assertions as a standalone gate.
 */
import assert from 'node:assert/strict'
import { TEAM_ROOM_ID, parseAllowlist, selectEngine } from './engine'

// 1. team + arbitrary non-allowlisted rooms resolve to tldraw with NO env/URL.
for (const r of ['team', 'random', 'planning', 'x'.repeat(64)]) {
	assert.equal(selectEngine(r, { allowlist: [], engineParam: null }), 'tldraw', `${r} defaults to tldraw with no allowlist/param`)
}

// 2. Only an explicit allowlist or ?engine=v2 flips a room to v2.
assert.equal(selectEngine('dogfood', { allowlist: ['dogfood'], engineParam: null }), 'v2', 'allowlisted room -> v2')
assert.equal(selectEngine('team', { allowlist: ['dogfood'], engineParam: null }), 'tldraw', 'unlisted room stays tldraw even with an allowlist present')
assert.equal(selectEngine('anything', { allowlist: [], engineParam: 'v2' }), 'v2', '?engine=v2 flips an unlisted room to v2')
assert.equal(selectEngine('anything', { allowlist: [], engineParam: 'tldraw' }), 'tldraw', 'a non-"v2" engineParam value has no effect')
assert.equal(selectEngine('anything', { allowlist: [], engineParam: '' }), 'tldraw', 'an empty engineParam has no effect')

// 2b. RATIFIED Q1 AMENDMENT: `team` is HARD-EXCLUDED — even a misconfigured
// allowlist AND an explicit ?engine=v2 override, TOGETHER, never flip it.
// This is the exact assertion the plan's ratification names.
assert.equal(selectEngine('team', { allowlist: ['team'], engineParam: 'v2' }), 'tldraw', 'team is hard-excluded regardless of allowlist/param')
assert.equal(selectEngine(TEAM_ROOM_ID, { allowlist: [TEAM_ROOM_ID], engineParam: 'v2' }), 'tldraw', 'same case, via the exported TEAM_ROOM_ID constant')

// parseAllowlist: comma-split, trimmed, empty-segment-tolerant.
assert.deepEqual(parseAllowlist(undefined), [], 'unset env var -> empty allowlist')
assert.deepEqual(parseAllowlist(''), [], 'empty env var -> empty allowlist')
assert.deepEqual(parseAllowlist('dogfood'), ['dogfood'], 'single room, no commas')
assert.deepEqual(parseAllowlist('dogfood,design-review'), ['dogfood', 'design-review'], 'comma-separated list')
assert.deepEqual(parseAllowlist(' dogfood , design-review '), ['dogfood', 'design-review'], 'whitespace around entries is trimmed')
assert.deepEqual(parseAllowlist('a,,b,'), ['a', 'b'], 'empty segments from stray/trailing commas are dropped')

// End-to-end via parseAllowlist's output feeding straight into selectEngine —
// the exact composition selectEngineFromEnvironment performs (minus the
// import.meta.env/URL reads, which need a real module-eval/DOM environment
// and are exercised instead by the CanvasV2App integration test's mount path
// and by manual/e2e smoke per the G1 task's build-still-works check).
assert.equal(selectEngine('dogfood', { allowlist: parseAllowlist('dogfood,design-review'), engineParam: null }), 'v2')
assert.equal(selectEngine(TEAM_ROOM_ID, { allowlist: parseAllowlist('team,dogfood'), engineParam: 'v2' }), 'tldraw', 'hard exclusion survives even when the parsed env allowlist itself lists team')

console.log('ok: engine — selectEngine (team hard-excluded) + parseAllowlist')
