/**
 * Terminal WebSocket URL resolution. Undefined gateway → the existing
 * same-origin /api/terminal/ws path (unchanged). A gateway id → the relay
 * path, which lives under /api because prod Caddy routes /api/terminal/* to
 * the co-located gateway on :8789 while /api* reaches the sync server (spike
 * spec §1).
 */
export function buildTermWsUrl(
	loc: { protocol: string; host: string },
	sessionId: string,
	cols: number,
	rows: number,
	gateway?: string
): string {
	const proto = loc.protocol === 'https:' ? 'wss' : 'ws'
	if (gateway) {
		return `${proto}://${loc.host}/api/terminal/relay?session=${sessionId}&gateway=${encodeURIComponent(gateway)}&cols=${cols}&rows=${rows}`
	}
	return `${proto}://${loc.host}/api/terminal/ws?session=${sessionId}&cols=${cols}&rows=${rows}`
}

export function termWsUrl(
	sessionId: string,
	cols: number,
	rows: number,
	gateway?: string
): string {
	return buildTermWsUrl(location, sessionId, cols, rows, gateway)
}
