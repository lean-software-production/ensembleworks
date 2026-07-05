/**
 * Cloudflare Access identity.
 *
 * The deployment sits behind Cloudflare Access (the auth boundary — see
 * ../../README.md "Security model"). Access authenticates every user via the
 * org's GitHub IdP and injects their identity into each origin request:
 *   - Cf-Access-Authenticated-User-Email : the verified email
 *   - Cf-Access-Jwt-Assertion            : a signed JWT carrying the same claims
 *
 * We use that verified identity to attribute git co-authors — the GitHub email
 * is what GitHub matches `Co-authored-by` trailers on. This module turns request
 * headers into an AccessIdentity. Three modes, by configuration:
 *
 *   verified : CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD set → verify the JWT's
 *              signature/aud/exp against the team's JWKS. A forged header is
 *              rejected. This is the production posture.
 *   header   : neither set → trust the Cf-Access email header. Safe ONLY because
 *              the box has no inbound ports and is reachable only via the tunnel
 *              (Cloudflare overwrites that header), so nothing can forge it. This
 *              is the default until CF_ACCESS_* are configured.
 *   dev      : no Cf-Access headers at all (local / Codespaces bypass Access) →
 *              fall back to EW_DEV_IDENTITY_EMAIL if set, else null.
 *
 * Env is read per call (not cached at import) so it stays easy to test.
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export interface AccessIdentity {
	email: string
	name?: string
	verified: boolean
}

const EMAIL_HEADER = 'cf-access-authenticated-user-email'
const JWT_HEADER = 'cf-access-jwt-assertion'

function cfg() {
	return {
		teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN, // e.g. lean-software.cloudflareaccess.com
		aud: process.env.CF_ACCESS_AUD, // the Access application's AUD tag
		devEmail: process.env.EW_DEV_IDENTITY_EMAIL,
		devName: process.env.EW_DEV_IDENTITY_NAME,
	}
}

export function accessVerificationEnabled(): boolean {
	const { teamDomain, aud } = cfg()
	return Boolean(teamDomain && aud)
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
	const v = headers[name]
	return Array.isArray(v) ? v[0] : v
}

function b64urlToBuf(s: string): Buffer {
	return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}
function b64urlToJson(s: string): any {
	return JSON.parse(b64urlToBuf(s).toString('utf8'))
}

// --- JWKS cache (verified mode) ----------------------------------------------
// Cloudflare publishes the Access signing keys at <team>/cdn-cgi/access/certs.
let jwksCache: { keys: any[]; fetchedAt: number } | null = null
const JWKS_TTL_MS = 10 * 60 * 1000

async function getJwk(teamDomain: string, kid: string): Promise<any | null> {
	const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
	if (!fresh) {
		const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
		if (!res.ok) throw new Error(`Access JWKS fetch failed: ${res.status}`)
		const body = (await res.json()) as { keys?: any[] }
		jwksCache = { keys: body.keys ?? [], fetchedAt: Date.now() }
	}
	const jwk = jwksCache!.keys.find((k) => k.kid === kid)
	if (!jwk && fresh) {
		// Unknown kid on a cached set — keys may have rotated; refetch once.
		jwksCache = null
		return getJwk(teamDomain, kid)
	}
	return jwk ?? null
}

// Verify a Cf-Access-Jwt-Assertion and return its identity claims (email for
// humans, common_name for service tokens), or null if the token is malformed /
// unsigned-by-us / expired / wrong-audience / carries no identity claim.
export async function verifyCfAccessClaims(
	token: string,
): Promise<{ email?: string; commonName?: string } | null> {
	const { teamDomain, aud } = cfg()
	if (!teamDomain) return null
	const parts = token.split('.')
	if (parts.length !== 3) return null
	const [h, p, s] = parts as [string, string, string]
	const head = b64urlToJson(h)
	if (head.alg !== 'RS256' || typeof head.kid !== 'string') return null
	const jwk = await getJwk(teamDomain, head.kid)
	if (!jwk) return null
	const key = createPublicKey({ key: jwk, format: 'jwk' })
	if (!cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64urlToBuf(s))) return null
	const payload = b64urlToJson(p)
	const now = Math.floor(Date.now() / 1000)
	if (typeof payload.exp === 'number' && payload.exp < now) return null
	if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null
	if (payload.iss && payload.iss !== `https://${teamDomain}`) return null
	const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
	if (aud && !auds.includes(aud)) return null
	const email = typeof payload.email === 'string' ? payload.email : undefined
	const commonName = typeof payload.common_name === 'string' ? payload.common_name : undefined
	if (!email && !commonName) return null
	return { email, commonName }
}

// Decode a Cf-Access-Jwt-Assertion's identity claims WITHOUT verifying its
// signature — used only in header-trust mode, the same tunnel trust basis as
// reading the Cf-Access-Authenticated-User-Email header. Returns null for a
// malformed token or one carrying no identity claim.
export function decodeCfAccessClaimsUnverified(
	token: string,
): { email?: string; commonName?: string } | null {
	const parts = token.split('.')
	if (parts.length !== 3) return null
	try {
		const payload = b64urlToJson(parts[1] as string)
		const email = typeof payload.email === 'string' ? payload.email : undefined
		const commonName = typeof payload.common_name === 'string' ? payload.common_name : undefined
		if (!email && !commonName) return null
		return { email, commonName }
	} catch {
		return null
	}
}

function devFallback(): AccessIdentity | null {
	const { devEmail, devName } = cfg()
	return devEmail ? { email: devEmail, name: devName, verified: false } : null
}

// Resolve the caller's verified identity from request headers, or null.
export async function getAccessIdentity(headers: IncomingHttpHeaders): Promise<AccessIdentity | null> {
	if (accessVerificationEnabled()) {
		const jwt = header(headers, JWT_HEADER)
		if (!jwt) return devFallback() // no assertion to verify (e.g. local dev)
		try {
			const c = await verifyCfAccessClaims(jwt)
			if (c?.email) return { email: c.email, verified: true }
		} catch (err) {
			console.warn('[access] JWT verification error', err)
		}
		return null // configured but unverifiable → reject; never trust the header here
	}

	// Header-trust mode (verification not configured).
	const email = header(headers, EMAIL_HEADER)
	if (email) return { email, verified: false }
	return devFallback()
}
