/**
 * The async layer between hosts.toml and a live connection (SP5): pure
 * resolveConn cannot mint (network), so callers that need real credentials go
 * through resolveConnFresh — which upgrades an access-browser record into
 * { method: 'access', appToken } by reusing the cached app_token while it has
 * ≥2 min left, else minting via exchangeOrgToken and persisting the new cache.
 * refreshConnAuth is the SP2 supervisor's per-(re)spawn seam: token refresh =
 * re-exec with fresh env (decision-log SP5 #3).
 */
import { hostsPath, loadHosts, saveHosts } from '../hosts.ts'
import { CliError } from '../errors.ts'
import { type Conn, type Flags, readEnv, resolveConn } from '../resolve.ts'
import { type AccessDeps, exchangeOrgToken, jwtExpired, realAccessDeps } from './access.ts'

/** Cached-app-token freshness margin: don't hand out a token about to die
 *  mid-request/mid-dial. */
const APP_TOKEN_MIN_LEFT_MS = 120_000

type FreshDeps = Pick<AccessDeps, 'fetch' | 'now'>

/** Return a fresh app token for the access-browser instance at `url`,
 *  minting + persisting through `file` when the cache is stale. */
export async function ensureFreshAppToken(file: string, url: string, deps: FreshDeps): Promise<string> {
	const hosts = loadHosts(file)
	const rec = hosts.instances[url]
	if (!rec || rec.method !== 'access-browser' || !rec.org_token) {
		throw new CliError(`${url} is not a logged-in access-browser instance — run \`ew auth login\``, 2)
	}
	if (rec.app_token && !jwtExpired(rec.app_token, deps.now(), APP_TOKEN_MIN_LEFT_MS)) return rec.app_token
	const appToken = await exchangeOrgToken(url, rec.org_token, deps)
	hosts.instances[url] = { ...rec, app_token: appToken }
	saveHosts(file, hosts)
	return appToken
}

/** resolveConn + silent minting: flags/env win exactly as before; only a
 *  file-record access-browser instance (which pure resolveConn leaves at
 *  'none') gets upgraded here. */
export async function resolveConnFresh(flags: Flags, env: NodeJS.ProcessEnv, deps: FreshDeps = realAccessDeps()): Promise<Conn> {
	const file = hostsPath(env)
	const hosts = loadHosts(file)
	const conn = resolveConn(flags, readEnv(env), hosts)
	if (conn.auth.method !== 'none') return conn
	const rec = hosts.instances[conn.url]
	if (rec?.method === 'access-browser' && rec.org_token) {
		return { ...conn, auth: { method: 'access', appToken: await ensureFreshAppToken(file, conn.url, deps) } }
	}
	return conn
}

/** Per-(re)spawn refresh for supervisors (SP2 codespace up): re-derive the
 *  auth from disk so every connector exec gets a token with a full lifetime.
 *  Non-access-browser instances pass through untouched. */
export async function refreshConnAuth(conn: Conn, env: NodeJS.ProcessEnv, deps: FreshDeps = realAccessDeps()): Promise<Conn> {
	const file = hostsPath(env)
	const rec = loadHosts(file).instances[conn.url]
	if (rec?.method !== 'access-browser' || !rec.org_token) return conn
	return { ...conn, auth: { method: 'access', appToken: await ensureFreshAppToken(file, conn.url, deps) } }
}
