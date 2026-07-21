/**
 * How `ew` runs the vendored @devcontainers/cli (decision #2): always as a
 * SUBPROCESS against the stable CLI interface — never as a library — because
 * that interface is the surface the §1 compatibility promise is defined on.
 *   dev (source checkout): ['bun', <cli/vendor/.../devcontainer.js>]
 *   compiled binary:       [process.execPath, <extracted entry>] with
 *                          BUN_BE_BUN=1 (spike-verified: a bun-compiled binary
 *                          re-invoked with BUN_BE_BUN=1 acts as the plain bun
 *                          runtime and executes an arbitrary .js file)
 * Pure argv/env computation (runnerFor) is separated from the impure
 * detect/extract (ensureDevcontainersCli) so the former is unit-testable.
 */
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEVCONTAINERS_CLI_VERSION } from './devcontainers-cli-version.ts'
import { devcontainerEntry, specCliBundle } from './vendor-assets.js'

export interface DevcontainersCliRunner {
	/** argv prefix; append the subcommand, e.g. [...argvPrefix, 'up', …]. */
	argvPrefix: string[]
	/** extra child env (BUN_BE_BUN in compiled mode). */
	env: Record<string, string>
}

/** Pure: the argv/env for a mode + entry path. */
export function runnerFor(mode: 'dev' | 'compiled', entryPath: string, execPath: string): DevcontainersCliRunner {
	if (mode === 'dev') return { argvPrefix: ['bun', entryPath], env: {} }
	return { argvPrefix: [execPath, entryPath], env: { BUN_BE_BUN: '1' } }
}

/** Per-version extraction target for the compiled binary (immutable bumps). */
export function extractionDir(env: NodeJS.ProcessEnv): string {
	const cacheHome = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
	return path.join(cacheHome, 'ensembleworks', `devcontainers-cli-${DEVCONTAINERS_CLI_VERSION}`)
}

/** Compiled ⇔ the asset path is NOT on the real FS (it's /$bunfs/… inside the
 *  binary) — decision #2's detection rule. */
export function runningCompiled(): boolean {
	return !existsSync(devcontainerEntry)
}

/** Detect mode; in compiled mode extract the two-file bundle (preserving the
 *  shim's ./dist/spec-node relative layout) to the per-version cache dir. */
export async function ensureDevcontainersCli(env: NodeJS.ProcessEnv): Promise<DevcontainersCliRunner> {
	if (!runningCompiled()) return runnerFor('dev', devcontainerEntry, process.execPath)
	const dir = extractionDir(env)
	const entry = path.join(dir, 'devcontainer.js')
	const bundle = path.join(dir, 'dist', 'spec-node', 'devContainersSpecCLI.js')
	if (!existsSync(entry) || !existsSync(bundle)) {
		mkdirSync(path.join(dir, 'dist', 'spec-node'), { recursive: true })
		await Bun.write(entry, Bun.file(devcontainerEntry))
		await Bun.write(bundle, Bun.file(specCliBundle))
	}
	return runnerFor('compiled', entry, process.execPath)
}
