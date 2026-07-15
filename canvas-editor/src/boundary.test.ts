// Run: bun src/boundary.test.ts
// Enforces canvas-editor's clean-room rule: the editor core depends ONLY on
// @ensembleworks/canvas-model + @ensembleworks/canvas-doc. It never imports
// loro-crdt (the CRDT stays behind canvas-doc's CanvasDoc interface — the
// design's swappability rule), ws, the tldraw package family, react,
// canvas-sync, or server, and never touches a DOM global or a wall
// clock/PRNG directly — every clock/id/PRNG the editor needs is injected via
// the Editor constructor (`now`, `random`) instead. Copy-adapted from
// canvas-sync/src/boundary.test.ts, HARDENED one step further: require('x'),
// dynamic import('x'), AND a bare side-effect `import 'x'` (no `from`, no
// parens — valid ES module syntax the original two-style
// from|require\(|import\( set did not catch; probe-proven here, then
// backported to canvas-sync) all resolve from this workspace today (deps
// hoisted to the root node_modules), so a package-name check must match all
// three styles.
// COMMENTS ARE IN SCOPE, deliberately: the regexes scan raw file text with
// no comment-stripping, so even a comment spelling out a forbidden call
// (e.g. the literal wall-clock-read expression) fails the test. That keeps
// the scan simple and unbypassable; src comments just phrase around the
// forbidden spellings, as this file's own header does.
// NOTE: import.meta.dirname here is canvas-editor/src itself, so the glob is
// scanned relative to THIS directory (pattern '**/*.ts', not 'src/**/*.ts' —
// that would look for a nested canvas-editor/src/src/).
import assert from 'node:assert/strict'
import { Glob } from 'bun'

// Build a forbidden-package regex covering all three import styles above.
// `pkg` is regex-escaped so a literal '.' (as in scoped package names) can't
// accidentally act as a wildcard.
function forbiddenImport(pkg: string): RegExp {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:from|require\\(|import\\(|import\\s)\\s*['"]${escaped}['"]`)
}

const FORBIDDEN = [
  forbiddenImport('loro-crdt'),
  forbiddenImport('ws'),
  /@tldraw\//,
  forbiddenImport('react'),
  forbiddenImport('canvas-sync'),
  forbiddenImport('@ensembleworks/canvas-sync'),
  /from ['"](\.\.\/)*server/,
  /document\./,
  /window\./,
  /Date\.now\(/,
  /Math\.random\(/,
]
const glob = new Glob('**/*.ts')
const files: string[] = []
for await (const f of glob.scan({ cwd: import.meta.dirname, onlyFiles: true })) {
  if (f.endsWith('.test.ts')) continue           // tests may inject/measure freely
  files.push(f)
  const text = await Bun.file(`${import.meta.dirname}/${f}`).text()
  for (const re of FORBIDDEN) assert.ok(!re.test(text), `${f} violates clean-room boundary: ${re}`)
}
assert.ok(files.length > 0, 'boundary test scanned zero files — glob/cwd is broken')
console.log(`ok: boundary (scanned ${files.length} file(s): ${files.sort().join(', ')})`)
