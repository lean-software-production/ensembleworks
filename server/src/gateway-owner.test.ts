// Run: bun src/gateway-owner.test.ts   (from server/)
// resolveGatewayOwner: dev mode synthesises 'dev' and binds identities; strict
// mode (accessVerificationEnabled) rejects anonymous + dev fallbacks. Network-free
// (strict cases use no JWT → no JWKS fetch).
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Start in dev mode: no CF Access verification, no dev-identity fallback.
delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL

const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-gw-owner-'))
const mapFile = path.join(dir, 'service-tokens.toml')
writeFileSync(mapFile, ['[tokens."a.access"]', 'identity = "🤖 A"', 'scope = "read-write"'].join('\n') + '\n')
process.env.EW_SERVICE_TOKENS_FILE = mapFile

const { resolveGatewayOwner } = await import('./whoami.ts')

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`

// --- dev mode (accessVerificationEnabled() false) ---
assert.equal(await resolveGatewayOwner({}), 'dev', 'anonymous → dev (synthetic)')
assert.equal(
	await resolveGatewayOwner({ 'cf-access-authenticated-user-email': 'x@y.com' }),
	'sso:x@y.com',
	'human → sso:<email>',
)
assert.equal(
	await resolveGatewayOwner({ 'cf-access-jwt-assertion': jwt({ common_name: 'a.access' }) }),
	'token:a.access',
	'mapped token → token:<common_name>',
)
assert.equal(
	await resolveGatewayOwner({ 'cf-access-jwt-assertion': jwt({ common_name: 'nope.access' }) }),
	'dev',
	'unmapped token → dev (treated as anonymous)',
)

// --- strict mode (verification configured; no JWT used → no network) ---
process.env.CF_ACCESS_TEAM_DOMAIN = 'example.cloudflareaccess.com'
process.env.CF_ACCESS_AUD = 'dummy-aud'
assert.equal(await resolveGatewayOwner({}), null, 'strict: anonymous → reject')
process.env.EW_DEV_IDENTITY_EMAIL = 'dev@example.com'
assert.equal(await resolveGatewayOwner({}), null, 'strict: dev fallback (unverified) → reject')
delete process.env.EW_DEV_IDENTITY_EMAIL

console.log('ok: resolveGatewayOwner')
