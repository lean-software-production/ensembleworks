// The same registered rework/audit declarations run through real Chromium
// pointer input. Product fixes are reverted while retaining this file for RED.
import { test, expect } from '../lib/fixtures'
import { ARTIFACT_RESIZE_REWORK_CONTRACTS, ARTIFACT_RESIZE_AUDIT_CONTRACTS, RESIZE_KIND_PARITY_CONTRACTS } from '@ensembleworks/interaction-contracts'
import { runContractBrowser } from '../lib/contracts'
for (const contract of [...ARTIFACT_RESIZE_REWORK_CONTRACTS, ...ARTIFACT_RESIZE_AUDIT_CONTRACTS, ...RESIZE_KIND_PARITY_CONTRACTS]) {
  test(`resize contract: ${contract.name}`, async ({ page, browser }) => {
    test.setTimeout(60_000)
    await page.goto(`/?room=rework-${contract.name}&engine=v2`)
    const failure = await runContractBrowser(page, contract, browser)
    expect(failure, failure ?? 'contract held').toBeNull()
  })
}
