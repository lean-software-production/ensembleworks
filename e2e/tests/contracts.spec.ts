// The BROWSER lane for the shared interaction-contracts vocabulary (Pilot 3
// introduces this file): every `level: 'browser'` contract in the library
// runs through `runContractBrowser` against a fresh `?engine=v2` room, never
// `team` (the ratified hard exclusion — see client/src/engine.ts). FSM-level
// contracts run in canvas-editor/src/contracts/library.test.ts instead — this
// spec intentionally only picks up the browser-tagged ones.
import { test, expect } from '../lib/fixtures'
import { CONTRACTS } from '@ensembleworks/interaction-contracts'
import { runContractBrowser } from '../lib/contracts'

for (const contract of CONTRACTS.filter((c) => c.level === 'browser')) {
	test(`interaction contract [browser]: ${contract.name}`, async ({ page }) => {
		test.setTimeout(60_000)
		const room = `contract-${contract.name}`
		// Defense-in-depth over a structurally-safe name: `contract-${name}` can
		// never literally be 'team', so this assertion is tautological today — it
		// exists to fail loudly if the naming scheme is ever refactored. The REAL
		// protection is selectEngine's hard exclusion of the team room
		// (client/src/engine.ts), which no room name or URL param can bypass.
		expect(room).not.toBe('team')
		await page.goto(`/?room=${room}&engine=v2`)
		const failure = await runContractBrowser(page, contract)
		expect(failure, failure ?? 'contract held').toBeNull()
	})
}
