// Tests for Cloudflare Access identity + /api/participants.
// Exercises the pure helpers directly (getAccessIdentity, buildParticipants) and
// boots the app for the HTTP contract. Verified-JWT mode needs live Cloudflare
// keys, so it's covered by config + manual validation, not here.
// Run with: npx tsx src/participants-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getAccessIdentity } from './access-identity.ts'
import { buildParticipants, type CursorRef, createSyncApp } from './app.ts'

function ref(over: Partial<CursorRef> & { userId: string; currentPageId: string }): CursorRef {
	return {
		userName: 'teammate',
		cursor: { x: 0, y: 0 },
		camera: null,
		screenBounds: null,
		lastActivityTimestamp: 0,
		...over,
	}
}

async function main() {
	// --- getAccessIdentity ---------------------------------------------------
	// Header-trust mode (CF_ACCESS_* unset): trust the Cf-Access email header.
	{
		const id = await getAccessIdentity({ 'cf-access-authenticated-user-email': 'alice@example.com' })
		assert.equal(id?.email, 'alice@example.com')
		assert.equal(id?.verified, false, 'header-trust identity is not marked verified')
	}
	// No headers, no dev fallback → null.
	assert.equal(await getAccessIdentity({}), null, 'no identity available → null')
	// Dev fallback kicks in when configured and no Cf-Access headers present.
	{
		process.env.EW_DEV_IDENTITY_EMAIL = 'dev@example.com'
		process.env.EW_DEV_IDENTITY_NAME = 'Dev'
		const id = await getAccessIdentity({})
		assert.equal(id?.email, 'dev@example.com')
		assert.equal(id?.name, 'Dev')
		delete process.env.EW_DEV_IDENTITY_EMAIL
		delete process.env.EW_DEV_IDENTITY_NAME
	}

	// --- buildParticipants ---------------------------------------------------
	const refs = [
		ref({ userId: 'user:alice', userName: 'Alice', currentPageId: 'page:1', lastActivityTimestamp: 2 }),
		ref({ userId: 'user:bob', userName: 'Bob', currentPageId: 'page:2', lastActivityTimestamp: 1 }),
		ref({ userId: 'user:alice', userName: 'Alice', currentPageId: 'page:1' }), // dup tab
	]
	const identities = new Map([['alice', { email: 'alice@example.com', verified: true }]])

	const p1 = buildParticipants(refs, identities, 'page:1')
	assert.equal(p1.length, 1, 'page filter + dedupe: one Alice on page:1')
	assert.equal(p1[0]!.name, 'Alice')
	assert.equal(p1[0]!.email, 'alice@example.com')
	assert.equal(p1[0]!.verified, true)

	const p2 = buildParticipants(refs, identities, 'page:2')
	assert.equal(p2.length, 1)
	assert.equal(p2[0]!.name, 'Bob')
	assert.equal(p2[0]!.email, null, 'no captured identity → email null')
	assert.equal(p2[0]!.verified, false)

	assert.equal(buildParticipants(refs, identities, null).length, 2, 'no page filter → both users')

	// --- HTTP contract -------------------------------------------------------
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'participants-test-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const addr = server.address()
	assert.ok(addr && typeof addr === 'object')
	const base = `http://127.0.0.1:${addr.port}`

	const empty = await fetch(`${base}/api/participants?room=team`)
	assert.equal(empty.status, 200)
	const emptyBody = (await empty.json()) as any
	assert.deepEqual(emptyBody, { room: 'team', page: null, participants: [] }, 'nobody connected → empty list')

	const bad = await fetch(`${base}/api/participants?room=bad!`)
	assert.equal(bad.status, 400, 'invalid room id → 400')

	await new Promise<void>((resolve) => server.close(() => resolve()))
	console.log('participants-api.test.ts: OK')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
