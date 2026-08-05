// Vendored @devcontainers/cli (decision #1): the pinned esbuild bundle is
// committed under cli/vendor/devcontainers-cli/ and runnable under plain bun
// (bun-compat spike verdict 2026-07-21: PASS — --help, read-configuration,
// up, exec, build all exit 0). Runtime surface is THREE files, amended by the
// Task 12 conformance run (2026-07-21): scripts/updateUID.Dockerfile is read
// relative to devcontainer.js by the default --update-remote-user-uid-default
// on path — the original two-file claim missed it. Network-free: the
// re-vendoring script is manual-run and NOT exercised here.
// Run with: bun src/codespace/vendor.test.ts
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEVCONTAINERS_CLI_VERSION } from './devcontainers-cli-version.ts'

const vendorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'devcontainers-cli')
const entry = path.join(vendorDir, 'devcontainer.js')
const bundle = path.join(vendorDir, 'dist', 'spec-node', 'devContainersSpecCLI.js')
const updateUidDockerfile = path.join(vendorDir, 'scripts', 'updateUID.Dockerfile')

assert.ok(existsSync(entry), `missing ${entry} — run: bun cli/scripts/vendor-devcontainers-cli.ts`)
assert.ok(existsSync(bundle), `missing ${bundle} — run: bun cli/scripts/vendor-devcontainers-cli.ts`)
assert.ok(existsSync(updateUidDockerfile), `missing ${updateUidDockerfile} — run: bun cli/scripts/vendor-devcontainers-cli.ts`)
assert.equal(
	readFileSync(path.join(vendorDir, 'VERSION'), 'utf8').trim(),
	DEVCONTAINERS_CLI_VERSION,
	'vendored VERSION matches the pin',
)
// The shim requires ./dist/spec-node/… relative to itself — layout must hold.
assert.ok(readFileSync(entry, 'utf8').includes('spec-node'), 'entry shim points at the spec-node bundle')

// The bundle actually runs under bun (no docker, no network): --help exits 0.
const res = Bun.spawnSync(['bun', entry, '--help'], { stdout: 'pipe', stderr: 'pipe' })
assert.equal(res.exitCode, 0, `devcontainer --help under bun failed: ${res.stderr.toString().slice(0, 400)}`)
assert.ok(res.stdout.toString().includes('devcontainer'), 'help text mentions devcontainer')

console.log('ok: vendored devcontainers-cli — files present, VERSION pinned, --help runs under bun')
