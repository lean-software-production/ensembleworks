/**
 * `auth login` (auth design doc §1 + spec §8.1): resolve url → resolve METHOD
 * (explicit --method wins; otherwise PROBE the origin — behind Access ⇒ the
 * browser leg, plain 200 ⇒ none; the URL is the only thing the user ever
 * types) → acquire credentials → verify via GET /api/whoami → store the
 * [instances."<url>"] record 0600 and make it default_instance.
 * service-token/none paths are byte-compatible with the pre-SP5 CLI (minus
 * the removed interactive method prompt — probe replaces it).
 */
import type { Whoami } from '@ensembleworks/contracts'
import { CliError } from '../errors.ts'
import { hostsPath, type InstanceRecord, loadHosts, saveHosts, setInstance } from '../hosts.ts'
import { toRequestUrl } from '../http.ts'
import { narrate } from '../output.ts'
import { ask, askSecret } from './prompt.ts'
import { type Auth, authHeaders } from '../resolve.ts'
import { type AccessDeps, browserLogin, jwtEmail, probeAccess, type ProbeResult, realAccessDeps } from './access.ts'

export interface LoginFlags {
	url?: string
	room?: string
	method?: 'service-token' | 'none' | 'access-browser'
	tokenId?: string
	tokenSecret?: string
}

export async function login(flags: LoginFlags, env: NodeJS.ProcessEnv, deps: AccessDeps = realAccessDeps()): Promise<number> {
	const url = flags.url ?? (await ask('instance url: '))
	if (!url) throw new CliError('auth login requires a url (--url or the prompt)', 2)

	// Method resolution (design §1): explicit flag wins; else probe.
	let probe: ProbeResult | undefined
	let method = flags.method
	if (!method) {
		probe = await probeAccess(url, deps)
		if (probe.kind === 'access') {
			method = 'access-browser'
			narrate(`probe: behind Cloudflare Access (team ${probe.teamDomain})`)
		} else {
			method = 'none'
			narrate('probe: no auth boundary — storing auth = none')
		}
	}

	if (method === 'access-browser') {
		probe ??= await probeAccess(url, deps)
		if (probe.kind !== 'access') throw new CliError(`--method access-browser, but ${url} is not behind Cloudflare Access`, 2)
		return accessBrowserLogin(url, probe, flags, env, deps)
	}

	const auth = await credentialAcquire(method, flags)
	const who = await verifyWhoami(url, auth, deps)
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

/** The browser leg (design §1 steps 2-3): browserLogin → verify → store the
 *  org token (credential) + app token (cache) + team/aud (probe facts). */
async function accessBrowserLogin(
	url: string,
	probe: { teamDomain: string; aud: string },
	flags: LoginFlags,
	env: NodeJS.ProcessEnv,
	deps: AccessDeps,
): Promise<number> {
	const res = await browserLogin(url, probe, deps)
	const auth: Auth = { method: 'access', appToken: res.appToken }
	const who = await verifyWhoami(url, auth, deps)
	const identity = who.identity ?? jwtEmail(res.appToken)
	narrate(`✓ logged in as ${identity ?? '(anonymous)'} [${who.kind} via ${who.via}]`)

	const defaultRoom = flags.room ?? (await ask('default room (team): ', 'team'))
	const rec: InstanceRecord = {
		method: 'access-browser',
		org_token: res.orgToken,
		app_token: res.appToken,
		team_domain: res.teamDomain,
		aud: res.aud,
		default_room: defaultRoom,
	}
	if (identity) rec.identity = identity

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

async function verifyWhoami(url: string, auth: Auth, deps: Pick<AccessDeps, 'fetch'>): Promise<Whoami> {
	const target = toRequestUrl(url, '/api/whoami')
	let res: Response
	try {
		res = await deps.fetch(target, { headers: authHeaders(auth) })
	} catch (err) {
		throw new CliError(`could not reach ${target.origin}: ${(err as Error).message}`)
	}
	if (!res.ok) throw new CliError(`verify failed: GET /api/whoami → ${res.status}`)
	return (await res.json()) as Whoami
}
