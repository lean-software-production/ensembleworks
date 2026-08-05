/**
 * `ew codespace list` (decision #7): the store's entries as a table (or raw
 * records under --json), with an optional --live probe of the canvas's
 * GET /api/terminal/list marking which gateways are currently registered.
 * The probe needs a resolvable instance; the plain listing never does.
 */
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitJson, emitTable } from '../output.ts'
import { authHeaders, readEnv, resolveConn } from '../resolve.ts'
import { codespacesPath, loadCodespaces, type CodespacesFile } from './store.ts'

/** Pure row rendering; appends a LIVE column only when liveIds is supplied. */
export function renderListRows(store: CodespacesFile, liveIds?: Set<string>): string[][] {
	return Object.entries(store.codespaces).map(([dir, r]) => {
		const row = [
			r.gatewayId,
			r.branch ? `${r.repo}@${r.branch}` : r.repo,
			r.containerId?.slice(0, 12) ?? '-',
			r.canvasUrl,
			dir,
		]
		if (liveIds) row.push(liveIds.has(r.gatewayId) ? 'yes' : 'no')
		return row
	})
}

export async function codespaceList(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	let live = false
	for (const a of args) {
		if (a === '--live') live = true
		else throw new CliError(`unknown codespace list flag: ${a}`, 2)
	}
	const store = loadCodespaces(codespacesPath(env))
	let liveIds: Set<string> | undefined
	if (live) {
		const conn = resolveConn({ url: globals.url, room: globals.room }, readEnv(env), loadHosts(hostsPath(env)))
		const res = await fetch(new URL('/api/terminal/list', conn.url), { headers: authHeaders(conn.auth) })
		if (!res.ok) throw new CliError(`GET /api/terminal/list → ${res.status}`, 1)
		const body = (await res.json()) as { gateways?: Array<{ gatewayId: string }> }
		liveIds = new Set((body.gateways ?? []).map((g) => g.gatewayId))
	}
	if (globals.json) {
		emitJson(liveIds ? { codespaces: store.codespaces, live: [...liveIds] } : store.codespaces)
		return 0
	}
	const headers = ['GATEWAY', 'REPO', 'CONTAINER', 'CANVAS', 'DIR']
	if (liveIds) headers.push('LIVE')
	emitTable(headers, renderListRows(store, liveIds))
	return 0
}
