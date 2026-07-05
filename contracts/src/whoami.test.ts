// Run: bun contracts/src/whoami.test.ts
import assert from 'node:assert/strict'
import { whoamiSchema, type Whoami } from './whoami.js'

const valid: Whoami = { identity: '🤖 x', kind: 'bot', via: 'service-token' }
assert.deepEqual(whoamiSchema.parse(valid), valid, 'valid bot envelope parses')
assert.deepEqual(
	whoamiSchema.parse({ identity: null, kind: 'anonymous', via: 'none' }),
	{ identity: null, kind: 'anonymous', via: 'none' },
	'anonymous envelope parses',
)
assert.equal(whoamiSchema.safeParse({ identity: 'x', kind: 'alien', via: 'none' }).success, false, 'bad kind rejected')
console.log('ok: whoami envelope schema')
