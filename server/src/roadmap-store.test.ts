// Unit tests for the pure roadmap document logic and the JSON-file store.
// Run with: npx tsx src/roadmap-store.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ROADMAP_FIXTURE } from './roadmap-fixture.ts'
import {
	OpError,
	applyOps,
	createRoadmapStore,
	slugify,
	validateRoadmap,
} from './roadmap-store.ts'

function expectOpError(fn: () => void, status: number, label: string) {
	try {
		fn()
		assert.fail(`${label}: expected an OpError`)
	} catch (err) {
		// tsc doesn't narrow `err` through assert.ok, so cast after checking.
		assert.ok(err instanceof OpError, `${label}: throws OpError, got ${err}`)
		assert.equal((err as OpError).status, status, `${label}: status`)
	}
}

async function main() {
	// --- slugify ---------------------------------------------------------------
	assert.equal(slugify('EnsembleWorks Roadmap'), 'ensembleworks-roadmap')
	assert.equal(slugify('Roadmap'), 'roadmap')
	assert.equal(slugify('  ---  '), null, 'slug with no alphanumerics is invalid')
	console.log('ok: slugify')

	// --- validateRoadmap --------------------------------------------------------
	assert.equal(validateRoadmap(ROADMAP_FIXTURE), null, 'fixture is valid')
	assert.match(String(validateRoadmap({})), /meta\.title/, 'missing title rejected')
	{
		const dup = structuredClone(ROADMAP_FIXTURE)
		dup.outcomes[1]!.key = 'O1'
		assert.match(String(validateRoadmap(dup)), /duplicate key 'O1'/)
	}
	{
		const badZone = structuredClone(ROADMAP_FIXTURE)
		badZone.outcomes[0]!.zone = 'someday'
		assert.match(String(validateRoadmap(badZone)), /zone/)
	}
	{
		const badDone = structuredClone(ROADMAP_FIXTURE)
		;(badDone.outcomes[0]!.initiatives![0]!.metrics![0] as any).done = 'yes'
		assert.match(String(validateRoadmap(badDone)), /done must be a boolean/)
	}
	console.log('ok: validateRoadmap accepts the fixture, rejects bad docs')

	// --- applyOps: replace -------------------------------------------------------
	{
		const doc = applyOps(null, [{ op: 'replace', data: ROADMAP_FIXTURE }])
		assert.equal(doc.outcomes.length, 3)
		expectOpError(
			() => applyOps(null, [{ op: 'replace', data: { meta: {} } as any }]),
			400,
			'invalid replace data'
		)
		expectOpError(
			() => applyOps(null, [{ op: 'set', key: 'O1', fields: { status: 'done' } }]),
			404,
			'non-replace first op on a missing roadmap'
		)
		expectOpError(() => applyOps(ROADMAP_FIXTURE, []), 400, 'empty ops batch')
	}
	console.log('ok: applyOps replace')

	// --- applyOps: set ----------------------------------------------------------
	{
		const doc = applyOps(ROADMAP_FIXTURE, [
			{ op: 'set', key: 'O3.I1.F1', fields: { status: 'done' } },
			{ op: 'set', key: 'O3.I1.M1', fields: { done: false } },
			{ op: 'set', key: 'O4', fields: { title: 'Self-Serve Setup', why: 'New why.' } },
		])
		assert.equal(doc.outcomes[1]!.initiatives![0]!.features![0]!.status, 'done')
		assert.equal(doc.outcomes[1]!.initiatives![0]!.metrics![0]!.done, false)
		assert.equal(doc.outcomes[2]!.title, 'Self-Serve Setup')
		// The input document is never mutated (endpoint atomicity depends on it).
		assert.equal(ROADMAP_FIXTURE.outcomes[1]!.initiatives![0]!.features![0]!.status, 'in-progress')

		expectOpError(
			() => applyOps(ROADMAP_FIXTURE, [{ op: 'set', key: 'NOPE', fields: { status: 'done' } }]),
			404,
			'unknown key'
		)
		expectOpError(
			() => applyOps(ROADMAP_FIXTURE, [{ op: 'set', key: 'O1.I1.M1', fields: { status: 'done' } }]),
			400,
			'status is not settable on a metric'
		)
		expectOpError(
			() => applyOps(ROADMAP_FIXTURE, [{ op: 'set', key: 'O1', fields: { status: 'bogus' } }]),
			400,
			'invalid status value'
		)
	}
	console.log('ok: applyOps set (whitelist, clone, unknown key)')

	// --- applyOps: move ----------------------------------------------------------
	{
		// Outcome across zones, appended (no index).
		const moved = applyOps(ROADMAP_FIXTURE, [{ op: 'move', key: 'O4', zone: 'now' }])
		assert.equal(moved.outcomes.find((o) => o.key === 'O4')!.zone, 'now')
		const nowKeys = moved.outcomes.filter((o) => o.zone === 'now').map((o) => o.key)
		assert.deepEqual(nowKeys, ['O3', 'O4'], 'append lands after existing zone members')

		// Outcome to a specific index within its zone.
		const first = applyOps(moved, [{ op: 'move', key: 'O4', index: 0 }])
		assert.deepEqual(
			first.outcomes.filter((o) => o.zone === 'now').map((o) => o.key),
			['O4', 'O3']
		)

		// Feature reorder within its parent list.
		const feat = applyOps(ROADMAP_FIXTURE, [{ op: 'move', key: 'O3.I1.F2', index: 0 }])
		assert.deepEqual(
			feat.outcomes[1]!.initiatives![0]!.features!.map((f) => f.key),
			['O3.I1.F2', 'O3.I1.F1']
		)

		expectOpError(
			() => applyOps(ROADMAP_FIXTURE, [{ op: 'move', key: 'O3.I1.F1', zone: 'done' }]),
			400,
			'zone applies to outcomes only'
		)
		expectOpError(() => applyOps(ROADMAP_FIXTURE, [{ op: 'move', key: 'O1' }]), 400, 'move needs zone or index')
		expectOpError(
			() => applyOps(ROADMAP_FIXTURE, [{ op: 'move', key: 'O1', zone: 'someday' }]),
			400,
			'bad zone'
		)
	}
	console.log('ok: applyOps move (zones, index, nested lists)')

	// --- file store ---------------------------------------------------------------
	{
		const dir = await mkdtemp(path.join(os.tmpdir(), 'roadmap-store-test-'))
		const store = createRoadmapStore(dir)
		assert.deepEqual(await store.list('team'), [], 'empty room lists nothing')
		assert.equal(await store.get('team', 'roadmap'), null)

		await store.write('team', 'product-roadmap', {
			name: 'Product Roadmap',
			rev: 1,
			updated: '2026-07-01',
			data: ROADMAP_FIXTURE,
		})
		const listed = await store.list('team')
		assert.deepEqual(listed, [
			{ id: 'product-roadmap', name: 'Product Roadmap', rev: 1, updated: '2026-07-01' },
		])
		const byFuzzy = await store.get('team', 'product')
		assert.equal(byFuzzy?.id, 'product-roadmap', 'fuzzy name match')
		const byId = await store.get('team', 'product-roadmap')
		assert.equal(byId?.rev, 1, 'exact id match')
		assert.equal(byId?.data.outcomes.length, 3)
		assert.equal(await store.get('other-room', 'product'), null, 'rooms are isolated')
	}
	console.log('ok: file store write/list/get (fuzzy + exact id)')
}

main().then(
	() => {
		console.log('roadmap-store.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
