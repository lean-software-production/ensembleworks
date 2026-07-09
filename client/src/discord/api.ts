/**
 * Client-side wrappers for the Discord bindings HTTP API (server milestone
 * B1/B2). Pure request builders are split out so they can be unit-tested
 * without touching the network; the async wrappers are thin fetch calls that
 * mirror the roadmap idiom (throw on non-ok so the UI can surface the error).
 *
 * `DiscordBinding` is duplicated locally rather than imported from
 * `@ensembleworks/contracts` — the contracts package does not re-export the
 * type from its root, so a local interface avoids a fragile deep import.
 */

export interface DiscordBinding {
	id: string
	room: string
	guildId: string
	channelId: string
	direction: 'in' | 'out'
	route: { handler: string; params: Record<string, unknown> }
	createdBy: string
	createdAt: number
}

export interface CreateBindingInput {
	room: string
	guildId: string
	channelId: string
	direction: 'in' | 'out'
	route: { handler: string; params: Record<string, unknown> }
}

// Pure request builders (unit-tested in api.test.ts).

export function bindingsUrl(room: string): string {
	return `/api/discord/bindings?${new URLSearchParams({ room }).toString()}`
}

export function deleteBindingUrl(id: string): string {
	return `/api/discord/bindings/${encodeURIComponent(id)}`
}

// Thin async wrappers (real fetch — not unit-tested).

export async function listBindings(room: string): Promise<DiscordBinding[]> {
	const res = await fetch(bindingsUrl(room))
	if (!res.ok) throw new Error(`server answered ${res.status}`)
	const body = (await res.json()) as { bindings?: DiscordBinding[] }
	return body.bindings ?? []
}

export async function createBinding(input: CreateBindingInput): Promise<void> {
	const res = await fetch('/api/discord/bindings', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	})
	if (!res.ok) throw new Error(`server answered ${res.status}`)
}

export async function deleteBinding(id: string): Promise<void> {
	const res = await fetch(deleteBindingUrl(id), { method: 'DELETE' })
	if (!res.ok) throw new Error(`server answered ${res.status}`)
}
