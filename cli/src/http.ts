/**
 * The HTTP transport: joins a request path onto the resolved instance URL,
 * attaches the CF Access pair for service-token instances, and returns the raw
 * status + body (never throwing on non-2xx — the caller decides, so a roadmap
 * 409 body reaches stdout). toRequestUrl is the security seam: it REFUSES any
 * path that is not a same-origin, /-rooted relative path, so a poisoned
 * manifest-cache entry (absolute URL, protocol-relative //host, or a non-rooted
 * path) can never be joined and thus never receive the auth headers (§8).
 */
import { CliError } from './errors.ts'
import { authHeaders, type Conn } from './resolve.ts'

export interface Req {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE'
	path: string
	query?: Record<string, unknown>
	json?: Record<string, unknown>
}

export interface HttpResult {
	status: number
	body: string
}

/** Join `path` onto `base`, rejecting anything that is not a same-origin
 *  /-rooted relative path. `hint` (a cache-file path) is named in the error so a
 *  poisoned cache is diagnosable. Pure — throws BEFORE any request is built. */
export function toRequestUrl(base: string, path: string, hint = ''): URL {
	const baseUrl = base.endsWith('/') ? base : `${base}/`
	const bad = () =>
		new CliError(
			`refusing request to non-same-origin path ${JSON.stringify(path)}` +
				(hint ? ` (poisoned manifest cache: ${hint})` : ''),
			2,
		)
	// WHATWG URL treats \ as / for http(s), so `/\evil.com` would resolve
	// cross-origin past a plain //-prefix check — reject backslashes outright,
	// then gate definitively on the resolved origin.
	if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw bad()
	const url = new URL(path, baseUrl)
	if (url.origin !== new URL(baseUrl).origin) throw bad()
	return url
}

export async function request(conn: Conn, req: Req, hint = ''): Promise<HttpResult> {
	const url = toRequestUrl(conn.url, req.path, hint)
	if (req.query) {
		for (const [k, v] of Object.entries(req.query)) {
			if (v === undefined || v === null) continue
			url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v))
		}
	}
	const headers: Record<string, string> = { ...authHeaders(conn.auth) }
	let body: string | undefined
	if (req.json !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(req.json)
	}
	let res: Response
	try {
		res = await fetch(url, { method: req.method, headers, body })
	} catch (err) {
		throw new CliError(`request to ${url.origin} failed: ${(err as Error).message}`)
	}
	return { status: res.status, body: await res.text() }
}
