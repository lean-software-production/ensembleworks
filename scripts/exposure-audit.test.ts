// Run: bun scripts/exposure-audit.test.ts
//
// Task G6 (phase-3 plan, docs/plans/2026-07-12-canvas-phase3-editor-renderer.md)
// — the repo-level gate that FAILS if the default room path can reach the new
// canvas-v2 engine. Named `.test.ts` (not the plan's literal `.ts` sketch
// name) so it runs under `bun run test` via scripts/run-tests.ts's own
// `scripts/*.test.ts` glob (added alongside this file — a standalone `.ts`
// script living outside every package's `src/` tree matched NEITHER of
// run-tests.ts's globs before that addition).
//
// THREE independent checks, each able to fail the whole gate on its own:
//   1. selectEngine assertions (mirrors client/src/engine.test.ts's own
//      coverage, INCLUDING the ratified Q1 amendment pin) — kept here too,
//      redundantly, as a standalone safety net: even if engine.test.ts were
//      ever accidentally skipped/misconfigured, this repo-level script still
//      catches a regression.
//   2. main.tsx/App.tsx source scan: `CanvasV2App` must never appear in
//      either file WITHOUT `selectEngine` also appearing — i.e. the v2 mount
//      is reachable ONLY through the selectEngine guard.
//   3. NEW (not in the plan's original sketch, added per the controller's
//      amendment): no file OUTSIDE `client/src/canvas-v2/` may STATICALLY
//      `import ... from` a canvas-v2 module — the whole v2 module graph
//      (CanvasV2App -> canvas-editor/canvas-react -> canvas-doc/canvas-sync
//      -> loro-crdt's WASM) must be reachable ONLY through main.tsx's
//      `React.lazy(() => import(...))` DYNAMIC import (a network request
//      issued only when the lazy component is actually rendered — see
//      main.tsx's own module header). A STATIC import anywhere else would
//      pull that whole graph into the SAME chunk as the code doing the
//      importing, defeating the lazy boundary regardless of the
//      selectEngine guard at the render call site.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Glob } from 'bun'
import { selectEngine, TEAM_ROOM_ID } from '../client/src/engine.ts'

// ============================================================================
// 1. selectEngine assertions (redundant with engine.test.ts by design — see
//    the module header).
// ============================================================================
for (const r of ['team', 'random', 'planning', 'x'.repeat(64)]) {
  assert.equal(selectEngine(r, { allowlist: [], engineParam: null }), 'tldraw', `${r} defaults to tldraw with no allowlist/param`)
}
assert.equal(selectEngine('dogfood', { allowlist: ['dogfood'], engineParam: null }), 'v2', 'allowlisted room -> v2')
assert.equal(selectEngine('team', { allowlist: ['dogfood'], engineParam: null }), 'tldraw', 'unlisted room stays tldraw even with an allowlist present')
assert.equal(selectEngine('anything', { allowlist: [], engineParam: 'v2' }), 'v2', '?engine=v2 flips an unlisted room to v2')
// THE AMENDMENT PIN: `team` is HARD-EXCLUDED even by a misconfigured
// allowlist AND an explicit ?engine=v2 override, together.
assert.equal(selectEngine('team', { allowlist: ['team'], engineParam: 'v2' }), 'tldraw', 'team is hard-excluded regardless of allowlist/param')
assert.equal(selectEngine(TEAM_ROOM_ID, { allowlist: [TEAM_ROOM_ID], engineParam: 'v2' }), 'tldraw', 'same case, via the exported TEAM_ROOM_ID constant')
console.log('ok: exposure-audit -- selectEngine (team hard-excluded)')

