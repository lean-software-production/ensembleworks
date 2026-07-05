// Run: bun src/whoami-api.test.ts   (from server/)
// Endpoint wiring: GET /api/whoami returns the resolved envelope. Header-trust
// mode (network-free); the full resolution matrix is covered by whoami.test.ts.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'

delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'whoami-api-'))
const { server } = createSyncApp({ dataDir })
await new Promise<void>((resolve) => server.listen(0, resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const base = `http://127.0.0.1:${address.port}`

// anonymous
{
	const res = await fetch(`${base}/api/whoami`)
	assert.equal(res.status, 200, 'whoami responds 200')
	assert.deepEqual(await res.json(), { identity: null, kind: 'anonymous', via: 'none' }, 'anonymous envelope')
}
// human via the CF Access email header
{
	const res = await fetch(`${base}/api/whoami`, {
		headers: { 'Cf-Access-Authenticated-User-Email': 'carol@example.com' },
	})
	assert.deepEqual(await res.json(), { identity: 'carol@example.com', kind: 'human', via: 'sso' }, 'human envelope')
}

server.close()
console.log('whoami-api.test.ts: all assertions passed')
process.exit(0)
