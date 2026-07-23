/**
 * `ew codespace stop` (decision #7): docker stop by the EXACT stored
 * containerId — never a name/label filter (incident-derived policy). The
 * store record survives: it is SP4's desired-state seed; only the container's
 * processes die (design §5.1 event #3 — disk persists, prompt is fresh).
 */
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { emitJson, narrate } from '../output.ts'
import { detectRepoInfo } from './repo-info.ts'
import { codespacesPath, loadCodespaces, setDesired } from './store.ts'

export function buildStopArgv(containerId: string): string[] {
	return ['docker', 'stop', containerId]
}

export async function codespaceStop(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	if (args.length > 0) throw new CliError(`unknown codespace stop flag: ${args[0]}`, 2)
	const info = detectRepoInfo(process.cwd())
	const rec = loadCodespaces(codespacesPath(env)).codespaces[info.toplevel]
	if (!rec?.containerId) {
		throw new CliError(`no known container for ${info.toplevel} — run ew codespace up first`, 2)
	}
	const stopArgv = buildStopArgv(rec.containerId)
	if (globals.dryRun) {
		emitJson({ workspaceFolder: info.toplevel, gatewayId: rec.gatewayId, stopArgv })
		return 0
	}
	narrate(`ensembleworks: stopping container ${rec.containerId.slice(0, 12)} (${rec.gatewayId})`)
	// desired flips BEFORE docker runs: an interrupted stop must never leave a
	// codespace the owner asked to stop marked desired-up for the reconciler.
	setDesired(codespacesPath(env), info.toplevel, 'stopped')
	const res = Bun.spawnSync(stopArgv, { stdout: 'inherit', stderr: 'inherit' })
	if (res.exitCode !== 0) throw new CliError(`docker stop exited ${res.exitCode}`, 1)
	return 0
}
