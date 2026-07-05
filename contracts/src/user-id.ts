/**
 * tldraw presence stores userId as a prefixed TLUserId ("user:abc123");
 * LiveKit identities, server session maps and the pulse/latency wire all use
 * the raw form ("abc123"). Normalise to raw so the two planes join on one id.
 */
export function rawUserId(id: string | null | undefined): string {
	return (id ?? '').replace(/^user:/, '')
}
