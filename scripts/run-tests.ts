// Run: bun scripts/run-tests.ts
// Discovers every **/src/**/*.test.ts (excluding node_modules) and runs each
// under bun, failing on the first non-zero exit. One command for humans and for
// the CI smoke job sub-project 7 will add.
//
// EXTENDED (Task G6): repo-level scripts (this directory, NOT under any
// package's src/) get their own, separate glob — `scripts/*.test.ts` — so a
// standalone gate like exposure-audit.test.ts (the exposure audit) runs
// under `bun run test` too, without matching the src/-scoped pattern above.
// Minimal on purpose: a nested scripts/**/*.test.ts is NOT globbed (nothing
// nests today); widen if that changes.
import { Glob } from 'bun'

// e2e/lib/*.test.ts (added 2026-07-19): the load harness's PURE helpers
// (load-metrics.ts) are unit-testable without a browser, but e2e/ has no
// src/ dir so they match neither glob above. Only the flat e2e/lib level is
// globbed — e2e/tests/ and e2e/perf/ are Playwright specs and must NOT be
// spawned under bare `bun`.
// bin/*.test.ts (added 2026-07-21): bin/dev's pure logic (dev-lib.mjs — the
// service table, port-offset parsing, attachPlan) lives outside any src/ dir,
// so it matched no glob above and its tests had never run in CI. bin/dev is
// the entry point every contributor uses; leaving it ungated meant a change
// like the tmux-socket split shipped on local test runs alone. Flat level
// only, same as e2e/lib — nothing nests under bin/ today.
const globs = ['**/src/**/*.test.ts', 'scripts/*.test.ts', 'e2e/lib/*.test.ts', 'bin/*.test.ts']
const files: string[] = []
for (const pattern of globs) {
  const glob = new Glob(pattern)
  for await (const f of glob.scan({ cwd: '.', onlyFiles: true })) {
    if (f.includes('node_modules')) continue
    files.push(f)
  }
}
files.sort()

for (const file of files) {
  console.log(`\n=== ${file} ===`)
  const proc = Bun.spawnSync(['bun', file], { stdout: 'inherit', stderr: 'inherit' })
  if (proc.exitCode !== 0) {
    console.error(`\nFAIL: ${file} (exit ${proc.exitCode})`)
    process.exit(1)
  }
}
console.log(`\nall ${files.length} suites passed`)
