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

export async function resolveCaller(headers: IncomingHttpHeaders): Promise<Whoami> {
	// 1. Human — the existing three-mode CF Access resolution (email present).
	const human = await getAccessIdentity(headers)
	if (human) return { identity: human.name ?? human.email, kind: 'human', via: 'sso' }

	// 2. Bot — a CF Access service token, keyed by its common_name.
	const jwt = header(headers, JWT_HEADER)
	if (jwt) {
		let commonName: string | undefined
		if (accessVerificationEnabled()) {
			try {
				commonName = (await verifyCfAccessClaims(jwt))?.commonName
			} catch {
				commonName = undefined
			}
		} else {
			commonName = decodeCfAccessClaimsUnverified(jwt)?.commonName
		}
		if (commonName) {
			const entry = lookupServiceToken(commonName)
			if (entry) return { identity: entry.identity, kind: 'bot', via: 'service-token' }
		}
	}

	// 3. Anonymous.
	return { identity: null, kind: 'anonymous', via: 'none' }
}
