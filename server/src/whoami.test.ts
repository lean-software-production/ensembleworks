// Run: bun src/whoami.test.ts   (from server/)
// resolveCaller across anonymous / human / bot-in-map / unknown-token, in the
// default header-trust mode (network-free).
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL

const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-whoami-'))
const mapFile = path.join(dir, 'service-tokens.toml')
writeFileSync(mapFile, '[tokens."codespace-3.access"]\nidentity = "🤖 codespace-3"\nscope = "read-write"\n')
process.env.EW_SERVICE_TOKENS_FILE = mapFile

const { resolveCaller } = await import('./whoami.ts')

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`

assert.deepEqual(await resolveCaller({}), { identity: null, kind: 'anonymous', via: 'none' }, 'no headers → anonymous')

assert.deepEqual(
	await resolveCaller({ 'cf-access-authenticated-user-email': 'alice@example.com' }),
	{ identity: 'alice@example.com', kind: 'human', via: 'sso' },
	'email header → human',
)

assert.deepEqual(
	await resolveCaller({ 'cf-access-jwt-assertion': jwt({ common_name: 'codespace-3.access' }) }),
	{ identity: '🤖 codespace-3', kind: 'bot', via: 'service-token' },
	'service-token in map → bot',
)

assert.deepEqual(
	await resolveCaller({ 'cf-access-jwt-assertion': jwt({ common_name: 'nope.access' }) }),
	{ identity: null, kind: 'anonymous', via: 'none' },
	'unknown service token → anonymous',
)

console.log('ok: resolveCaller')
