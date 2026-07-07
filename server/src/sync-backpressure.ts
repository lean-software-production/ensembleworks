/**
 * Backpressure thresholds for a /sync WebSocket's send buffer. A client that
 * can't drain its socket grows bufferedAmount without bound; unchecked, the
 * sync process eventually OOMs for EVERYONE (prod has no per-service MemoryMax).
 * Mirrors the terminal relay's BROWSER_BUFFER_LIMIT (gateway-registry.ts): warn
 * so it's visible, then close so a fresh reconnect gets a clean snapshot.
 */
export const SYNC_BUFFER_WARN = 1 * 1024 * 1024 // 1 MB
export const SYNC_BUFFER_CLOSE = 4 * 1024 * 1024 // 4 MB

export function classifyBackpressure(bufferedAmount: number): 'ok' | 'warn' | 'close' {
	if (bufferedAmount >= SYNC_BUFFER_CLOSE) return 'close'
	if (bufferedAmount >= SYNC_BUFFER_WARN) return 'warn'
	return 'ok'
}
