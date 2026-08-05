// Booted e2e: run main() in-process against createSyncApp on an ephemeral port,
// with an isolated temp XDG config/cache. Pins auth login (none) → whoami,
// sticky→frames→frame round-trip, anonymous --author badge (no meta.author),
// roadmap write→read, tools cache (fetch once), version, and the stdout-clean /
// 409-body-exit-1 discipline. Reuses the write-scope-api boot pattern.
// Run with: bun src/cli-api.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from '../../server/src/app.ts'
import { ROADMAP_FIXTURE } from '../../server/src/roadmap-fixture.ts'
import { main } from './main.ts'

delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL
delete process.env.ENSEMBLEWORKS_URL
delete process.env.ENSEMBLEWORKS_ROOM
delete process.env.ENSEMBLEWORKS_TOKEN_ID
delete process.env.ENSEMBLEWORKS_TOKEN_SECRET

const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-api-'))
const env: NodeJS.ProcessEnv = {
	...process.env,
	XDG_CONFIG_HOME: path.join(dir, 'config'),
	XDG_CACHE_HOME: path.join(dir, 'cache'),
}

const { server, getOrCreateRoom } = createSyncApp({ dataDir: dir })
await new Promise<void>((resolve) => server.listen(0, resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const base = `http://127.0.0.1:${address.port}`

// Seed an "Advice" frame into the team room — in real use this frame is
// created client-side by seedSessionCanvas.ts when a human opens the canvas;
// this booted, server-only e2e never runs that client code, so it must seed
// the frame itself (same pattern as server/src/canvas-api.test.ts).
const room = getOrCreateRoom('team')
await room.updateStore((store) => {
	store.put({
		id: 'shape:frame-advice',
		typeName: 'shape',
		type: 'frame',
		x: 1000,
		y: 0,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: { w: 800, h: 600, name: 'Advice', color: 'black' },
		parentId: 'page:page',
		index: 'a1',
	} as any)
})

// Capture stdout for one main() call; return what it wrote + the exit code.
async function run(argv: string[]): Promise<{ out: string; code: number }> {
	const chunks: string[] = []
	const real = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { chunks.push(String(s)); return true }
	try {
		const code = await main(argv, env)
		return { out: chunks.join(''), code }
	} finally {
		;(process.stdout as any).write = real
	}
}

// 1. auth login (none) writes the record + verifies via /api/whoami.
{
	const { code } = await run(['auth', 'login', '--url', base, '--method', 'none', '--room', 'team'])
	assert.equal(code, 0, 'auth login (none) succeeds')
}

// 2. kernel whoami round-trips (anonymous on a none instance).
{
	const { out, code } = await run(['kernel', 'whoami'])
	assert.equal(code, 0)
	const who = JSON.parse(out)
	assert.deepEqual(who, { identity: null, kind: 'anonymous', via: 'none' })
}

// 3. canvas sticky → frames → frame round-trip (the note appears).
let stickyId: string
{
	const { out, code } = await run(['canvas', 'sticky', 'hello from the cli', '--frame', 'Advice'])
	assert.equal(code, 0)
	const res = JSON.parse(out) as { ok: true; id: string }
	assert.equal(res.ok, true)
	stickyId = res.id
}
{
	const { out } = await run(['canvas', 'frames'])
	assert.ok(JSON.parse(out).ok, 'frames returns ok JSON')
}
{
	const { out } = await run(['canvas', 'frame', 'Advice'])
	const frame = JSON.parse(out)
	assert.ok(frame.notes.some((n: { text: string }) => n.text.includes('hello from the cli')), 'the note is in the frame')
}

// 4. anonymous --author dave → cosmetic badge, no structured meta.author
//    (the 3c pass-through, exercised through the CLI's exact wire shape).
{
	const { out } = await run(['canvas', 'sticky', 'note', '--author', 'dave', '--frame', 'Advice', '--color', 'light-blue'])
	const id = (JSON.parse(out) as { id: string }).id
	const read = await fetch(`${base}/api/canvas/frame?room=team&name=Advice`)
	const frame = (await read.json()) as { notes: { id: string; text: string }[] }
	const note = frame.notes.find((n) => n.id === id)
	assert.ok(note && note.text.includes('🤖 dave: note'), 'voluntary --author renders as a cosmetic badge')
}

// 5. roadmap write (a replace batch) → roadmap read.
{
	const ops = JSON.stringify([{ op: 'replace', data: ROADMAP_FIXTURE }])
	const { out, code } = await run(['roadmap', 'write', 'cli-roadmap', '--ops', ops])
	assert.equal(code, 0, 'roadmap write succeeds')
	assert.ok((JSON.parse(out) as { ok: true }).ok)
	const { out: readOut } = await run(['roadmap', 'read', 'cli-roadmap'])
	assert.ok(JSON.parse(readOut).data, 'roadmap read returns the doc')
}

// 6. roadmap write with a stale ifRev → 409 body on stdout + exit 1.
{
	const ops = JSON.stringify([{ op: 'replace', data: ROADMAP_FIXTURE }])
	const { out, code } = await run(['roadmap', 'write', 'cli-roadmap', '--ops', ops, '--if-rev', '0'])
	assert.equal(code, 1, 'a 409 exits non-zero')
	assert.ok(out.trim().length > 0 && out.includes('rev'), 'the 409 body (carrying the current rev) prints to stdout')
}

// 7. tools fetch populates the cache; a second call does not refetch.
{
	const { out, code } = await run(['tools', 'refresh'])
	assert.equal(code, 0)
	const { out: listOut } = await run(['tools', '--json'])
	assert.equal(JSON.parse(listOut).tools.length, 28, 'the cached manifest has 28 verbs (18 base + 5 canvas-v2 + 5 discord)')
}

// 8. version prints the CLI + server strings.
{
	const { out, code } = await run(['version', '--json'])
	assert.equal(code, 0)
	const v = JSON.parse(out)
	assert.equal(typeof v.cli, 'string')
	assert.equal(typeof v.server, 'string')
}

server.close()
console.log('ok: cli-api — login/whoami, sticky→frame round-trip, anonymous badge, roadmap write/read, 409-body-exit-1, tools cache, version')
process.exit(0)
