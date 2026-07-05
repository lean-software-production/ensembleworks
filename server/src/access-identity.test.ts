// Run: bun src/access-identity.test.ts   (from server/)
// Locks the behaviour-preserving refactor: getAccessIdentity's header-trust + dev
// output is unchanged, and the new unverified claim decoder extracts email /
// common_name. Network-free (verified/JWKS mode is unchanged prod code).
import assert from 'node:assert/strict'
import { decodeCfAccessClaimsUnverified, getAccessIdentity } from './access-identity.ts'

// Header-trust mode (CF_ACCESS_* unset), no dev fallback.
delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL

// getAccessIdentity behaviour preserved.
assert.deepEqual(
	await getAccessIdentity({ 'cf-access-authenticated-user-email': 'bob@example.com' }),
	{ email: 'bob@example.com', verified: false },
	'human email header → {email, verified:false}',
)
assert.equal(await getAccessIdentity({}), null, 'no headers → null')

process.env.EW_DEV_IDENTITY_EMAIL = 'dev@example.com'
// devFallback() always sets a `name` key (undefined when EW_DEV_IDENTITY_NAME
// is unset) — pre-existing behaviour, unrelated to this refactor, and already
// worked around the same way in participants-api.test.ts.
assert.deepEqual(
	await getAccessIdentity({}),
	{ email: 'dev@example.com', name: undefined, verified: false },
	'dev fallback preserved',
)
delete process.env.EW_DEV_IDENTITY_EMAIL

// decodeCfAccessClaimsUnverified extracts whichever identity claim is present.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`
assert.deepEqual(
	decodeCfAccessClaimsUnverified(jwt({ email: 'e@x.com' })),
	{ email: 'e@x.com', commonName: undefined },
	'email claim decoded',
)
assert.deepEqual(
	decodeCfAccessClaimsUnverified(jwt({ common_name: 'svc.access' })),
	{ email: undefined, commonName: 'svc.access' },
	'common_name claim decoded',
)
assert.equal(decodeCfAccessClaimsUnverified('not-a-jwt'), null, 'non-JWT → null')
assert.equal(decodeCfAccessClaimsUnverified(jwt({ other: 1 })), null, 'no identity claim → null')

console.log('ok: access-identity refactor preserved')