// ============================================================================
// 2. main.tsx/App.tsx source scan: CanvasV2App reachable ONLY through the
//    selectEngine guard. Requires an actual CALL (`selectEngine...(`), not
//    bare string co-occurrence (quality-review teeth fix): a file that
//    merely imported/mentioned selectEngine — a comment, an unused import
//    surviving a refactor — would satisfy a bare `/selectEngine/` while
//    guarding nothing; a call site is a stronger (though still textual)
//    signal that the branch actually consults the selector.
// ============================================================================
const clientSrc = new URL('../client/src/', import.meta.url)
const mainTsx = readFileSync(new URL('main.tsx', clientSrc), 'utf8')
const appTsx = readFileSync(new URL('App.tsx', clientSrc), 'utf8')
const appEntry = mainTsx + appTsx
// Matches selectEngine( AND selectEngineFromEnvironment( — either is a real
// call into engine.ts's guard surface (the wrapper delegates to the pure
// function unconditionally).
const SELECT_ENGINE_CALL = /selectEngine\w*\s*\(/
assert.ok(
  !/CanvasV2App/.test(appEntry) || SELECT_ENGINE_CALL.test(appEntry),
  'CanvasV2App is referenced in main.tsx/App.tsx without a selectEngine(...) CALL anywhere in those files',
)
// Positive controls: both patterns really are present (a version of this
// audit that silently stopped matching either --e.g. after a rename--
// would otherwise pass VACUOUSLY, proving nothing).
assert.ok(/CanvasV2App/.test(appEntry), 'precondition: CanvasV2App is actually referenced in main.tsx/App.tsx (else check #2 is vacuous)')
assert.ok(SELECT_ENGINE_CALL.test(appEntry), 'precondition: a selectEngine(...) call actually appears in main.tsx/App.tsx (else check #2 is vacuous)')
console.log('ok: exposure-audit -- CanvasV2App reachable only through a selectEngine(...) call')

// ============================================================================
// 3. No STATIC import of a canvas-v2 module anywhere outside
//    client/src/canvas-v2/ itself (the lazy boundary). THIS is the
//    load-bearing bundling guard of the three checks: checks 1-2 police the
//    RENDER decision (which component the entry branch mounts), but only
//    this one polices what Vite BUNDLES — a single static import anywhere in
//    the client graph would pull the entire v2 module tree (canvas-editor/
//    canvas-react/canvas-doc/canvas-sync/loro WASM) into the default
//    chunk regardless of how correct the selectEngine branch is.
// ============================================================================
// A static ES import ALWAYS contains a `from '...'`/`from "..."` clause
// (`import X from 'Y'`, `import {X} from 'Y'`, `import type {X} from 'Y'`,
// `export {X} from 'Y'`) OR is a bare side-effect `import '...'` with none —
// EITHER way, distinguishable from a DYNAMIC `import(...)` (main.tsx's own
// `lazy(() => import('./canvas-v2/CanvasV2App'))`), which is a function CALL
// (`import(`) and never has a `from` clause. This regex matches only the
// STATIC forms, so it does not (and must not) flag main.tsx's own dynamic
// import.
const STATIC_IMPORT_OF_CANVAS_V2 = /(?:from\s+['"][^'"]*\/canvas-v2\/[^'"]*['"])|(?:^\s*import\s+['"][^'"]*\/canvas-v2\/[^'"]*['"])/m

const glob = new Glob('**/*.{ts,tsx}')
const offenders: string[] = []
let scanned = 0
for await (const f of glob.scan({ cwd: clientSrc.pathname, onlyFiles: true })) {
  if (f.includes('node_modules')) continue
  if (f.startsWith('canvas-v2/')) continue // the package itself -- internal relative imports are fine
  if (f.endsWith('.test.ts') || f.endsWith('.test.tsx')) continue // test-only imports never ship in the production bundle -- see module header
  scanned++
  const text = readFileSync(new URL(f, clientSrc), 'utf8')
  if (STATIC_IMPORT_OF_CANVAS_V2.test(text)) offenders.push(f)
}
assert.ok(scanned > 50, `sanity check: scanned suspiciously few client/src files (${scanned}) -- the glob/cwd is likely broken`)
assert.deepEqual(offenders, [], `these files statically import a canvas-v2 module from OUTSIDE client/src/canvas-v2/, defeating the lazy boundary: ${offenders.join(', ')}`)
console.log(`ok: exposure-audit -- no static import of canvas-v2 outside client/src/canvas-v2/ (scanned ${scanned} file(s))`)

console.log('ok: exposure-audit -- default room path never reaches the new engine')
