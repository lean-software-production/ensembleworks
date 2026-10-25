// Run: bun src/boundary.test.ts
// Enforces the clean-room rule: canvas-sync core never imports ws, express,
// tldraw, or server, and never touches Date.now/Math.random directly.
// NOTE: import.meta.dirname here is canvas-sync/src itself, so the glob is
// scanned relative to THIS directory (pattern '**/*.ts', not 'src/**/*.ts' —
// that would look for a nested canvas-sync/src/src/).
import assert from 'node:assert/strict'
import { Glob } from 'bun'

// ws/express patterns cover static imports AND call styles — require('ws'),
// await import('ws'), AND a bare side-effect `import 'ws'` (no `from`, no
// parens — valid ES module syntax the original from|require\(|import\( set
// silently let through; gap probe-proven during canvas-editor's C1 hostile
// pass and independently verified here) all RESOLVE from this package today
// (server's deps are hoisted to the root node_modules), so a package-name
// check must match all three styles, not just the first two. `pkg` is
// regex-escaped so a literal '.' in a package name can't act as a wildcard.
function forbiddenImport(pkg: string): RegExp {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:from|require\\(|import\\(|import\\s)\\s*['"]${escaped}['"]`)
}

const FORBIDDEN = [
  forbiddenImport('ws'),
  forbiddenImport('express'),
  /@tldraw\//,
  /from ['"](\.\.\/)*server/,
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
