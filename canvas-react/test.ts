// Run: bun test.ts  (or: bun run test)
// Discovers this package's src/**/*.test.ts and runs each as a plain script
// under `bun`, failing on the first non-zero exit. House style: tests are
// self-executing node:assert scripts, NOT bun:test. Mirrors canvas-editor's
// test.ts verbatim (see that file's header) — component/test files in this
// package differ (src/*.tsx for JSX-bearing components), but every TEST
// file stays *.test.ts (no JSX inside a test itself: renderToStaticMarkup
// is invoked via React.createElement, not a JSX literal, precisely so this
// glob — and the root scripts/run-tests.ts glob, which also only matches
// *.test.ts — need no `.tsx` variant).
import { Glob } from 'bun'

const glob = new Glob('src/**/*.test.ts')
const files: string[] = []
for await (const f of glob.scan({ cwd: import.meta.dirname, onlyFiles: true })) files.push(f)
files.sort()

for (const file of files) {
  console.log(`\n=== ${file} ===`)
  const proc = Bun.spawnSync(['bun', file], { cwd: import.meta.dirname, stdout: 'inherit', stderr: 'inherit' })
  if (proc.exitCode !== 0) {
    console.error(`\nFAIL: ${file} (exit ${proc.exitCode})`)
    process.exit(1)
  }
}
console.log(`\nall ${files.length} suites passed`)
