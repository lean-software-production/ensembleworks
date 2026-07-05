/**
 * Run: npx tsx src/kernel/plugin.test.ts
 */
import assert from 'node:assert/strict'
import type { ClientPlugin } from './plugin'
import { collectIcons, collectShapeUtils, collectUiSlots } from './plugin'

const utilA = class {} as unknown as NonNullable<ClientPlugin['shapeUtils']>[number]
const utilB = class {} as unknown as NonNullable<ClientPlugin['shapeUtils']>[number]
const utilC = class {} as unknown as NonNullable<ClientPlugin['shapeUtils']>[number]

const plugins: ClientPlugin[] = [
	{ id: 'a', shapeUtils: [utilA, utilB], icons: { 'icon-a': 'data:a' } },
	{ id: 'b' },
	{
		id: 'c',
		shapeUtils: [utilC],
		icons: { 'icon-c': 'data:c' },
		uiSlots: { SharePanel: (() => null) as never },
	},
]

// Registry order is preserved across plugins and within a plugin.
assert.deepEqual(collectShapeUtils(plugins), [utilA, utilB, utilC])

// Icons merge across plugins.
assert.deepEqual(collectIcons(plugins), { 'icon-a': 'data:a', 'icon-c': 'data:c' })

// Slots merge; plugins without slots contribute nothing.
assert.deepEqual(Object.keys(collectUiSlots(plugins)), ['SharePanel'])

// Aggregators never mutate their inputs.
assert.equal(plugins[0]!.shapeUtils!.length, 2)

console.log('plugin.test.ts: all assertions passed')
