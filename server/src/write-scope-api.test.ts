// Run: bun src/write-scope-api.test.ts   (from server/)
// The write guard: a read-only token is 403'd on a write; read-write and
// anonymous callers pass (200); reads are unaffected. Header-trust mode, temp map.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'

delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL

const dir = await mkdtemp(path.join(os.tmpdir(), 'write-scope-api-'))
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

const { server } = createSyncApp({ dataDir: dir })
await new Promise<void>((resolve) => server.listen(0, resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const base = `http://127.0.0.1:${address.port}`

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`
const postSticky = (extra: Record<string, string>) =>
	fetch(`${base}/api/sticky`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...extra },
		body: JSON.stringify({ room: 'team', text: 'hello from a scoping test' }),
	})

// read-only token → 403 on a write
{
	const res = await postSticky({ 'Cf-Access-Jwt-Assertion': jwt({ common_name: 'ro.access' }) })
	assert.equal(res.status, 403, 'read-only token blocked on write')
	assert.deepEqual(await res.json(), { error: 'read-only token: writes are not permitted' }, 'error body')
}
// read-write token → allowed (200)
{
	const res = await postSticky({ 'Cf-Access-Jwt-Assertion': jwt({ common_name: 'rw.access' }) })
	assert.equal(res.status, 200, 'read-write token allowed')
}
// anonymous → allowed (200) — humans/none unaffected
{
	const res = await postSticky({})
	assert.equal(res.status, 200, 'anonymous allowed')
}
// read-only token can still READ
{
	const res = await fetch(`${base}/api/whoami`, {
		headers: { 'Cf-Access-Jwt-Assertion': jwt({ common_name: 'ro.access' }) },
	})
	assert.equal(res.status, 200, 'reads unaffected')
	assert.deepEqual(await res.json(), { identity: '🤖 ro', kind: 'bot', via: 'service-token' }, 'still resolves as the bot')
}

server.close()
console.log('write-scope-api.test.ts: all assertions passed')
process.exit(0)
