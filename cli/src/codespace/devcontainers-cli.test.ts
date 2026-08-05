// Runner resolution (decision #2): pure argv/env for both modes, XDG-honoring
// extraction dir, and ensureDevcontainersCli in a dev checkout returning
// ['bun', <real vendor path>] with no extraction. Network-free; the compiled
// branch's extraction is exercised by scripts/codespace-conformance.ts.
// Run with: bun src/codespace/devcontainers-cli.test.ts
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DEVCONTAINERS_CLI_VERSION } from './devcontainers-cli-version.ts'
import { compiledFromEntry, ensureDevcontainersCli, extractionDir, runnerFor, runningCompiled } from './devcontainers-cli.ts'

// Mode detection must key off the embedded-asset path SHAPE, not existsSync:
// under Bun 1.3.14 existsSync('/$bunfs/root/…') returns TRUE inside a compiled
// binary, so an existsSync-only rule reports dev mode in a compiled ew and
// produces the unrunnable argv ['bun', '/$bunfs/root/devcontainer-*.js'].
// Found by local acceptance testing 2026-07-22 — the dev-only assertion below
// passed throughout, and the conformance smoke runs ew in dev mode.
{
	const alwaysExists = () => true
	assert.equal(
		compiledFromEntry('/$bunfs/root/devcontainer-870gsft4.js', alwaysExists),
		true,
		'a /$bunfs entry is compiled mode even when existsSync says it is present',
	)
	assert.equal(
		compiledFromEntry('B:\\~BUN\\root\\devcontainer-870gsft4.js', alwaysExists),
		true,
		'the Windows embedded-asset root is compiled mode too',
	)
	assert.equal(
		compiledFromEntry('/repo/cli/vendor/devcontainers-cli/devcontainer.js', alwaysExists),
		false,
		'a real vendor path that exists is dev mode',
	)
	assert.equal(
		compiledFromEntry('/repo/cli/vendor/devcontainers-cli/devcontainer.js', () => false),
		true,
		'a vendor path that is absent still falls back to compiled (original rule retained)',
	)
}

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
