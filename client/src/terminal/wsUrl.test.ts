// Run with: bun src/terminal/wsUrl.test.ts   (from client/)
import assert from 'node:assert/strict'
import { buildTermWsUrl } from './wsUrl'

const loc = { protocol: 'https:', host: 'canvas.example.com' }

// No gateway → existing same-origin path, byte-identical to today.
assert.equal(
	buildTermWsUrl(loc, 'abc1', 80, 24),
	'wss://canvas.example.com/term/ws?session=abc1&cols=80&rows=24'
)

// Gateway set → relay path under /api (prod Caddy routes /term* elsewhere).
assert.equal(
	buildTermWsUrl(loc, 'abc1', 80, 24, 'gw-box'),
	'wss://canvas.example.com/api/term/relay?session=abc1&gateway=gw-box&cols=80&rows=24'
)

// http origin → ws scheme.
assert.equal(
	buildTermWsUrl({ protocol: 'http:', host: 'localhost:5173' }, 'x', 10, 5, 'g'),
	'ws://localhost:5173/api/term/relay?session=x&gateway=g&cols=10&rows=5'
)

console.log('wsUrl.test.ts: all assertions passed')
