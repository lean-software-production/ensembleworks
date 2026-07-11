import { test as base, expect } from '@playwright/test'

export const API = 'http://127.0.0.1:8788'

// Pre-seeded identity so the window.prompt onboarding never fires.
// A prompt appearing = broken fixture; the dialog handler fails the test.
function identityState(name: string, id: string) {
	return {
		cookies: [],
		origins: [
			{
				origin: 'http://127.0.0.1:5273',
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
	storageState: async ({}, use) => use(identityState('E2E One', 'e2e-user-0000-0000-0001')),
	page: async ({ page }, use) => {
		page.on('dialog', (d) => {
			throw new Error(`unexpected dialog (identity fixture broken?): ${d.message()}`)
		})
		await use(page)
	},
})
export { expect, identityState }
