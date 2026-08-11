/**
 * `ew codespace reconcile` (SP4 decision #2, design §6): drive reality toward
 * codespaces.json's desired-state. Idempotent by construction: `devcontainer
 * up` is idempotent, gatewayIds are stable, and re-running reconcile
 * re-attaches rather than duplicating. Every desired-up entry gets its own
 * superviseCodespace loop; all loops run in ONE foreground process under ONE
 * AbortController — this process IS what the systemd unit (boot-install)
 * keeps alive. Resilience: missing checkouts and per-entry plan failures are
 * narrated and skipped, never fatal; cycle failures back off inside supervise.
 */
import { existsSync } from 'node:fs'
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitJson, narrate } from '../output.ts'
import { type Conn, readEnv, resolveConn } from '../resolve.ts'
import { codespacesPath, loadCodespaces } from './store.ts'
import { resolveUpPlan, superviseCodespace, type UpPlan } from './up.ts'

export interface ReconcilePlan {
	targets: Array<{ workspaceFolder: string; plan: UpPlan; conn: Conn }>
	skipped: Array<{ workspaceFolder: string; reason: string }>
}

/** Walk the store; resolve a full (conn, UpPlan) per healthy desired-up entry.
 *  Conn is pinned to each record's OWN canvasUrl (a boot-time reconcile has no
 *  flags/env url) — creds overlay from hosts.toml/env exactly as everywhere. */
export async function planReconcile(env: NodeJS.ProcessEnv): Promise<ReconcilePlan> {
	const store = loadCodespaces(codespacesPath(env))
	const targets: ReconcilePlan['targets'] = []
	const skipped: ReconcilePlan['skipped'] = []
	for (const [workspaceFolder, rec] of Object.entries(store.codespaces)) {
		if (rec.desired !== 'up') continue
		if (!existsSync(workspaceFolder)) {
			skipped.push({ workspaceFolder, reason: 'checkout missing' })
			continue
		}
		try {
			const conn = resolveConn({ url: rec.canvasUrl }, readEnv(env), loadHosts(hostsPath(env)))
			const plan = await resolveUpPlan(conn, workspaceFolder, env, { removeExisting: false })
			targets.push({ workspaceFolder, plan, conn })
		} catch (err) {
			skipped.push({ workspaceFolder, reason: (err as Error).message })
		}
	}
	return { targets, skipped }
}

export async function codespaceReconcile(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	if (args.length > 0) throw new CliError(`unknown codespace reconcile flag: ${args[0]}`, 2)
	const plan = await planReconcile(env)
	if (globals.dryRun) {
		// conn carries the live token pair — print only the redacted parts.
		emitJson({ targets: plan.targets.map(({ workspaceFolder, plan }) => ({ workspaceFolder, plan })), skipped: plan.skipped })
		return 0
	}
	for (const s of plan.skipped) narrate(`ensembleworks: reconcile skipping ${s.workspaceFolder} — ${s.reason}`)
	if (plan.targets.length === 0) {
		narrate('ensembleworks: reconcile — nothing desired up; done')
		return 0
	}
	narrate(`ensembleworks: reconciling ${plan.targets.length} codespace(s): ${plan.targets.map((t) => t.plan.gatewayId).join(', ')}`)
	const ac = new AbortController()
	const onSignal = () => ac.abort()
	process.once('SIGINT', onSignal)
	process.once('SIGTERM', onSignal)
	try {
		// One loop per codespace, all under the one signal (decision #2). Each
		// supervise absorbs its own failures — one broken codespace must never
		// take the others down; catch is belt-and-braces for non-cycle throws.
		await Promise.all(
			plan.targets.map((t) =>
				superviseCodespace(t.plan, t.conn, env, ac.signal).catch((err) =>
					narrate(`ensembleworks: reconcile loop for ${t.plan.gatewayId} ended: ${(err as Error).message}`),
				),
			),
		)
	} finally {
		process.off('SIGINT', onSignal)
		process.off('SIGTERM', onSignal)
	}
	narrate('ensembleworks: reconcile stopped')
	return 0
}
