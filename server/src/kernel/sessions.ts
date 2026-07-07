import type { AccessIdentity } from '../access-identity.ts'

/**
 * SessionRegistry — per-room connection bookkeeping shared across feature
 * routers: active sync sessions per user, captured Access identities, and
 * latency samples. (Moved from app.ts's closure: sessionsByUser /
 * identitiesByUser / latencyByUser maps.)
 */
export interface SessionRegistry {
	sessionsByUser: Map<string, Map<string, Set<string>>>
	// Verified Cloudflare Access identity per connected user (roomId -> rawUserId
	// -> identity), captured at WS upgrade from the Cf-Access headers and read by
	// /api/participants. Cleared when the user's last session closes, so it only
	// ever covers currently-connected people.
	identitiesByUser: Map<string, Map<string, AccessIdentity>>
	// Most-recent client-measured round-trip per connected user (roomId ->
	// rawUserId -> { rtt ms, t }). Reported and read back via POST /api/av/pulse;
	// pruned by age on every read so it only ever reflects live participants.
	latencyByUser: Map<string, Map<string, { rtt: number; t: number }>>
}

export function createSessionRegistry(): SessionRegistry {
	return {
		sessionsByUser: new Map<string, Map<string, Set<string>>>(),
		identitiesByUser: new Map<string, Map<string, AccessIdentity>>(),
		latencyByUser: new Map<string, Map<string, { rtt: number; t: number }>>(),
	}
}
