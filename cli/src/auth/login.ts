/**
 * `auth login` (spec §8.1): acquire url → method → (for service-token) the CF
 * dashboard token pair → verify via GET /api/whoami (expect a non-null identity)
 * → default room → store the [instances."<url>"] record 0600 and set it as
 * default_instance. Flags make it fully scriptable for CI; missing values are
 * prompted (secret without echo). credentialAcquire isolates the paste path so
 * a future --mint flow (charter seam) slots in without touching verify/store.
 */
import type { Whoami } from '@ensembleworks/contracts'
import { CliError } from '../errors.ts'
import { hostsPath, type InstanceRecord, loadHosts, saveHosts, setInstance } from '../hosts.ts'
import { toRequestUrl } from '../http.ts'
import { narrate } from '../output.ts'
import { ask, askSecret } from './prompt.ts'
import { type Auth, authHeaders } from '../resolve.ts'

export interface LoginFlags {
	url?: string
	room?: string
	method?: 'service-token' | 'none'
	tokenId?: string
	tokenSecret?: string
}

export async function login(flags: LoginFlags, env: NodeJS.ProcessEnv): Promise<number> {
	const url = flags.url ?? (await ask('instance url: '))
	if (!url) throw new CliError('auth login requires a url (--url or the prompt)', 2)
	const method = (flags.method ?? (await ask('method [service-token/none] (none): ', 'none'))) as 'service-token' | 'none'

	const auth = await credentialAcquire(method, flags)
	const who = await verifyWhoami(url, auth)
	if (auth.method === 'service-token' && who.identity === null) {
		narrate('warning: the token pair resolved to an anonymous identity — the pair may be wrong or the URL is a "none" instance')
	}
	narrate(`resolved identity: ${who.identity ?? '(anonymous)'} [${who.kind} via ${who.via}]`)

	const defaultRoom = flags.room ?? (await ask('default room (team): ', 'team'))

	const rec: InstanceRecord = { method, default_room: defaultRoom }
	if (auth.method === 'service-token') {
		rec.token_id = auth.tokenId
		rec.token_secret = auth.tokenSecret
	}
	if (who.identity) rec.identity = who.identity

	const file = hostsPath(env)
	saveHosts(file, setInstance(loadHosts(file), url, rec))
	narrate(`saved ${url} → ${file} (now the default instance)`)
	return 0
}

async function credentialAcquire(method: 'service-token' | 'none', flags: LoginFlags): Promise<Auth> {
	if (method !== 'service-token') return { method: 'none' }
	const tokenId = flags.tokenId ?? (await ask('CF-Access-Client-Id: '))
	const tokenSecret = flags.tokenSecret ?? (await askSecret('CF-Access-Client-Secret: '))
	if (!tokenId || !tokenSecret) throw new CliError('service-token login needs both a token id and secret', 2)
	return { method: 'service-token', tokenId, tokenSecret }
}

async function verifyWhoami(url: string, auth: Auth): Promise<Whoami> {
	const target = toRequestUrl(url, '/api/whoami')
	let res: Response
	try {
		res = await fetch(target, { headers: authHeaders(auth) })
	} catch (err) {
		throw new CliError(`could not reach ${target.origin}: ${(err as Error).message}`)
	}
	if (!res.ok) throw new CliError(`verify failed: GET /api/whoami → ${res.status}`)
	return (await res.json()) as Whoami
}
