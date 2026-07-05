// Run: bun src/service-tokens.test.ts   (from server/)  — or via `bun run test`
// Loads the config-folder service-token map: valid entry, missing file, malformed
// TOML (fail closed), scope default, and mtime-based reload. Uses distinct file
// paths per case (path change busts the cache) plus one explicit mtime bump.
import assert from 'node:assert/strict'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-service-tokens-'))
let n = 0
function useMap(content: string | null): void {
	const f = path.join(dir, `st-${n++}.toml`)
	if (content !== null) writeFileSync(f, content)
	process.env.EW_SERVICE_TOKENS_FILE = f
}

const { lookupServiceToken } = await import('./service-tokens.ts')

// Missing file → no tokens.
useMap(null)
assert.equal(lookupServiceToken('codespace-3.access'), null, 'missing file → null')

// Valid entry resolves; unknown common_name → null.
useMap('[tokens."codespace-3.access"]\nidentity = "🤖 codespace-3"\nscope = "read-write"\n')
assert.deepEqual(
	lookupServiceToken('codespace-3.access'),
	{ identity: '🤖 codespace-3', scope: 'read-write' },
	'valid entry resolves',
)
assert.equal(lookupServiceToken('unknown.access'), null, 'unknown common_name → null')

// scope defaults to read-only when absent.
useMap('[tokens."ro.access"]\nidentity = "🤖 ro"\n')
assert.deepEqual(lookupServiceToken('ro.access'), { identity: '🤖 ro', scope: 'read-only' }, 'scope defaults read-only')

// Malformed TOML → fail closed (no tokens), no throw.
useMap('this is [not valid TOML')
assert.equal(lookupServiceToken('anything'), null, 'malformed → null (fail closed)')

// mtime reload: editing the same file (with an advanced mtime) is picked up.
const rf = path.join(dir, 'reload.toml')
process.env.EW_SERVICE_TOKENS_FILE = rf
writeFileSync(rf, '[tokens."a.access"]\nidentity = "🤖 a"\n')
utimesSync(rf, new Date(1000), new Date(1000))
assert.equal(lookupServiceToken('a.access')?.identity, '🤖 a', 'first load')
writeFileSync(rf, '[tokens."a.access"]\nidentity = "🤖 b"\n')
utimesSync(rf, new Date(2000), new Date(2000))
assert.equal(lookupServiceToken('a.access')?.identity, '🤖 b', 'mtime change reloads')

console.log('ok: service-tokens map loader')
