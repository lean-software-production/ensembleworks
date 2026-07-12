// Run: bun src/boundary.test.ts
// Enforces the clean-room rule: canvas-sync core never imports ws, express,
// tldraw, or server, and never touches Date.now/Math.random directly.
// NOTE: import.meta.dirname here is canvas-sync/src itself, so the glob is
// scanned relative to THIS directory (pattern '**/*.ts', not 'src/**/*.ts' —
// that would look for a nested canvas-sync/src/src/).
import assert from 'node:assert/strict'
import { Glob } from 'bun'

// ws/express patterns cover static imports AND call styles — require('ws') and
// await import('ws') both RESOLVE from this package today (server's deps are
// hoisted to the root node_modules), so from-only matching is not enough.
const FORBIDDEN = [
  /(?:from|require\(|import\()\s*['"]ws['"]/,
  /(?:from|require\(|import\()\s*['"]express['"]/,
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
