/**
 * Resolve the scribe's sync-server connection from the environment. Clean break
 * (charter #6): the scribe reads ENSEMBLEWORKS_URL / ENSEMBLEWORKS_ROOM only —
 * the pre-cutover CANVAS_URL / CANVAS_ROOM names are gone, not aliased. Kept
 * pure (env in, config out) so the rename is unit-tested without a network.
 */
export interface ScribeEndpoint {
	/** Sync server base URL — token fetch + transcript POST. */
	url: string
	/** Room the scribe transcribes. */
	room: string
}

export function readScribeEndpoint(env: Record<string, string | undefined>): ScribeEndpoint {
	return {
		url: env.ENSEMBLEWORKS_URL ?? 'http://localhost:8788',
		room: env.ENSEMBLEWORKS_ROOM ?? 'team',
	}
}
