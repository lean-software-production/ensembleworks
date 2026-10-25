import { test as base, expect } from '@playwright/test'

export const API = 'http://127.0.0.1:8788'

// Pre-seeded identity so the window.prompt onboarding never fires.
// A prompt appearing = broken fixture; the dialog handler fails the test.
//
// `origin` MUST match the client origin the page actually navigates to.
// Playwright's storageState only injects localStorage for an exact origin
// match, so this is derived from the `baseURL` fixture rather than
// hardcoded — the shared e2e rig serves the client on :5273
// (playwright.config.ts) but the load-perf harness serves it on :5274
// (playwright.load.config.ts, a separate `vite preview` instance). A
// hardcoded :5273 here silently no-ops on any other origin: the identity
// never lands, onboarding's window.prompt fires, and this file's own
// dialog guard throws a message that looks like "fixture is broken" when
// the real cause is "origin mismatch".
function identityState(name: string, id: string, origin: string = 'http://127.0.0.1:5273') {
	return {
		cookies: [],
		origins: [
			{
				origin,
				localStorage: [
					{ name: 'ensembleworks.userId', value: id },
					{ name: 'ensembleworks.userName', value: name },
					{ name: 'ensembleworks.userColor', value: 'blue' },
				],
			},
		],
	}
}

export const test = base.extend({
	storageState: async ({ baseURL }, use) => use(identityState('E2E One', 'e2e-user-0000-0000-0001', baseURL ?? 'http://127.0.0.1:5273')),
	page: async ({ page }, use) => {
		page.on('dialog', (d) => {
			throw new Error(`unexpected dialog (identity fixture broken?): ${d.message()}`)
		})
		await use(page)
	},
})
export { expect, identityState }
