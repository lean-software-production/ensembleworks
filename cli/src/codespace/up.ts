/**
 * `ew codespace up` (spec §6.2, decisions #3/#5): resolve conn + repo +
 * store record → ensure the vendored CLI is runnable → compute the full plan
 * (up argv with the /ew bind mount, exec argv with creds as --remote-env) →
 * --dry-run prints it (secrets REDACTED) or the live engine (Task 9) runs it.
 * Pure argv builders + parseUpResult are exported for tests; the engine stays
 * thin (decision #5 — the conformance smoke, not unit tests, covers it).
 */
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitJson } from '../output.ts'
import { type Conn, readEnv, resolveConn } from '../resolve.ts'
import { type DevcontainersCliRunner, ensureDevcontainersCli, runningCompiled } from './devcontainers-cli.ts'
import { detectRepoInfo } from './repo-info.ts'
import { codespacesPath, ensureCodespaceRecord } from './store.ts'
import { resolveConnectorBin, runtimeDir } from './runtime-dir.ts'

export interface UpPlan {
	workspaceFolder: string
	gatewayId: string
	repo: string
	branch: string
	runtimeDir: string
	connectorBin: string
	/** full `devcontainer up` argv (runner prefix included) */
	upArgv: string[]
	/** extra env the runner subprocesses need (BUN_BE_BUN when compiled) */
	runnerEnv: Record<string, string>
	/** exec argv with secrets REDACTED — the printable form; the live engine
	 *  rebuilds the real one via buildExecArgv(…, { redact: false }). */
	execArgv: string[]
}

export function buildUpArgv(runner: DevcontainersCliRunner, workspaceFolder: string, rtDir: string, removeExisting: boolean): string[] {
	const argv = [
		...runner.argvPrefix, 'up',
		'--workspace-folder', workspaceFolder,
		// Injection (decision #3): read-only-by-role staging dir at /ew. The
		// upstream --mount syntax (spike-verified) has no ro knob; the dir holds
		// one host-owned binary, nothing secret.
		'--mount', `type=bind,source=${rtDir},target=/ew`,
	]
	if (removeExisting) argv.push('--remove-existing-container')
	return argv
}

export function buildExecArgv(
	runner: DevcontainersCliRunner,
	workspaceFolder: string,
	conn: Conn,
	rec: { gatewayId: string; repo: string; branch: string },
	opts: { redact: boolean },
): string[] {
	const secret = (v: string) => (opts.redact ? 'REDACTED' : v)
	const argv = [
		...runner.argvPrefix, 'exec',
		'--workspace-folder', workspaceFolder,
		// Creds as exec-time env — never in an image layer, never in the
		// workspace (design §2.1 step 3). The cli reads exactly these names
		// (cli/src/resolve.ts readEnv).
		'--remote-env', `ENSEMBLEWORKS_URL=${conn.url}`,
	]
	if (conn.auth.method === 'service-token') {
		argv.push('--remote-env', `ENSEMBLEWORKS_TOKEN_ID=${secret(conn.auth.tokenId)}`)
		argv.push('--remote-env', `ENSEMBLEWORKS_TOKEN_SECRET=${secret(conn.auth.tokenSecret)}`)
	}
	argv.push(
		'--', '/ew/ensembleworks', 'terminal', 'connect',
		'--backend', 'pty',
		'--gateway-id', rec.gatewayId,
		'--label', rec.branch ? `${rec.repo}@${rec.branch}` : rec.repo,
	)
	if (rec.repo) argv.push('--repo', rec.repo)
	if (rec.branch) argv.push('--branch', rec.branch)
	return argv
}

/** The `up` result is the LAST stdout line that parses as JSON with an
 *  `outcome` field (spike-verified: {"outcome":"success","containerId":…,
 *  "remoteUser":…,"remoteWorkspaceFolder":…}; progress noise may precede it —
 *  containerId comes from up's stdout ONLY, read-configuration has none). */
export function parseUpResult(stdout: string): { containerId: string; remoteUser?: string; remoteWorkspaceFolder?: string } {
	const lines = stdout.split('\n')
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim()
		if (!line || !line.startsWith('{')) continue
		let parsed: { outcome?: string; containerId?: string; message?: string; description?: string; remoteUser?: string; remoteWorkspaceFolder?: string }
		try {
			parsed = JSON.parse(line)
		} catch {
			continue // not JSON after all — keep scanning up
		}
		if (!parsed.outcome) continue
		if (parsed.outcome !== 'success' || !parsed.containerId) {
			throw new CliError(`devcontainer up failed: ${parsed.message ?? parsed.description ?? line}`, 1)
		}
		return { containerId: parsed.containerId, remoteUser: parsed.remoteUser, remoteWorkspaceFolder: parsed.remoteWorkspaceFolder }
	}
	throw new CliError('devcontainer up produced no outcome JSON on stdout', 1)
}

export async function resolveUpPlan(conn: Conn, cwd: string, env: NodeJS.ProcessEnv, flags: { removeExisting: boolean }): Promise<UpPlan> {
	const info = detectRepoInfo(cwd)
	const rec = ensureCodespaceRecord(codespacesPath(env), info.toplevel, {
		repo: info.repo,
		branch: info.branch,
		canvasUrl: conn.url,
	})
	const runner = await ensureDevcontainersCli(env)
	const connectorBin = resolveConnectorBin(env, runningCompiled())
	const rtDir = runtimeDir(env)
	return {
		workspaceFolder: info.toplevel,
		gatewayId: rec.gatewayId,
		repo: rec.repo,
		branch: rec.branch,
		runtimeDir: rtDir,
		connectorBin,
		upArgv: buildUpArgv(runner, info.toplevel, rtDir, flags.removeExisting),
		runnerEnv: runner.env,
		execArgv: buildExecArgv(runner, info.toplevel, conn, rec, { redact: true }),
	}
}

export async function codespaceUp(args: string[], globals: Globals, env: NodeJS.ProcessEnv, opts: { removeExisting: boolean }): Promise<number> {
	if (args.length > 0) throw new CliError(`unknown codespace up flag: ${args[0]}`, 2) // v1: cwd is the workspace, no own flags
	const conn = resolveConn({ url: globals.url, room: globals.room }, readEnv(env), loadHosts(hostsPath(env)))
	const plan = await resolveUpPlan(conn, process.cwd(), env, { removeExisting: opts.removeExisting })
	if (globals.dryRun) {
		emitJson(plan)
		return 0
	}
	return runCodespace(plan, conn, env) // Task 9
}

async function runCodespace(_plan: UpPlan, _conn: Conn, _env: NodeJS.ProcessEnv): Promise<number> {
	throw new CliError('codespace up live engine lands in Task 9 — use --dry-run', 1)
}
