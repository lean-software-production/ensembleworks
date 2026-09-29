// Run: bun scripts/put-shape-unchecked-audit.test.ts
//
// CI gate (review finding 5). LoroCanvasDoc.putShapeUnchecked bypasses the
// write boundary: it writes a shape validateShape rejects — precisely the
// state repair() is obliged to destroy. It exists ONLY so tests and
// hostile-state rigs can construct what a remote peer's bytes can deliver.
// Keeping it off the CanvasDoc interface is a signal, not a barrier:
// SyncServerPeer.doc / SyncClientPeer.doc / ShadowMirror.doc and reconcile()'s
// parameter are all typed as the CONCRETE LoroCanvasDoc, so anyone typing
// `peer.doc.` gets it in autocomplete. reconcile.ts is exactly where a
// developer chasing a non-converging shadow tick would reach for it — which
// would restore the data-loss path this branch closed. This gate is that
// barrier. Any allowance requires explicit review of the caller's test-only
// purpose and write boundary; a red gate alone is never justification.
//
// Named `.test.ts` (not a bare `.ts`) so scripts/run-tests.ts globs it via
// `scripts/*.test.ts` — same trick as exposure-audit.test.ts and
// ux-contract-presence.test.ts (see their headers). Structure mirrors
// ux-contract-presence.test.ts: a PURE decision function unit-tested with
// synthetic inputs, then a real-tree scan that reads files off disk.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Glob } from 'bun'

// The ONLY files allowed to name putShapeUnchecked, repo-relative with forward
// slashes — the EXACT form Glob.scan yields below. A path-form mismatch would
// silently make an allowed file look disallowed. Every entry is a test or the
// declaration itself. No suffix, directory or glob allowances.
const ALLOWED: readonly string[] = [
  'canvas-doc/src/loro-canvas-doc.ts',          // the declaration itself
  'canvas-doc/src/repair.test.ts',
  'canvas-doc/src/repair-cost.test.ts',
  'canvas-doc/src/write-validation.test.ts',
  'canvas-doc/src/serialization-seam.test.ts',
  'server/src/canvas-v2/reconcile.test.ts',
  'scripts/put-shape-unchecked-audit.test.ts',  // this gate
]

// Release N compatibility fixtures, inspected against the pre-Stage-1b main.
// Checked putShape cannot seed NEW artifact ids (even valid ones): N must only
// preserve imported N+1 history, never originate it. These exact test-only
// files may construct that history; their production counterparts may NOT.
// Budgets count EVERY token reference, including comments/bound method access,
// not just call syntax. Adding another use in an approved file requires review
// too. This is a presence/growth gate, not proof of a caller's semantics.
const STORED_HISTORY_FIXTURES: Readonly<Record<string, number>> = {
  // Validated artifact SceneShape seed only; imported by FSM tests, not index.ts.
  'canvas-editor/src/contracts/fsm-runner.ts': 1,
  // Future-writer bytes through sync/relay/repair/restart; no local N authoring.
  'canvas-sync/src/artifact-compat.test.ts': 1,
  // Stored artifact Cut/Copy/Duplicate fixtures and concurrent remote arrival.
  'canvas-ui/src/use-canvas-session.test.ts': 2,
  // Artifact scene seed only, ordinary scenes remain checked; Playwright runner.
  'e2e/lib/contracts.ts': 1,
  // Separately compiled compatibility rig: artifact history + unknown format-2
  // kind/stamp. Never imported by either Canvas plugin production entry point.
  'plugins/canvas/scripts/fixtures/future-writer.ts': 2,
  // N+1 history to exercise protocol refusal and persisted reload preservation.
  'plugins/canvas/tests/artifact-compat.test.ts': 2,
  // Stored history for Duplicate refusal and import/repair/sync/undo preservation;
  // the same suite separately asserts all checked origination routes refuse it.
  'plugins/canvas/tests/artifact-creation.test.ts': 2,
}

/** Pure: given the repo-relative paths that CONTAIN the token, return the ones
 * NOT on the allowlist (the violations), sorted. Operates only on paths the
 * caller already collected; the caller globs *.{ts,tsx} and skips docs/, so
 * this plan's own .md — which names the token dozens of times — never reaches
 * this function. */
export function disallowedUsages(hits: readonly string[]): string[] {
  const allow = new Set([...ALLOWED, ...Object.keys(STORED_HISTORY_FIXTURES)])
  return hits.filter((f) => !allow.has(f)).sort((a, b) => a.localeCompare(b))
}

/** Pure: reject growth beyond the reviewed reference budget in each new fixture.
 * Exact own-key lookup: inherited object keys are NOT fixture allowances. */
export function fixtureReferenceViolations(hits: readonly { path: string; references: number }[]): string[] {
  return hits.filter(({ path, references }) =>
    Object.hasOwn(STORED_HISTORY_FIXTURES, path) && references > STORED_HISTORY_FIXTURES[path],
  ).map(({ path }) => path).sort((a, b) => a.localeCompare(b))
}

