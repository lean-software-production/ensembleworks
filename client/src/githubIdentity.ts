/**
 * GitHub identity from Cloudflare Access — the first slice of the GitHub-keyed
 * canvas identity design (docs/superpowers/specs/2026-07-04-github-keyed-canvas-
 * identity-design.md).
 *
 * The deployment sits behind Cloudflare Access with the org's GitHub IdP. Access
 * exposes the signed-in user's identity at `/cdn-cgi/access/get-identity`
 * (relative, only reachable behind Access). A real payload capture confirmed it
 * carries the GitHub NUMERIC user id + display name + email, but NOT the GitHub
 * login/handle — so to auto-fill the avatar handle we read the numeric id here
 * and resolve id → login via the public GitHub API.
 *
 * Everything degrades cleanly OFF Access (local dev, Codespaces): get-identity
 * 404s → we return null and callers leave the manual field untouched.
 *
 * This module MUST stay free of tldraw and React imports so `extractGithubIdentity`
 * can be unit-tested under a bare `bun` script (the network helpers reference
 * fetch/localStorage only when called, so importing the module is still safe).
 */

/** A usable GitHub identity resolved from Access. `id` is namespaced (`github:<n>`)
 * to match the identity design's canonical key; `numericId` is the raw GitHub id
 * used for avatar-by-id and the id→login lookup. */
export interface GithubIdentity {
	id: string
	numericId: number
	name: string
}

/**
 * Pure extractor for a `/cdn-cgi/access/get-identity` payload. Returns a usable
 * GitHub identity only when the IdP is GitHub and the id is a positive integer
 * (the two fields the probe confirmed are reliably present); anything else —
 * a non-GitHub session, a service token, a malformed payload — is null, and the
 * caller falls back to the manual/local model. Missing name falls back to the id.
 */
export function extractGithubIdentity(payload: unknown): GithubIdentity | null {
	if (!payload || typeof payload !== 'object') return null
	const p = payload as { id?: unknown; name?: unknown; idp?: { type?: unknown } | null }
	if (!p.idp || typeof p.idp !== 'object' || p.idp.type !== 'github') return null
	if (typeof p.id !== 'number' || !Number.isInteger(p.id) || p.id <= 0) return null
	const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `github:${p.id}`
	return { id: `github:${p.id}`, numericId: p.id, name }
}

const GET_IDENTITY_URL = '/cdn-cgi/access/get-identity'

/**
 * Fetch the caller's GitHub identity from Cloudflare Access, or null. Bounded by
 * `timeoutMs` so canvas startup never blocks on it; any non-200 / network error /
 * timeout / non-GitHub payload resolves to null (the off-Access path).
 */
export async function fetchAccessGithubIdentity(timeoutMs = 1500): Promise<GithubIdentity | null> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), timeoutMs)
	try {
		const res = await fetch(GET_IDENTITY_URL, { signal: ctrl.signal, credentials: 'include' })
		if (!res.ok) return null
		return extractGithubIdentity(await res.json())
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}

const LOGIN_CACHE_PREFIX = 'ensembleworks.githubLogin.'

/**
 * Resolve a GitHub numeric id to its login (handle) via the public GitHub API,
 * or null. The result is cached in localStorage per id so we hit the API at most
 * once per person per browser — the unauthenticated API is rate-limited (60/hr
 * per IP), and a shared office IP could otherwise exhaust it. Bounded timeout;
 * any failure is null (caller leaves the field empty, retries a later load).
 */
export async function resolveGithubLogin(numericId: number, timeoutMs = 2500): Promise<string | null> {
	const cacheKey = LOGIN_CACHE_PREFIX + numericId
	try {
		const cached = localStorage.getItem(cacheKey)
		if (cached) return cached
	} catch {
		// localStorage unavailable — just skip the cache and hit the API.
	}
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), timeoutMs)
	try {
		const res = await fetch(`https://api.github.com/user/${numericId}`, {
			signal: ctrl.signal,
			headers: { Accept: 'application/vnd.github+json' },
		})
		if (!res.ok) return null
		const body = (await res.json()) as { login?: unknown }
		const login = typeof body.login === 'string' && body.login.trim() ? body.login.trim() : null
		if (login) {
			try {
				localStorage.setItem(cacheKey, login)
			} catch {
				// Non-persistent cache is fine — we just re-resolve next session.
			}
		}
		return login
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}
