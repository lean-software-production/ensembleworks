/**
 * Client-side wrappers for the Discord bindings HTTP API (server milestone
 * B1/B2). Pure request builders are split out so they can be unit-tested
 * without touching the network; the async wrappers are thin fetch calls that
 * mirror the roadmap idiom (throw on non-ok so the UI can surface the error).
 */
import type { DiscordBinding } from '@ensembleworks/contracts'

export type { DiscordBinding }

// Derived from the contract so it can't drift: the fields a caller supplies
// on create (the server fills in id/createdBy/createdAt).
export type CreateBindingInput = Omit<DiscordBinding, 'id' | 'createdBy' | 'createdAt'>

// Pure request builders (unit-tested in api.test.ts).

export function bindingsUrl(room: string): string {
	return `/api/discord/bindings?${new URLSearchParams({ room }).toString()}`
}

export function deleteBindingUrl(id: string): string {
	// id is a query param (?id=), not a path segment: the server route is DELETE
	// /api/discord/bindings and the shared tool contract can't declare a `:id`
	// path (the CLI renderer never substitutes it).
	return `/api/discord/bindings?${new URLSearchParams({ id }).toString()}`
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
