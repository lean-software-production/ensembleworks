// Run: bun src/session/style-toolbar-layout.test.ts
import assert from 'node:assert/strict'
import { relevantAxesForTool } from './style-axes.js'
import { toolbarSlots } from './style-toolbar-layout.js'

const ids = (kinds: Parameters<typeof toolbarSlots>[0]) => toolbarSlots(kinds).map((s) => `${s.id}:${s.axes.join('+')}`)

assert.deepEqual(ids(['note']), ['color:color', 'font:font', 'size:size', 'align:align+verticalAlign', 'more:opacity'])
assert.deepEqual(ids(['text']), ['color:color', 'font:font', 'size:size', 'align:textAlign', 'more:opacity'])
assert.deepEqual(ids(['geo']), ['geo:geo', 'color:color', 'fill:fill', 'dash:dash', 'align:align+verticalAlign', 'more:size+font+opacity'])
assert.deepEqual(ids(['arrow']), ['color:color', 'dash:dash', 'arrowheads:arrowheadStart+arrowheadEnd', 'more:size+fill+font+opacity'])
console.log('ok: per-kind layouts')

// Every axis a kind supports is reachable from exactly one slot, and nothing extra is invented.
for (const kind of ['note', 'text', 'geo', 'arrow'] as const) {
	const flat = toolbarSlots([kind]).flatMap((s) => s.axes)
	assert.deepEqual([...flat].sort(), [...relevantAxesForTool(kind)].sort(), `${kind} slots cover relevantAxes exactly`)
	assert.equal(new Set(flat).size, flat.length, `${kind} has no axis in two slots`)
}
console.log('ok: slots cover relevant axes exactly once')

// Mixed selection: intersection, first kind's order, more last.
assert.deepEqual(ids(['geo', 'arrow']), ['color:color', 'fill:fill', 'dash:dash', 'more:size+font+opacity'])
assert.deepEqual(ids(['note', 'geo']), ['color:color', 'font:font', 'size:size', 'align:align+verticalAlign', 'more:opacity'])
assert.deepEqual(ids(['note', 'note']), ids(['note']), 'duplicate kinds collapse')
console.log('ok: mixed selections intersect')

// Kinds with no style props still get opacity.
assert.deepEqual(ids(['frame']), ['more:opacity'])
assert.deepEqual(ids(['note', 'frame']), ['more:opacity'])
assert.deepEqual(ids([]), [])
console.log('ok: unstyled kinds and empty selection')
