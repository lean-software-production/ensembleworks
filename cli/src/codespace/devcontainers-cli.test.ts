// Runner resolution (decision #2): pure argv/env for both modes, XDG-honoring
// extraction dir, and ensureDevcontainersCli in a dev checkout returning
// ['bun', <real vendor path>] with no extraction. Network-free; the compiled
// branch's extraction is exercised by scripts/codespace-conformance.ts.
// Run with: bun src/codespace/devcontainers-cli.test.ts
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DEVCONTAINERS_CLI_VERSION } from './devcontainers-cli-version.ts'
import { ensureDevcontainersCli, extractionDir, runnerFor, runningCompiled } from './devcontainers-cli.ts'

// Pure argv/env computation.
{
	const dev = runnerFor('dev', '/repo/cli/vendor/devcontainers-cli/devcontainer.js', '/usr/bin/ew')
	assert.deepEqual(dev.argvPrefix, ['bun', '/repo/cli/vendor/devcontainers-cli/devcontainer.js'])
	assert.deepEqual(dev.env, {}, 'dev mode needs no env override')

	const compiled = runnerFor('compiled', '/home/u/.cache/ensembleworks/devcontainers-cli-0.87.0/devcontainer.js', '/usr/local/bin/ew')
	assert.deepEqual(compiled.argvPrefix, ['/usr/local/bin/ew', '/home/u/.cache/ensembleworks/devcontainers-cli-0.87.0/devcontainer.js'])
	assert.deepEqual(compiled.env, { BUN_BE_BUN: '1' }, 'compiled mode re-invokes the ew binary as the plain bun runtime')
}

// Extraction dir honors XDG_CACHE_HOME and is per-version (immutable bumps).
{
	const dir = extractionDir({ XDG_CACHE_HOME: '/tmp/cache' } as NodeJS.ProcessEnv)
	assert.equal(dir, path.join('/tmp/cache', 'ensembleworks', `devcontainers-cli-${DEVCONTAINERS_CLI_VERSION}`))
}

// In this dev checkout: not compiled; ensure returns bun + the real vendor entry.
{
	assert.equal(runningCompiled(), false, 'a source checkout is dev mode')
	const runner = await ensureDevcontainersCli(process.env)
	assert.equal(runner.argvPrefix[0], 'bun')
	assert.ok(existsSync(runner.argvPrefix[1] as string), 'dev entry is a real FS path')
	assert.ok((runner.argvPrefix[1] as string).endsWith(path.join('vendor', 'devcontainers-cli', 'devcontainer.js')))
}

console.log('ok: devcontainers-cli runner — dev/compiled argv+env, XDG extraction dir, dev-mode ensure')
