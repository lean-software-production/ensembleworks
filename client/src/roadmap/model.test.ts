// Unit tests for the pure roadmap client model.
// Run with: bun src/roadmap/model.test.ts
import assert from 'node:assert/strict'
import {
	applyLocalOp,
	cycleStatus,
	glyphFor,
	metricMatchesFilter,
	statusMatchesFilter,
	type RoadmapDoc,
} from './model'

const DOC: RoadmapDoc = {
	meta: { title: 'T' },
	outcomes: [
		{
			key: 'O1',
			zone: 'now',
			status: 'in-progress',
			title: 'One',
			initiatives: [
				{
					key: 'O1.I1',
					title: 'Ini',
					status: 'planned',
					metrics: [{ key: 'O1.I1.M1', text: 'm', done: false }],
					features: [
						{ key: 'O1.I1.F1', text: 'f1', status: 'planned' },
						{ key: 'O1.I1.F2', text: 'f2', status: 'planned' },
					],
				},
			],
		},
		{ key: 'O2', zone: 'next', status: 'planned', title: 'Two', initiatives: [] },
	],
}

// The status click cycle skips parked (spec §decisions.4).
assert.equal(cycleStatus('planned'), 'in-progress')
assert.equal(cycleStatus('in-progress'), 'done')
assert.equal(cycleStatus('done'), 'planned')
assert.equal(cycleStatus('parked'), 'planned')
console.log('ok: cycleStatus')

assert.equal(glyphFor('done').g, '✓')
assert.equal(glyphFor('in-progress').g, '●')
assert.equal(glyphFor('parked').g, '–')
assert.equal(glyphFor('planned').g, '○')
console.log('ok: glyphFor')

// Filter semantics: 'all' matches everything; otherwise exact status match.
assert.equal(statusMatchesFilter('all', 'done'), true)
assert.equal(statusMatchesFilter('in-progress', 'in-progress'), true)
assert.equal(statusMatchesFilter('in-progress', 'done'), false)
assert.equal(statusMatchesFilter('done', 'parked'), false)
// Metrics are binary: done matches only 'done'; an open metric is live work,
// so it matches every non-done filter.
assert.equal(metricMatchesFilter('all', true), true)
assert.equal(metricMatchesFilter('done', true), true)
assert.equal(metricMatchesFilter('done', false), false)
assert.equal(metricMatchesFilter('in-progress', true), false)
assert.equal(metricMatchesFilter('in-progress', false), true)
assert.equal(metricMatchesFilter('planned', false), true)
console.log('ok: statusMatchesFilter + metricMatchesFilter')

{
	const next = applyLocalOp(DOC, { op: 'set', key: 'O1.I1.F1', fields: { status: 'done' } })
	assert.equal(next.outcomes[0]!.initiatives![0]!.features![0]!.status, 'done')
	assert.equal(DOC.outcomes[0]!.initiatives![0]!.features![0]!.status, 'planned', 'input untouched')
}
{
	const next = applyLocalOp(DOC, { op: 'move', key: 'O2', zone: 'now', index: 0 })
	assert.deepEqual(
		next.outcomes.filter((o) => o.zone === 'now').map((o) => o.key),
		['O2', 'O1']
	)
}
{
	const next = applyLocalOp(DOC, { op: 'move', key: 'O1.I1.F2', index: 0 })
	assert.deepEqual(next.outcomes[0]!.initiatives![0]!.features!.map((f) => f.key), [
		'O1.I1.F2',
		'O1.I1.F1',
	])
}
console.log('ok: applyLocalOp set + move mirror the server semantics')
console.log('model.test.ts: all tests passed')
