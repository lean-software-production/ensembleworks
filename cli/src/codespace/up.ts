/**
 * `ew codespace up` (spec §6.2, decisions #3/#5): resolve conn + repo +
 * store record → ensure the vendored CLI is runnable → compute the full plan
 * (up argv with the /ew bind mount, exec argv with creds as --remote-env) →
 * --dry-run prints it (secrets REDACTED) or the live engine (Task 9) runs it.
 * Pure argv builders + parseUpResult are exported for tests; the engine stays
 * thin (decision #5 — the conformance smoke, not unit tests, covers it).
 */
import type { Globals } from '../dispatch.ts'
import { realTimers } from '../connector/index.ts'
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitJson, narrate } from '../output.ts'
import { type Conn, readEnv, resolveConn } from '../resolve.ts'
import { type DevcontainersCliRunner, ensureDevcontainersCli, runningCompiled } from './devcontainers-cli.ts'
import { detectRepoInfo } from './repo-info.ts'
import { codespacesPath, ensureCodespaceRecord, updateContainerId } from './store.ts'
import { resolveConnectorBin, runtimeDir, stageRuntimeDir } from './runtime-dir.ts'
import { supervise } from './supervise.ts'

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

/** The live engine (design §2.1 steps 1–4, decision #5): thin by design —
 *  every decision it strings together is a unit-tested pure part; the
 *  end-to-end proof is scripts/codespace-conformance.ts, not a unit test. */
async function runCodespace(plan: UpPlan, conn: Conn, env: NodeJS.ProcessEnv): Promise<number> {
	const runner = await ensureDevcontainersCli(env)
	const childEnv = { ...env, ...plan.runnerEnv } as Record<string, string>

	// 1+2. Build/start the unmodified repo, with the /ew injection mount added
	// at up time (repo-pristine). stderr streams through; stdout carries the
	// outcome JSON.
	narrate(`ensembleworks: devcontainer up — ${plan.branch ? `${plan.repo}@${plan.branch}` : plan.repo} (${plan.workspaceFolder})`)
	stageRuntimeDir(plan.runtimeDir, plan.connectorBin)
	const up = Bun.spawnSync(plan.upArgv, { env: childEnv, stdout: 'pipe', stderr: 'inherit' })
	if (up.exitCode !== 0) throw new CliError(`devcontainer up exited ${up.exitCode}`, 1)
	const result = parseUpResult(up.stdout.toString())
	updateContainerId(codespacesPath(env), plan.workspaceFolder, result.containerId)
	narrate(`ensembleworks: container ${result.containerId.slice(0, 12)} up; starting connector (gateway ${plan.gatewayId})`)

	// 3+4. Exec the connector inside the container (creds as exec-time env —
	// rebuilt UNredacted here; plan.execArgv stays the printable form) and
	// supervise it in the foreground until SIGINT/SIGTERM.
	const execArgv = buildExecArgv(runner, plan.workspaceFolder, conn, plan, { redact: false })
	const ac = new AbortController()
	const onSignal = () => ac.abort()
	process.once('SIGINT', onSignal)
	process.once('SIGTERM', onSignal)
	let child: ReturnType<typeof Bun.spawn> | null = null
	ac.signal.addEventListener('abort', () => child?.kill())
	try {
		await supervise(async () => {
			child = Bun.spawn(execArgv, { env: childEnv, stdout: 'inherit', stderr: 'inherit' })
			const code = await child.exited
			child = null
			if (!ac.signal.aborted) narrate(`ensembleworks: connector exec exited ${code}; restarting with backoff`)
		}, { timers: realTimers, rng: Math.random }, ac.signal)
	} finally {
		process.off('SIGINT', onSignal)
		process.off('SIGTERM', onSignal)
	}
	narrate('ensembleworks: codespace connector stopped (container left running — `ew codespace stop` to stop it)')
	return 0
}
