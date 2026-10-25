// Run: bun src/boundary.test.ts
// Enforces canvas-react's clean-room + LOGIC-FREE rules: this package
// depends ONLY on @ensembleworks/canvas-editor + @ensembleworks/canvas-model
// + react/react-dom. It never imports loro-crdt/ws/express directly (those
// stay behind canvas-editor's own boundary — canvas-react reaches doc state
// ONLY through the Editor/ToolContext canvas-editor hands it), never
// imports canvas-sync/canvas-doc/server, and never touches the tldraw
// package family. UNLIKE canvas-editor/canvas-model's boundary tests, this
// one does NOT forbid `document.`/`window.` — DOM access is this package's
// entire job (it's the renderer) — and it DOES forbid `react`/`react-dom`
// nowhere (they're the point). Copy-adapted from canvas-editor/src/
// boundary.test.ts, keeping its HARDENING: require('x'), dynamic import('x'),
// AND a bare side-effect `import 'x'` (no `from`, no parens) all resolve
// from this workspace today (deps hoisted to the root node_modules), so a
// package-name check must match all three styles — the ORIGINAL two-style
// (from|require\() check had a gap a bare side-effect import slipped
// through; probe-proven in canvas-editor, backported here from the start.
//
// LOGIC-FREE / PUBLIC-ENTRY-ONLY (canvas-react-specific, beyond the copied
// pattern): canvas-editor and canvas-model each publish exactly ONE entry
// point (package.json "exports": { ".": "./src/index.ts" } — there is no
// subpath to import). A "deep import" — `@ensembleworks/canvas-editor/`
// or `@ensembleworks/canvas-model/` followed by ANYTHING (e.g. `.../src/
// tools/select.js`, `.../src/intents.js`) — reaches past that barrel at
// files never meant to be imported directly, INCLUDING intents.ts (the
// module a tool/editor uses to CONSTRUCT doc-mutating Intents). Forbidding
// `applyIntent|apply\(`-shaped call patterns was considered and rejected as
// too blunt (it would also flag legitimate DOM/array `.apply(` calls with
// no relation to canvas-editor's Intent system); forbidding the DEEP IMPORT
// SPECIFIER instead is precise and sufficient — the renderer can only ever
// see what the public barrel re-exports (Editor, ToolContext, InputEvent,
// Camera, worldToScreen/screenToWorld, the Tool<S> interface, and yes, the
// Intent TYPE via `export * from './intents.js'` — a renderer may need that
// TYPE to shape an `onInput`-adjacent callback signature) and never a path
// that lets it reach in and construct/apply an Intent itself. That IS the
// logic-free boundary: intents are produced by tools (canvas-editor) and
// applied by the Editor (canvas-editor); this package only reads state and
// forwards raw input.
//
// COMMENTS ARE IN SCOPE, deliberately: the regexes scan raw file text with
// no comment-stripping, so even a comment spelling out a forbidden call
// (e.g. the literal wall-clock-read expression, or the tldraw scoped
// package name with a slash) fails the test. See camera.ts's CITATION STYLE
// NOTE for how canvas-editor phrases around that; this package follows the
// same convention.
// NOTE: import.meta.dirname here is canvas-react/src itself, so the glob is
// scanned relative to THIS directory (patterns '**/*.ts'/'**/*.tsx', not
// 'src/**/*.ts' — that would look for a nested canvas-react/src/src/).
import assert from 'node:assert/strict'
import { Glob } from 'bun'

// Build a forbidden-package regex covering all three import styles above,
// for an EXACT package specifier (no subpath match — see forbiddenDeepImport
// below for the subpath case). `pkg` is regex-escaped so a literal '.' (as
// in scoped package names) can't accidentally act as a wildcard.
function forbiddenImport(pkg: string): RegExp {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:from|require\\(|import\\(|import\\s)\\s*['"]${escaped}['"]`)
}

// Same three import styles, but matching `pkg/` as a PREFIX (no closing
// quote required immediately after) — i.e. any subpath under `pkg`. This is
// what catches a deep import into canvas-editor's or canvas-model's
// internals (bypassing their single "." barrel export) rather than an
// import of the bare package name.
function forbiddenDeepImport(pkg: string): RegExp {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:from|require\\(|import\\(|import\\s)\\s*['"]${escaped}/`)
}

const FORBIDDEN = [
  forbiddenImport('loro-crdt'),
  forbiddenImport('ws'),
  forbiddenImport('express'),
  forbiddenImport('canvas-sync'),
  forbiddenImport('@ensembleworks/canvas-sync'),
  forbiddenImport('canvas-doc'),
  forbiddenImport('@ensembleworks/canvas-doc'),
  /@tldraw\//,
  /(?:from|require\(|import\(|import\s)\s*['"](\.\.\/)*server/,
  forbiddenDeepImport('@ensembleworks/canvas-editor'),
  forbiddenDeepImport('@ensembleworks/canvas-model'),
  /Date\.now\(/,
  /Math\.random\(/,
]

const files: string[] = []
for (const pattern of ['**/*.ts', '**/*.tsx']) {
  const glob = new Glob(pattern)
  for await (const f of glob.scan({ cwd: import.meta.dirname, onlyFiles: true })) {
    if (f.endsWith('.test.ts') || f.endsWith('.test.tsx')) continue // tests may inject/measure freely
    files.push(f)
    const text = await Bun.file(`${import.meta.dirname}/${f}`).text()
    for (const re of FORBIDDEN) assert.ok(!re.test(text), `${f} violates clean-room boundary: ${re}`)
  }
}
assert.ok(files.length > 0, 'boundary test scanned zero files — glob/cwd is broken')
console.log(`ok: boundary (scanned ${files.length} file(s): ${files.sort().join(', ')})`)
