// Re-vendor the pinned @devcontainers/cli into cli/vendor/devcontainers-cli/.
// NETWORK + MANUAL-RUN by design (decision #1): not named *.test.ts, so no
// test glob ever spawns it. Bump flow: edit devcontainers-cli-version.ts, run
// `bun cli/scripts/vendor-devcontainers-cli.ts`, commit the vendor dir, and
// re-run `bun scripts/codespace-conformance.ts` (the bump gate) before landing.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEVCONTAINERS_CLI_VERSION } from '../src/codespace/devcontainers-cli-version.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const vendorDir = path.join(here, '..', 'vendor', 'devcontainers-cli')
const url = `https://registry.npmjs.org/@devcontainers/cli/-/cli-${DEVCONTAINERS_CLI_VERSION}.tgz`

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-vendor-devcontainers-'))
try {
	console.error(`fetching ${url}`)
	const res = await fetch(url)
	if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
	const tarball = path.join(tmp, 'cli.tgz')
	await Bun.write(tarball, await res.arrayBuffer())
	const untar = Bun.spawnSync(['tar', '-xzf', tarball, '-C', tmp], { stdout: 'inherit', stderr: 'inherit' })
	if (untar.exitCode !== 0) throw new Error(`tar -xzf failed (exit ${untar.exitCode})`)

	// The runtime surface is exactly two files (spike-verified): the 423B
	// require shim and the 1.7MB esbuild bundle it loads at ./dist/spec-node/.
	// Zero runtime node_modules — proven by the spike's isolated-copy run.
	mkdirSync(path.join(vendorDir, 'dist', 'spec-node'), { recursive: true })
	copyFileSync(path.join(tmp, 'package', 'devcontainer.js'), path.join(vendorDir, 'devcontainer.js'))
	copyFileSync(
		path.join(tmp, 'package', 'dist', 'spec-node', 'devContainersSpecCLI.js'),
		path.join(vendorDir, 'dist', 'spec-node', 'devContainersSpecCLI.js'),
	)
	writeFileSync(path.join(vendorDir, 'VERSION'), `${DEVCONTAINERS_CLI_VERSION}\n`)
	console.error(`vendored @devcontainers/cli@${DEVCONTAINERS_CLI_VERSION} → ${vendorDir}`)
} finally {
	rmSync(tmp, { recursive: true, force: true })
}
