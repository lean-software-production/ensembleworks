/**
 * seedNameFromWhoami + identityOnce — the client half of the Access identity
 * binding (issue #55 Problem 1, docs/superpowers/specs/2026-07-26-access-
 * identity-binding-design.md). Run: bun client/src/identity.test.ts
 *
 * identity.ts touches localStorage only inside functions, but the shim is still
 * installed before the dynamic import so nothing can read a missing global at
 * module scope. `fetch` is stubbed per case — no network.
 */
import assert from 'node:assert/strict'

const NAME_KEY = 'ensembleworks.userName'

class MemoryStorage {
	private store = new Map<string, string>()
	getItem(key: string): string | null {
		return this.store.has(key) ? this.store.get(key)! : null
	}
	setItem(key: string, value: string): void {
		this.store.set(key, String(value))
	}
	removeItem(key: string): void {
		this.store.delete(key)
	}
	clear(): void {
		this.store.clear()
	}
	get length(): number {
		return this.store.size
	}
	key(index: number): string | null {
		return [...this.store.keys()][index] ?? null
	}
}

;(globalThis as { localStorage?: Storage }).localStorage ??= new MemoryStorage() as unknown as Storage

const { seedNameFromWhoami, identityOnce } = await import('./identity')

const realFetch = globalThis.fetch
let calls = 0
function stubFetch(impl: () => Promise<unknown>): void {
	calls = 0
	globalThis.fetch = (async () => {
		calls++
		return await impl()
	}) as unknown as typeof fetch
}
const json = (body: unknown) => async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

// An SSO human seeds the name — this is the whole point: presence names and
// server logs then agree on who someone is.
localStorage.clear()
stubFetch(json({ identity: 'David Laing', kind: 'human', via: 'sso' }))
await seedNameFromWhoami()
assert.equal(localStorage.getItem(NAME_KEY), 'David Laing', 'human whoami seeds the display name')

// A name the user already chose wins, and costs no request at all.
localStorage.clear()
localStorage.setItem(NAME_KEY, 'Dave')
stubFetch(json({ identity: 'David Laing', kind: 'human', via: 'sso' }))
await seedNameFromWhoami()
assert.equal(localStorage.getItem(NAME_KEY), 'Dave', 'an existing name is never overwritten')
assert.equal(calls, 0, 'no whoami request when the name is already set')

// Anonymous (local dev bypasses Access) leaves the name unset so getIdentity's
// prompt still runs.
localStorage.clear()
stubFetch(json({ identity: null, kind: 'anonymous', via: 'none' }))
await seedNameFromWhoami()
assert.equal(localStorage.getItem(NAME_KEY), null, 'anonymous whoami seeds nothing')

// A bot identity is not a display name for a human session.
localStorage.clear()
stubFetch(json({ identity: '🤖 relay', kind: 'bot', via: 'service-token' }))
await seedNameFromWhoami()
assert.equal(localStorage.getItem(NAME_KEY), null, 'bot whoami seeds nothing')

// Failures must never block startup or throw — the prompt is the fallback.
localStorage.clear()
stubFetch(async () => {
	throw new Error('offline')
})
await seedNameFromWhoami()
assert.equal(localStorage.getItem(NAME_KEY), null, 'a failed whoami seeds nothing and does not throw')

localStorage.clear()
stubFetch(async () => new Response('nope', { status: 500 }))
await seedNameFromWhoami()
assert.equal(localStorage.getItem(NAME_KEY), null, 'a non-200 whoami seeds nothing')

// A hung whoami is bounded — startup waits on it, so it cannot wait forever.
localStorage.clear()
stubFetch(
	() =>
		new Promise((_resolve, reject) => {
			// Never settles on its own; the abort signal must reject it.
			globalThis.setTimeout(() => reject(new Error('aborted')), 5_000)
		}),
)
const started = Date.now()
await seedNameFromWhoami()
assert.ok(Date.now() - started < 4_000, 'a hung whoami is abandoned, not awaited indefinitely')
assert.equal(localStorage.getItem(NAME_KEY), null, 'a timed-out whoami seeds nothing')

// identityOnce memoises, so a seeded name is read exactly once and the name
// prompt can never fire twice across the two module-scope call sites.
localStorage.clear()
localStorage.setItem(NAME_KEY, 'Dave')
const first = identityOnce()
assert.equal(first.name, 'Dave')
localStorage.setItem(NAME_KEY, 'Someone Else')
assert.equal(identityOnce(), first, 'identityOnce returns the same object on every call')

globalThis.fetch = realFetch
console.log('ok: identity seeding from /api/whoami')
