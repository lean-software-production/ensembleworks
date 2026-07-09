import type { ResolvedBinding } from './router.ts'

export interface BindingResolverOpts {
	syncBase: string
	ttlMs?: number // cache lifetime per channel; default 10_000
	fetchImpl?: typeof fetch // injectable for tests (optional; defaults to global fetch)
}

// Returns a resolveBinding(channelId) function for the Router. Caches per channel
// for ttlMs. On any fetch/parse error, returns [] (fail-safe — a server blip must
// not throw inside the gateway message handler).
export function makeBindingResolver(opts: BindingResolverOpts): (channelId: string) => Promise<ResolvedBinding[]> {
	const ttl = opts.ttlMs ?? 10_000
	const doFetch = opts.fetchImpl ?? fetch
	const cache = new Map<string, { at: number; bindings: ResolvedBinding[] }>()

	return async (channelId: string): Promise<ResolvedBinding[]> => {
		const hit = cache.get(channelId)
		if (hit && Date.now() - hit.at < ttl) return hit.bindings
		try {
			const res = await doFetch(`${opts.syncBase}/api/discord/resolve?channelId=${encodeURIComponent(channelId)}`)
			if (!res.ok) return hit?.bindings ?? []
			const body = (await res.json()) as { bindings?: Array<{ room: string; route: { handler: string; params: Record<string, unknown> } }> }
			const bindings: ResolvedBinding[] = (body.bindings ?? []).map((b) => ({ room: b.room, route: b.route }))
			cache.set(channelId, { at: Date.now(), bindings })
			return bindings
		} catch {
			return hit?.bindings ?? [] // fail-safe: reuse stale cache if present, else empty
		}
	}
}
