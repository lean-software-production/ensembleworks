// Rename guard for the scribe's sync-server endpoint resolver (network-free).
// Pins the clean break: ENSEMBLEWORKS_URL/_ROOM only; the pre-cutover
// CANVAS_URL/CANVAS_ROOM names are gone, not aliased. Run with: bun src/config.test.ts
import assert from 'node:assert/strict'
import { readScribeEndpoint } from './config.ts'

// Defaults — the pre-cutover fallbacks are unchanged (regression guard).
assert.deepEqual(readScribeEndpoint({}), { url: 'http://localhost:8788', room: 'team' })

// New names honoured.
assert.deepEqual(
	readScribeEndpoint({ ENSEMBLEWORKS_URL: 'http://sync.test:9', ENSEMBLEWORKS_ROOM: 'demo' }),
	{ url: 'http://sync.test:9', room: 'demo' },
)

// Clean break (the load-bearing case): the old names are IGNORED — no alias survives.
assert.deepEqual(
	readScribeEndpoint({ CANVAS_URL: 'http://old:1', CANVAS_ROOM: 'old' }),
	{ url: 'http://localhost:8788', room: 'team' },
)

// New wins when both are set (ENSEMBLEWORKS_URL unset here → default; room is new).
assert.deepEqual(
	readScribeEndpoint({ ENSEMBLEWORKS_ROOM: 'demo', CANVAS_ROOM: 'old' }),
	{ url: 'http://localhost:8788', room: 'demo' },
)

console.log('ok: config — ENSEMBLEWORKS_URL/_ROOM resolve, defaults hold, CANVAS_* ignored (clean break)')
