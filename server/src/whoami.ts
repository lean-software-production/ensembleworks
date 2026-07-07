/**
 * Resolve the caller's identity envelope for GET /api/whoami. Composes the
 * existing CF Access human path (access-identity.ts — verified/header/dev) with
 * the service-token bot path (service-tokens.ts), keyed by the token's
 * common_name. Additive: it enforces nothing; later slices reuse this same
 * resolution to stamp attribution and scope writes.
 */
import type { IncomingHttpHeaders } from 'node:http'
import type { Whoami } from '@ensembleworks/contracts'
import {
	accessVerificationEnabled,
	decodeCfAccessClaimsUnverified,
	getAccessIdentity,
	verifyCfAccessClaims,
} from './access-identity.ts'
import { lookupServiceToken } from './service-tokens.ts'

const JWT_HEADER = 'cf-access-jwt-assertion'

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
	const v = headers[name]
	return Array.isArray(v) ? v[0] : v
}

// Extract the CF Access service-token common_name from the request headers
// (verified in verified mode; decoded-unverified in header-trust mode — the same
// tunnel trust basis as the Cf-Access-…-Email header). Shared by resolveCaller
// and resolveWriteScope.
async function serviceTokenCommonName(headers: IncomingHttpHeaders): Promise<string | undefined> {
	const jwt = header(headers, JWT_HEADER)
	if (!jwt) return undefined
	if (accessVerificationEnabled()) {
		try {
			return (await verifyCfAccessClaims(jwt))?.commonName
		} catch {
			return undefined
		}
	}
	return decodeCfAccessClaimsUnverified(jwt)?.commonName
}

export async function resolveCaller(headers: IncomingHttpHeaders): Promise<Whoami> {
	// 1. Human — the existing three-mode CF Access resolution (email present).
	const human = await getAccessIdentity(headers)
	if (human) return { identity: human.name ?? human.email, kind: 'human', via: 'sso' }

	// 2. Bot — a CF Access service token, keyed by its common_name.
	const commonName = await serviceTokenCommonName(headers)
	if (commonName) {
		const entry = lookupServiceToken(commonName)
		if (entry) return { identity: entry.identity, kind: 'bot', via: 'service-token' }
	}

	// 3. Anonymous.
	return { identity: null, kind: 'anonymous', via: 'none' }
}

/**
 * The caller's service-token write scope, or null if the caller is not a
 * recognised service token (a human, an anonymous caller, or an unknown/unmapped
 * token — all "open" for the write guard). Scope is an authz detail, kept out of
 * the Whoami identity envelope.
 */
export async function resolveWriteScope(
	headers: IncomingHttpHeaders,
): Promise<'read-only' | 'read-write' | null> {
	const commonName = await serviceTokenCommonName(headers)
	if (!commonName) return null
	return lookupServiceToken(commonName)?.scope ?? null
}

/**
 * The principal to bind a terminal-gateway registration to, or null to REJECT
 * the connect. accessVerificationEnabled() is the strict (production) switch:
 * strict instances require a real verified identity and reject anonymous / dev
 * fallbacks; non-strict (dev) instances synthesise a `dev` owner for an
 * otherwise anonymous caller. Prefixed so principals can't collide.
 */
export async function resolveGatewayOwner(headers: IncomingHttpHeaders): Promise<string | null> {
	const strict = accessVerificationEnabled()
	const human = await getAccessIdentity(headers)
	if (human) {
		if (strict && !human.verified) return null // dev/unverified identity in production
		return `sso:${human.email}`
	}
	const commonName = await serviceTokenCommonName(headers)
	if (commonName && lookupServiceToken(commonName)) return `token:${commonName}`
	// Anonymous — no resolvable identity.
	return strict ? null : 'dev'
}
