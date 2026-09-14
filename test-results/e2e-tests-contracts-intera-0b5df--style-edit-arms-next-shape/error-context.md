# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/tests/contracts.spec.ts >> interaction contract [browser]: style-edit-arms-next-shape
- Location: e2e/tests/contracts.spec.ts:19:2

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/?room=contract-style-edit-arms-next-shape&engine=v2", waiting until "load"

```

# Test source

```ts
  1  | // The BROWSER lane for the shared interaction-contracts vocabulary (Pilot 3
  2  | // introduces this file): every `level: 'browser'` contract in the library
  3  | // runs through `runContractBrowser` against a fresh `?engine=v2` room, never
  4  | // `team` (the ratified hard exclusion — see client/src/engine.ts). FSM-level
  5  | // contracts run in canvas-editor/src/contracts/library.test.ts instead — this
  6  | // spec intentionally only picks up the browser-tagged ones.
  7  | //
  8  | // `browser` (Pilot 5): threaded through to `runContractBrowser` for every
  9  | // contract, not just multi-actor ones — a single-actor declaration never
  10 | // reads it (see that function's own MULTI-ACTOR doc comment), so this costs
  11 | // nothing for the pre-Pilot-5 library and lets a MULTI-actor contract (e.g.
  12 | // `peer-editing-is-visible`) provision its second actor's context without a
  13 | // per-contract fixture branch here.
  14 | import { test, expect } from '../lib/fixtures'
  15 | import { CONTRACTS } from '@ensembleworks/interaction-contracts'
  16 | import { runContractBrowser } from '../lib/contracts'
  17 | 
  18 | for (const contract of CONTRACTS.filter((c) => c.level === 'browser')) {
  19 | 	test(`interaction contract [browser]: ${contract.name}`, async ({ page, browser }) => {
  20 | 		test.setTimeout(60_000)
  21 | 		const room = `contract-${contract.name}`
  22 | 		// Defense-in-depth over a structurally-safe name: `contract-${name}` can
  23 | 		// never literally be 'team', so this assertion is tautological today — it
  24 | 		// exists to fail loudly if the naming scheme is ever refactored. The REAL
  25 | 		// protection is selectEngine's hard exclusion of the team room
  26 | 		// (client/src/engine.ts), which no room name or URL param can bypass.
  27 | 		expect(room).not.toBe('team')
> 28 | 		await page.goto(`/?room=${room}&engine=v2`)
     |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  29 | 		const failure = await runContractBrowser(page, contract, browser)
  30 | 		expect(failure, failure ?? 'contract held').toBeNull()
  31 | 	})
  32 | }
  33 | 
```