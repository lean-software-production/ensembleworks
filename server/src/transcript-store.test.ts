// Unit tests for the transcript JSONL store's incremental read index.
// Run with: bun src/transcript-store.test.ts
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTranscriptStore } from './transcript-store.ts'

const line = (t: number, text: string) =>
	`${JSON.stringify({ id: `${t}-x`, t, identity: 'a', name: 'A', text, page: null, cursor: null, frame: null })}\n`

async function main(dir: string) {
	const store = createTranscriptStore(dir)
	const file = path.join(dir, 'team.jsonl')

	assert.deepEqual(await store.read('team'), [], 'missing file reads empty')

	await store.append('team', { identity: 'a', name: 'A', text: 'first', t: 100, page: null, cursor: null, frame: null })
	await store.append('team', { identity: 'a', name: 'A', text: 'second', t: 200, page: null, cursor: null, frame: null })
	await store.append('team', { identity: 'a', name: 'A', text: 'third', t: 300, page: null, cursor: null, frame: null })
	assert.deepEqual((await store.read('team')).map((e) => e.text), ['first', 'second', 'third'])
	assert.deepEqual((await store.read('team', { since: 150 })).map((e) => e.text), ['second', 'third'])
	assert.deepEqual((await store.read('team', { limit: 1 })).map((e) => e.text), ['third'], 'limit keeps the tail')
	assert.deepEqual(await store.read('team', { since: 300 }), [], 'nothing newer')

	// Appends after the index was built are picked up incrementally, including
	// multi-byte text and a late (out-of-order) timestamp inside the span.
	await store.append('team', { identity: 'a', name: 'A', text: 'late', t: 150, page: null, cursor: null, frame: null })
	await store.append('team', { identity: 'a', name: 'A', text: 'naïve — ünïcødé', t: 400, page: null, cursor: null, frame: null })
	assert.deepEqual((await store.read('team', { since: 250 })).map((e) => e.text), ['third', 'naïve — ünïcødé'])
	assert.deepEqual((await store.read('team', { since: 120 })).map((e) => e.text), ['second', 'third', 'late', 'naïve — ünïcødé'])

	// A torn trailing write is not indexed until its newline lands, and a bad
	// line is skipped without hiding its neighbours.
	await appendFile(file, 'not json\n')
	const torn = line(500, 'torn')
	await appendFile(file, torn.slice(0, 20))
	assert.deepEqual((await store.read('team', { since: 400 })).map((e) => e.text), [])
	await appendFile(file, torn.slice(20))
	assert.deepEqual((await store.read('team', { since: 400 })).map((e) => e.text), ['torn'])

	// Concurrent reads of the same room don't double-index.
	await appendFile(file, line(600, 'concurrent'))
	const [a, b] = await Promise.all([store.read('team', { since: 500 }), store.read('team', { since: 500 })])
	assert.deepEqual([a.map((e) => e.text), b.map((e) => e.text)], [['concurrent'], ['concurrent']])
	assert.equal((await store.read('team')).length, 7)

	// Replacing the file (restore from backup) rebuilds the index.
	await rm(file)
	await writeFile(file, line(10, 'restored'))
	assert.deepEqual((await store.read('team')).map((e) => e.text), ['restored'])

	// Rewriting it in place (same inode) to at least its indexed size rebuilds
	// too, rather than serving stale byte spans.
	await writeFile(file, line(20, 'rewritten') + line(30, 'in place') + line(40, 'longer than before'))
	assert.deepEqual((await store.read('team')).map((e) => e.text), ['rewritten', 'in place', 'longer than before'])

	// A skewed early timestamp (t is caller-supplied) comes back alongside the
	// recent tail, without the lines in between being selected.
	await writeFile(file, line(9e12, 'skewed') + line(1, 'old') + line(2, 'old') + line(3, 'recent') + line(4, 'recent'))
	assert.deepEqual((await store.read('team', { since: 2 })).map((e) => e.text), ['skewed', 'recent', 'recent'])

	// A file far larger than one index chunk indexes and reads correctly.
	const big = createTranscriptStore(dir)
	const text = 'x'.repeat(900)
	let body = ''
	for (let i = 1; i <= 6000; i++) body += line(i, `${i}:${text}`)
	await writeFile(path.join(dir, 'big.jsonl'), body) // ~5.6 MB, > 4 MB chunk
	const tail = await big.read('big', { since: 5990 })
	assert.deepEqual(tail.map((e) => e.t), [5991, 5992, 5993, 5994, 5995, 5996, 5997, 5998, 5999, 6000])
	assert.equal((await big.read('big', { limit: 10000 })).length, 6000)

	console.log('ok: transcript-store')
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'transcript-'))
try {
	await main(dir)
} finally {
	await rm(dir, { recursive: true, force: true })
}
