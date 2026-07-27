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
// barrier. Adding an entry to ALLOWED is a deliberate, reviewable act; it must
// never be done to turn a red gate green.
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
// declaration itself. Verified against `git grep -l putShapeUnchecked`,
// 2026-07-21.
const ALLOWED: readonly string[] = [
  'canvas-doc/src/loro-canvas-doc.ts',          // the declaration itself
  'canvas-doc/src/repair.test.ts',
  'canvas-doc/src/repair-cost.test.ts',
  'canvas-doc/src/write-validation.test.ts',
  'canvas-doc/src/serialization-seam.test.ts',
  'server/src/canvas-v2/reconcile.test.ts',
  'scripts/put-shape-unchecked-audit.test.ts',  // this gate
]

/** Pure: given the repo-relative paths that CONTAIN the token, return the ones
 * NOT on the allowlist (the violations), sorted. Operates only on paths the
 * caller already collected; the caller globs *.{ts,tsx} and skips docs/, so
 * this plan's own .md — which names the token dozens of times — never reaches
 * this function. */
export function disallowedUsages(hits: readonly string[]): string[] {
  const allow = new Set(ALLOWED)
  return hits.filter((f) => !allow.has(f)).sort((a, b) => a.localeCompare(b))
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
console.log('ok: put-shape-unchecked-audit -- disallowedUsages self-tests')

// ---- Real-tree scan. Globs CODE files only (*.{ts,tsx}); markdown — incl.
// this plan — is excluded structurally by the extension, and docs/,
// node_modules, dist are skipped belt-and-suspenders. ----
const repoRoot = new URL('../', import.meta.url)
const glob = new Glob('**/*.{ts,tsx}')
const hits: string[] = []
let scanned = 0
for await (const f of glob.scan({ cwd: repoRoot.pathname, onlyFiles: true })) {
  if (f.includes('node_modules') || f.includes('/dist/') || f.startsWith('dist/') || f.startsWith('docs/')) continue
  scanned++
  if (readFileSync(new URL(f, repoRoot), 'utf8').includes('putShapeUnchecked')) hits.push(f)
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
    `declaration. If a new use is genuinely legitimate, add it to ALLOWED as a deliberate, ` +
    `reviewed act -- never to silence this gate.`,
)
console.log(`ok: put-shape-unchecked-audit -- ${hits.length} referencing file(s), all allowlisted (scanned ${scanned})`)
