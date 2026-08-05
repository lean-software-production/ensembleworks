// fresh.ts (SP5): ensureFreshAppToken reuses a live cached app token, mints +
// persists when stale, and surfaces credential-expired distinctly;
// resolveConnFresh upgrades an access-browser record to a live access conn
// and passes every other method through untouched. Network-free (fake Access).
// Run with: bun src/auth/fresh.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadHosts, saveHosts, type HostsFile } from '../hosts.ts'
import { CREDENTIAL_EXPIRED_EXIT, realAccessDeps } from './access.ts'
import { makeJwt, startFakeAccess } from './fake-access.ts'
import { ensureFreshAppToken, refreshConnAuth, resolveConnFresh } from './fresh.ts'
import { CliError } from '../errors.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-fresh-'))
const env = { ...process.env, XDG_CONFIG_HOME: tmp } as NodeJS.ProcessEnv
delete env.ENSEMBLEWORKS_URL
delete env.ENSEMBLEWORKS_ACCESS_TOKEN
delete env.ENSEMBLEWORKS_TOKEN_ID
delete env.ENSEMBLEWORKS_TOKEN_SECRET
const hostsFile = path.join(tmp, 'ensembleworks', 'hosts.toml')
const deps = { ...realAccessDeps(), pollIntervalMs: 5, pollTimeoutMs: 500 }

const fake = startFakeAccess()
const nowSec = Math.floor(Date.now() / 1000)

// Seed: an access-browser record with a STALE cached app token.
const seed: HostsFile = {
	default_instance: fake.origin,
	instances: {
		[fake.origin]: {
			method: 'access-browser',
			org_token: fake.orgToken,
			app_token: makeJwt({ email: fake.email, exp: nowSec - 10 }), // stale
			team_domain: 'team.example',
			aud: fake.aud,
			default_room: 'team',
			identity: `sso:${fake.email}`,
		},
	},
}
saveHosts(hostsFile, seed)

try {
	// 1. Stale cache → mint via the fake exchange, persist the new cache.
	const minted = await ensureFreshAppToken(hostsFile, fake.origin, deps)
	assert.equal(minted, fake.appToken, 'stale cache → exchangeOrgToken mints')
	assert.equal(loadHosts(hostsFile).instances[fake.origin]!.app_token, fake.appToken, 'minted token persisted back (cache)')

	// 2. Fresh cache → reused, ZERO network.
	const before = fake.requests.length
	const reused = await ensureFreshAppToken(hostsFile, fake.origin, deps)
	assert.equal(reused, fake.appToken)
	assert.equal(fake.requests.length, before, 'fresh cache reused without a request')

	// 3. resolveConnFresh: the record upgrades to a live access conn…
	const conn = await resolveConnFresh({ url: fake.origin }, env, deps)
	assert.deepEqual(conn.auth, { method: 'access', appToken: fake.appToken })
	assert.equal(conn.room, 'team')
	// …and refreshConnAuth (the SP2 per-respawn seam) re-derives it from disk.
	const refreshed = await refreshConnAuth(conn, env, deps)
	assert.deepEqual(refreshed.auth, { method: 'access', appToken: fake.appToken })

	// 4. Non-access instances pass through untouched.
	const noneConn = await resolveConnFresh({ url: 'http://localhost:9' }, env, deps)
	assert.deepEqual(noneConn.auth, { method: 'none' }, 'unknown instance stays none — no minting attempted')

	// 5. Expired ORG token → the distinct credential-expired failure.
	const hosts = loadHosts(hostsFile)
	hosts.instances[fake.origin]!.org_token = makeJwt({ email: fake.email, exp: nowSec - 10 })
	hosts.instances[fake.origin]!.app_token = makeJwt({ email: fake.email, exp: nowSec - 10 })
	saveHosts(hostsFile, hosts)
	await assert.rejects(
		() => ensureFreshAppToken(hostsFile, fake.origin, deps),
		(e: unknown) => e instanceof CliError && e.exitCode === CREDENTIAL_EXPIRED_EXIT && /expired/i.test(e.message),
		'expired org token → CREDENTIAL_EXPIRED_EXIT, telling the user to re-login',
	)
} finally {
	fake.stop()
}
console.log('ok: fresh — cache reuse, mint+persist, passthrough, credential-expired')
