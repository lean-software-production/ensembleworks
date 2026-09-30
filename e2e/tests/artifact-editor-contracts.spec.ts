// Stage 1b runs the SAME FSM declarations through real browser input on
// the web v2 mount. Artifact fixtures are imported history, never authoring.
// This proves editor/placeholder routing, not the future BB viewer or iframe.
import { test, expect } from '../lib/fixtures'
import { ARTIFACT_EDITOR_CONTRACTS, CONTRACTS } from '@ensembleworks/interaction-contracts'
import { runContractBrowser } from '../lib/contracts'

const threadGuards = CONTRACTS.filter(c => [
  // Other thread guards use FSM-only motion probes; library.test.ts runs
  // all of them. This guard's parent observation is available in browsers.
  'bbthread-pane-region-does-not-capture',
].includes(c.name))
for (const contract of [...ARTIFACT_EDITOR_CONTRACTS, ...threadGuards]) {
  test(`Stage 1b browser: ${contract.name}`, async ({ page, browser }) => {
    test.setTimeout(60_000)
    await page.goto(`/?room=stage-1b-${contract.name}&engine=v2`)
    const failure = await runContractBrowser(page, contract, browser)
    expect(failure, failure ?? 'contract held').toBeNull()
  })
}
