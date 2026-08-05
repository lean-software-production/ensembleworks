// followLogic: pick the presenter for a shape from collaborator presence meta.
// Run: bun src/file-viewer/followLogic.test.ts
import assert from 'node:assert/strict'
import { presenterFor } from './followLogic'

const peer = (userId: string, meta: unknown, color?: string) =>
	({ userId, userName: userId, color, meta }) as never

assert.equal(presenterFor([peer('a', {})], 'shape:1'), null)
const p = presenterFor([peer('a', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.5 } })], 'shape:1')
assert.equal(p?.userId, 'a')
assert.equal(p?.fraction, 0.5)
// Colour rides along from presence; missing colour falls back to the default.
assert.equal(p?.color, '#3b82f6')
assert.equal(
	presenterFor([peer('a', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.5 } }, '#FF802B')], 'shape:1')
		?.color,
	'#FF802B'
)
assert.equal(presenterFor([peer('a', { fileViewerPresent: { shapeId: 'shape:2', fraction: 0.5 } })], 'shape:1'), null)
assert.equal(presenterFor([peer('a', { fileViewerPresent: { shapeId: 42 } })], 'shape:1'), null)
// Two presenters on one shape: the LATEST token (largest ts) wins, regardless
// of array order — presence tokens can't clear across users, so a "steal" must
// out-stamp the incumbent (spec §5 last-writer-wins).
const two = [
	peer('a', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.1, ts: 100 } }),
	peer('b', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.9, ts: 200 } }),
]
assert.equal(presenterFor(two, 'shape:1')?.userId, 'b')
assert.equal(presenterFor([...two].reverse(), 'shape:1')?.userId, 'b')
// Missing/non-numeric ts is treated as 0 — a stamped token beats it either way.
const stale = [
	peer('a', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.1 } }),
	peer('b', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.9, ts: 5 } }),
]
assert.equal(presenterFor(stale, 'shape:1')?.userId, 'b')
assert.equal(presenterFor([...stale].reverse(), 'shape:1')?.userId, 'b')

// ts exposure: the winner's token timestamp is surfaced so an incumbent
// presenter can detect a steal (peer ts newer than their own token's).
{
	const winner = presenterFor(
		[
			peer('a', { fileViewerPresent: { shapeId: 's1', fraction: 0.1, ts: 100 } }),
			peer('b', { fileViewerPresent: { shapeId: 's1', fraction: 0.9, ts: 200 } }),
		],
		's1'
	)
	assert.equal(winner?.userId, 'b')
	assert.equal(winner?.ts, 200, 'PresenterInfo carries the winning ts')
}
{
	const winner = presenterFor(
		[peer('a', { fileViewerPresent: { shapeId: 's1', fraction: 0.1 } })],
		's1'
	)
	assert.equal(winner?.ts, 0, 'missing ts normalises to 0')
}

console.log('ok: followLogic')