// ---- Synthetic self-tests: the teeth that bite even when the real tree is
// all-green. A gate that has only ever seen a green tree is untested; these
// prove disallowedUsages actually distinguishes allowed from disallowed. ----
assert.deepEqual(disallowedUsages([]), [], 'empty hit list -> no violations')
assert.deepEqual(
  disallowedUsages(['canvas-doc/src/repair.test.ts', 'canvas-doc/src/loro-canvas-doc.ts']),
  [],
  'allowlisted paths only -> no violations',
)
assert.deepEqual(
  disallowedUsages(['server/src/canvas-v2/reconcile.ts']),
  ['server/src/canvas-v2/reconcile.ts'],
  'a non-allowlisted code file is a violation',
)
assert.deepEqual(
  disallowedUsages(['canvas-doc/src/repair.test.ts', 'server/src/canvas-v2/reconcile.ts', 'client/src/foo.ts']),
  ['client/src/foo.ts', 'server/src/canvas-v2/reconcile.ts'],
  'mixed input returns only the disallowed paths, sorted',
)
// Exact approved fixtures pass, but a test suffix/directory does not confer
// permission, nor does resemblance to an approved adapter or hostile-state rig.
// Keep expected uses independent of the policy table: removing an allowance
// or tightening it below the inspected baseline must fail these regressions.
const expectedFixtures = [
  { path: 'canvas-editor/src/contracts/fsm-runner.ts', references: 1 },
  { path: 'canvas-sync/src/artifact-compat.test.ts', references: 1 },
  { path: 'canvas-ui/src/use-canvas-session.test.ts', references: 2 },
  { path: 'e2e/lib/contracts.ts', references: 1 },
  { path: 'plugins/canvas/scripts/fixtures/future-writer.ts', references: 2 },
  { path: 'plugins/canvas/tests/artifact-compat.test.ts', references: 2 },
  { path: 'plugins/canvas/tests/artifact-creation.test.ts', references: 2 },
]
const fixturePaths = expectedFixtures.map(({ path }) => path)
assert.deepEqual(disallowedUsages(fixturePaths), [], 'reviewed stored-history fixtures are permitted')
const unauthorizedPaths = [
  'canvas-doc/src/new-hostile-state.test.ts',
  'canvas-editor/src/contracts/new-runner.ts',
  'canvas-editor/src/editor.ts',
  'canvas-sync/src/client-peer.ts',
  'canvas-sync/src/new-artifact-compat.test.ts',
  'canvas-ui/src/use-canvas-session.ts',
  'e2e/lib/new-contracts.ts',
  'plugins/canvas/scripts/fixtures/new-future-writer.ts',
  'plugins/canvas/canvas/future-writer.ts',
  'plugins/canvas/server.ts',
  'plugins/canvas/tests/new-artifact-creation.test.ts',
  './e2e/lib/contracts.ts',
  'constructor',
]
assert.deepEqual(
  disallowedUsages([...fixturePaths, ...unauthorizedPaths]),
  [...unauthorizedPaths].sort((a, b) => a.localeCompare(b)),
  'production, novel tests/rigs, path aliases and inherited keys remain unauthorized',
)
for (const { path, references } of expectedFixtures) {
  assert.deepEqual(fixtureReferenceViolations([{ path, references }]), [], `${path}: reviewed budget is permitted`)
  assert.deepEqual(fixtureReferenceViolations([{ path, references: references + 1 }]), [path], `${path}: a novel use still fails`)
}
console.log('ok: put-shape-unchecked-audit -- exact-path and bounded-fixture policy self-tests')

// ---- Real-tree scan. Globs CODE files only (*.{ts,tsx}); markdown — incl.
// this plan — is excluded structurally by the extension, and docs/,
// node_modules, dist are skipped belt-and-suspenders. ----
const repoRoot = new URL('../', import.meta.url)
const glob = new Glob('**/*.{ts,tsx}')
const hits: string[] = []
const fixtureReferences: { path: string; references: number }[] = []
let scanned = 0
for await (const f of glob.scan({ cwd: repoRoot.pathname, onlyFiles: true })) {
  if (f.includes('node_modules') || f.includes('/dist/') || f.startsWith('dist/') || f.startsWith('docs/')) continue
  scanned++
  const source = readFileSync(new URL(f, repoRoot), 'utf8')
  if (source.includes('putShapeUnchecked')) {
    hits.push(f)
    fixtureReferences.push({ path: f, references: source.split('putShapeUnchecked').length - 1 })
  }
}
// Positive controls: if the scan finds nothing or misses the declaration site,
// it is BROKEN (glob/cwd/token wrong), not genuinely green — fail loudly
// rather than pass vacuously.
assert.ok(scanned > 100, `sanity: scanned suspiciously few .ts/.tsx files (${scanned}) -- glob/cwd likely broken`)
assert.ok(
  hits.includes('canvas-doc/src/loro-canvas-doc.ts'),
  'positive control: the declaration site must appear in the scan, else it is not actually finding the token',
)

const violations = disallowedUsages(hits)
assert.deepEqual(
  violations,
  [],
  `putShapeUnchecked is referenced outside the allowlist: ${violations.join(', ')}. ` +
    `It bypasses the write boundary repair() enforces; it belongs only in tests and the ` +
    `declaration. Any new allowance needs explicit review of its test-only purpose and ` +
    `bounded policy -- never widen the gate merely to silence it.`,
)
const growth = fixtureReferenceViolations(fixtureReferences)
assert.deepEqual(
  growth,
  [],
  `putShapeUnchecked fixture reference budget exceeded: ${growth.join(', ')}. ` +
    `A new use in an approved test-only file still requires explicit policy review.`,
)
console.log(`ok: put-shape-unchecked-audit -- ${hits.length} referencing file(s), all allowlisted and within fixture budgets (scanned ${scanned})`)
