// Booted-app attribution: the sticky/shape/roadmap write routes stamp meta.author
// (credential only) and badge free text (🤖 <name>: ) from the resolved caller.
// Reuses the write-scope-api pattern: header-trust mode, a temp service-tokens.toml.
// Run with: bun src/attribution-api.test.ts
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'
import { richTextToPlainText } from './canvas/geometry.ts'
import { ROADMAP_FIXTURE } from './roadmap-fixture.ts'

delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL

const dir = await mkdtemp(path.join(os.tmpdir(), 'attribution-api-'))
const mapFile = path.join(dir, 'service-tokens.toml')
writeFileSync(
	mapFile,
	['[tokens."rw.access"]', 'identity = "🤖 rw"', 'scope = "read-write"'].join('\n') + '\n',
)
process.env.EW_SERVICE_TOKENS_FILE = mapFile

const { server, getOrCreateRoom } = createSyncApp({ dataDir: dir })
await new Promise<void>((resolve) => server.listen(0, resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const base = `http://127.0.0.1:${address.port}`

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`
const rwHeader = { 'Cf-Access-Jwt-Assertion': jwt({ common_name: 'rw.access' }) }

const post = (route: string, body: unknown, extra: Record<string, string> = {}) =>
	fetch(`${base}${route}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...extra },
		body: JSON.stringify(body),
	})

// Read a shape record straight from the room store by id.
const shapeById = (id: string) =>
	getOrCreateRoom('team')
		.getCurrentSnapshot()
		.documents.map((d) => d.state as any)
		.find((r) => r.id === id)

// 1. Bot token → structured meta.author + single badge (identity's own 🤖 not doubled).
{
	const res = await post('/api/canvas/sticky', { room: 'team', text: 'ship it' }, rwHeader)
	assert.equal(res.status, 200)
	const { id } = (await res.json()) as { id: string }
	const note = shapeById(id)
	assert.equal(note.meta.author, '🤖 rw', 'bot meta.author is the identity verbatim')
	assert.equal(richTextToPlainText(note.props.richText), '🤖 rw: ship it', 'single badge')
	console.log('ok: bot token stamps structured meta.author + a single badge')
}

// 2. Bot token IGNORES body.author (credential wins; no 4xx).
{
	const res = await post('/api/canvas/sticky', { room: 'team', text: 'x', author: 'somebody-else' }, rwHeader)
	assert.equal(res.status, 200)
	const { id } = (await res.json()) as { id: string }
	const note = shapeById(id)
	assert.equal(note.meta.author, '🤖 rw', 'credential wins over body.author')
	assert.equal(richTextToPlainText(note.props.richText), '🤖 rw: x', 'forged author never appears')
	console.log('ok: a credentialed caller silently ignores body.author')
}

// 3. Anonymous + voluntary author → cosmetic badge only, no structured author.
{
	const res = await post('/api/canvas/sticky', { room: 'team', text: 'note', author: 'dave' })
	assert.equal(res.status, 200)
	const { id } = (await res.json()) as { id: string }
	const note = shapeById(id)
	assert.equal(richTextToPlainText(note.props.richText), '🤖 dave: note', 'voluntary badge shows')
	assert.equal(note.meta.author, undefined, 'no structured meta.author for anonymous')
	console.log('ok: anonymous body.author is a cosmetic badge, never structured')
}

// 4. Anonymous, no author → stamp nothing.
{
	const res = await post('/api/canvas/sticky', { room: 'team', text: 'plain' })
	assert.equal(res.status, 200)
	const { id } = (await res.json()) as { id: string }
	const note = shapeById(id)
	assert.equal(richTextToPlainText(note.props.richText), 'plain', 'no badge')
	assert.equal(note.meta.author, undefined, 'no meta.author')
	console.log('ok: anonymous with no author stamps nothing')
}

// 5. Label-less geo shape → meta.author only, no orphan badge.
{
	const res = await post('/api/canvas/shape', { room: 'team', type: 'geo' }, rwHeader)
	assert.equal(res.status, 200)
	const { id } = (await res.json()) as { id: string }
	const geo = shapeById(id)
	assert.equal(geo.meta.author, '🤖 rw', 'label-less shape still carries meta.author')
	assert.equal(richTextToPlainText(geo.props.richText), '', 'no floating 🤖 rw: label')
	console.log('ok: a label-less shape stamps meta.author with no orphan badge')
}

// 6. Roadmap doc-level author (credential-only; anonymous stamps none).
{
	const res = await post('/api/roadmap/doc', { room: 'team', name: 'attr-roadmap', ops: [{ op: 'replace', data: ROADMAP_FIXTURE }] }, rwHeader)
	const body = (await res.json()) as any
	assert.equal(res.status, 200, `roadmap write should be 200, got ${JSON.stringify(body)}`)
	const read = await fetch(`${base}/api/roadmap/doc?room=team&name=attr-roadmap`)
	assert.equal(((await read.json()) as any).data.meta.author, '🤖 rw', 'credentialed roadmap write stamps meta.author')

	const anon = await post('/api/roadmap/doc', { room: 'team', name: 'anon-roadmap', ops: [{ op: 'replace', data: ROADMAP_FIXTURE }] })
	assert.equal(anon.status, 200)
	const readAnon = await fetch(`${base}/api/roadmap/doc?room=team&name=anon-roadmap`)
	assert.equal(((await readAnon.json()) as any).data.meta.author, undefined, 'anonymous roadmap write stamps no author')
	console.log('ok: roadmap stamps doc-level meta.author for a credential, nothing for anonymous')
}

server.close()
console.log('ok: attribution-api — sticky/shape/roadmap stamp meta.author + badge from the caller')
process.exit(0)
