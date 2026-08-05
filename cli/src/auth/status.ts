/** `auth status`: for the resolved instance (or every configured instance when
 *  no --url), report a per-host STATE — ok / unreachable / credential expired
 *  (design §2's distinct state: an access-browser org token past exp, or an
 *  exchange the team domain refuses) — plus the whoami identity. --json emits
 *  the raw rows (state replaces the old reachable boolean). */
import type { Whoami } from '@ensembleworks/contracts'
import { hostsPath, type InstanceRecord, loadHosts } from '../hosts.ts'
import { toRequestUrl } from '../http.ts'
import { emitJson, emitTable } from '../output.ts'
import { type Auth, authHeaders } from '../resolve.ts'
import { type AccessDeps, jwtExpired, realAccessDeps } from './access.ts'
import { ensureFreshAppToken } from './fresh.ts'

export interface StatusFlags {
	url?: string
	json: boolean
}

export type HostState = 'ok' | 'unreachable' | 'credential expired'

interface Row {
	url: string
	state: HostState
	whoami: Whoami | null
}

export async function status(
	flags: StatusFlags,
	env: NodeJS.ProcessEnv,
	deps: Pick<AccessDeps, 'fetch' | 'now'> = realAccessDeps(),
): Promise<number> {
	const file = hostsPath(env)
	const hosts = loadHosts(file)
	const urls = flags.url ? [flags.url] : Object.keys(hosts.instances)
	if (urls.length === 0) {
		process.stderr.write('no instances configured — run `ensembleworks auth login`\n')
		return 1
	}
	const rows: Row[] = []
	for (const url of urls) rows.push(await probeOne(file, url, hosts.instances[url], deps))
	if (flags.json) {
		emitJson(rows.map((r) => ({ url: r.url, state: r.state, ...(r.whoami ?? {}) })))
		return rows.every((r) => r.state === 'ok') ? 0 : 1
	}
	emitTable(
		['URL', 'STATE', 'IDENTITY', 'KIND', 'VIA'],
		rows.map((r) => [r.url, r.state, r.whoami?.identity ?? '—', r.whoami?.kind ?? '—', r.whoami?.via ?? '—']),
	)
	return rows.every((r) => r.state === 'ok') ? 0 : 1
}

async function probeOne(
	file: string,
	url: string,
	rec: InstanceRecord | undefined,
	deps: Pick<AccessDeps, 'fetch' | 'now'>,
): Promise<Row> {
	let auth: Auth = { method: 'none' }
	if (rec?.method === 'service-token' && rec.token_id && rec.token_secret) {
		auth = { method: 'service-token', tokenId: rec.token_id, tokenSecret: rec.token_secret }
	} else if (rec?.method === 'access-browser' && rec.org_token) {
		// Credential health first, locally: an expired org token is 'credential
		// expired' — a distinct state, never a generic unreachable (design §2).
		if (jwtExpired(rec.org_token, deps.now())) return { url, state: 'credential expired', whoami: null }
		try {
			auth = { method: 'access', appToken: await ensureFreshAppToken(file, url, deps) }
		} catch {
			return { url, state: 'credential expired', whoami: null }
		}
	}
	try {
		const res = await deps.fetch(toRequestUrl(url, '/api/whoami'), { headers: authHeaders(auth) })
		if (!res.ok) return { url, state: 'unreachable', whoami: null }
		return { url, state: 'ok', whoami: (await res.json()) as Whoami }
	} catch {
		return { url, state: 'unreachable', whoami: null }
	}
}
