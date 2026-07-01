/**
 * Shared HTTP client for the in-process API tests: JSON-in/JSON-out wrappers
 * around fetch, bound to the ephemeral-port base URL each test boots.
 */
export function makeTestClient(base: string) {
	return {
		async postJson(route: string, body: unknown) {
			const res = await fetch(`${base}${route}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			})
			return { status: res.status, body: (await res.json()) as any }
		},
		async getJson(route: string) {
			const res = await fetch(`${base}${route}`)
			return { status: res.status, body: (await res.json()) as any }
		},
	}
}
