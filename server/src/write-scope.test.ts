// Run: bun src/write-scope.test.ts   (from server/)
// resolveWriteScope: read-only / read-write tokens resolve their scope; a human,
// anonymous, or unknown token → null (open). Header-trust mode, network-free.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL

const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-write-scope-'))
const mapFile = path.join(dir, 'service-tokens.toml')
writeFileSync(
	mapFile,
	[
		'[tokens."ro.access"]',
		'identity = "🤖 ro"',
		'scope = "read-only"',
		'[tokens."rw.access"]',
		'identity = "🤖 rw"',
		'scope = "read-write"',
	].join('\n') + '\n',
)
process.env.EW_SERVICE_TOKENS_FILE = mapFile

const { resolveWriteScope } = await import('./whoami.ts')

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`

assert.equal(
	await resolveWriteScope({ 'cf-access-jwt-assertion': jwt({ common_name: 'ro.access' }) }),
	'read-only',
	'read-only token → read-only',
)
assert.equal(
	await resolveWriteScope({ 'cf-access-jwt-assertion': jwt({ common_name: 'rw.access' }) }),
	'read-write',
	'read-write token → read-write',
)
assert.equal(
	await resolveWriteScope({ 'cf-access-jwt-assertion': jwt({ common_name: 'nope.access' }) }),
	null,
	'unknown token → null',
)
assert.equal(await resolveWriteScope({ 'cf-access-authenticated-user-email': 'a@b.com' }), null, 'human → null')
assert.equal(await resolveWriteScope({}), null, 'anonymous → null')

console.log('ok: resolveWriteScope')
