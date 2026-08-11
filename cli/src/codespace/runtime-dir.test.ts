// Connector staging (decisions #3/#4): EW_CONNECTOR_BIN override → compiled
// self (process.execPath) → CliError with the build hint; runtime dir honors
// XDG_DATA_HOME; staging copies the binary as `ensembleworks` with the exec
// bit. Run with: bun src/codespace/runtime-dir.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliError } from '../errors.ts'
import { resolveConnectorBin, runtimeDir, stageRuntimeDir } from './runtime-dir.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-runtime-'))

// Resolution chain.
{
	const fake = path.join(tmp, 'fake-connector')
	writeFileSync(fake, '#!/bin/sh\n')
	assert.equal(resolveConnectorBin({ EW_CONNECTOR_BIN: fake } as NodeJS.ProcessEnv, false), fake, 'override wins')

	assert.throws(
		() => resolveConnectorBin({ EW_CONNECTOR_BIN: path.join(tmp, 'nope') } as NodeJS.ProcessEnv, false),
		(e: unknown) => e instanceof CliError && e.exitCode === 2 && /missing file/.test(e.message),
		'dangling override refused',
	)

	assert.equal(resolveConnectorBin({} as NodeJS.ProcessEnv, true), process.execPath, 'compiled: the ew binary IS the connector')

	assert.throws(
		() => resolveConnectorBin({} as NodeJS.ProcessEnv, false),
		(e: unknown) => e instanceof CliError && e.exitCode === 2 && /build:binary/.test(e.message) && /EW_CONNECTOR_BIN/.test(e.message),
		'source checkout without override refused, with the build hint',
	)
}

// Runtime dir: XDG_DATA_HOME honored (decision #3's ~/.local/share default).
assert.equal(
	runtimeDir({ XDG_DATA_HOME: '/tmp/data' } as NodeJS.ProcessEnv),
	path.join('/tmp/data', 'ensembleworks', 'ew-runtime'),
)
assert.ok(runtimeDir({} as NodeJS.ProcessEnv).endsWith(path.join('.local', 'share', 'ensembleworks', 'ew-runtime')))

// Staging: copy as `ensembleworks`, exec bit set, content intact, idempotent.
{
	const src = path.join(tmp, 'built-connector')
	writeFileSync(src, 'BINARY-BYTES-v1')
	const dir = path.join(tmp, 'stage', 'ew-runtime')
	const dest = stageRuntimeDir(dir, src)
	assert.equal(dest, path.join(dir, 'ensembleworks'))
	assert.equal(readFileSync(dest, 'utf8'), 'BINARY-BYTES-v1')
	assert.equal(statSync(dest).mode & 0o111, 0o111, 'exec bits set')
	writeFileSync(src, 'BINARY-BYTES-v2')
	const before = statSync(dest).ino
	stageRuntimeDir(dir, src) // upgrade = one-file swap (design §2.1)
	assert.equal(readFileSync(dest, 'utf8'), 'BINARY-BYTES-v2', 're-staging overwrites')

	// Re-staging must REPLACE the inode, not write through it. A connector
	// started by an earlier `codespace up` is still executing this exact file
	// inside the container (the in-container process outlives the host-side
	// `devcontainer exec`), so copying onto it raises ETXTBSY and the codespace
	// restart-loops forever. Observed 2026-07-22 on a real run:
	//   ETXTBSY: text file is busy, copyfile '…/cli/dist/ensembleworks'
	//     -> '…/ensembleworks/ew-runtime/ensembleworks'
	// write-to-temp + rename leaves the running process on its old inode and
	// publishes a fresh one for the next exec.
	assert.notEqual(statSync(dest).ino, before, 're-staging replaces the inode (ETXTBSY-safe)')
}

console.log('ok: runtime-dir — resolution chain, XDG dir, staged ensembleworks binary')
