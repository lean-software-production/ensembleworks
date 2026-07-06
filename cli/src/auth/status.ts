/** `auth status`: for the resolved instance (or every configured instance when
 *  no --url), GET /api/whoami and print a table (url · reachable · identity ·
 *  kind · via); --json emits the raw results array. */
import type { Whoami } from '@ensembleworks/contracts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { toRequestUrl } from '../http.ts'
import { emitJson, emitTable } from '../output.ts'
import { type Auth, authHeaders } from '../resolve.ts'

export interface StatusFlags {
	url?: string
	json: boolean
}

interface Row {
	url: string
	reachable: boolean
	whoami: Whoami | null
}

export async function status(flags: StatusFlags, env: NodeJS.ProcessEnv): Promise<number> {
	const hosts = loadHosts(hostsPath(env))
	const urls = flags.url ? [flags.url] : Object.keys(hosts.instances)
	if (urls.length === 0) {
		process.stderr.write('no instances configured — run `ensembleworks auth login`\n')
		return 1
	}
	const rows: Row[] = []
	for (const url of urls) {
		const rec = hosts.instances[url]
		const auth: Auth =
			rec?.method === 'service-token' && rec.token_id && rec.token_secret
				? { method: 'service-token', tokenId: rec.token_id, tokenSecret: rec.token_secret }
				: { method: 'none' }
		rows.push(await probe(url, auth))
	}
	if (flags.json) {
		emitJson(rows.map((r) => ({ url: r.url, reachable: r.reachable, ...(r.whoami ?? {}) })))
		return 0
	}
	emitTable(
		['URL', 'REACHABLE', 'IDENTITY', 'KIND', 'VIA'],
		rows.map((r) => [r.url, String(r.reachable), r.whoami?.identity ?? '—', r.whoami?.kind ?? '—', r.whoami?.via ?? '—']),
	)
	return rows.every((r) => r.reachable) ? 0 : 1
}

async function probe(url: string, auth: Auth): Promise<Row> {
	try {
		const res = await fetch(toRequestUrl(url, '/api/whoami'), { headers: authHeaders(auth) })
		if (!res.ok) return { url, reachable: false, whoami: null }
		return { url, reachable: true, whoami: (await res.json()) as Whoami }
	} catch {
		return { url, reachable: false, whoami: null }
	}
}
