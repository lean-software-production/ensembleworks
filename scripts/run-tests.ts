// Run: bun scripts/run-tests.ts
// Discovers every **/src/**/*.test.ts (excluding node_modules) and runs each
// under bun, failing on the first non-zero exit. One command for humans and for
// the CI smoke job sub-project 7 will add.
import { Glob } from 'bun'

const glob = new Glob('**/src/**/*.test.ts')
const files: string[] = []
for await (const f of glob.scan({ cwd: '.', onlyFiles: true })) {
  if (f.includes('node_modules')) continue
  files.push(f)
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
