// Layout persistence helpers (SP4 decision #4): schema-v1 serialize/parse
// round-trip, defensive parsing (corrupt JSON / wrong version / bad entries →
// null — a broken layout must never break connector startup), the 64 KiB tail
// cap, layoutFilePath resolution, and readProcCwd's error-swallowing.
// Run with: bun src/connector/layout.test.ts
import assert from 'node:assert/strict'
import path from 'node:path'
import {
	capTail,
	LAYOUT_TAIL_CAP,
	layoutFilePath,
	parseLayout,
	readProcCwd,
	serializeLayout,
	type LayoutSnapshot,
} from './layout.ts'

// Round-trip, including raw non-UTF-8-safe bytes through base64.
{
	const rawTail = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xff, 0xfe, 0x0d, 0x0a]) // ANSI + invalid-UTF8 bytes
	const snap: LayoutSnapshot = {
		version: 1,
		sessions: [
			{ id: 'sess1', cwd: '/workspaces/myrepo', scrollbackTail: rawTail.toString('base64') },
			{ id: 'sess2', scrollbackTail: '' }, // cwd unknown is legal
		],
	}
	const parsed = parseLayout(serializeLayout(snap))
	assert.ok(parsed)
	assert.deepEqual(parsed, snap, 'serialize/parse round-trips losslessly')
	assert.deepEqual(
		Buffer.from(parsed.sessions[0]!.scrollbackTail, 'base64'),
		rawTail,
		'raw terminal bytes survive base64',
	)
}

// Defensive parse: null on anything malformed, never a throw.
assert.equal(parseLayout('not json {{{'), null, 'corrupt JSON → null')
assert.equal(parseLayout('{"version":2,"sessions":[]}'), null, 'unknown version → null')
assert.equal(parseLayout('{"version":1}'), null, 'missing sessions → null')
assert.equal(parseLayout('{"version":1,"sessions":[{"cwd":"/x","scrollbackTail":""}]}'), null, 'entry without id → null')
assert.equal(parseLayout('{"version":1,"sessions":[{"id":"a","scrollbackTail":42}]}'), null, 'non-string tail → null')
assert.equal(parseLayout(null), null, 'absent file (null read) → null')

// capTail: last N bytes win (history tail, not head).
{
	const big = Buffer.alloc(LAYOUT_TAIL_CAP + 1000, 0x61) // 'a' * (cap+1000)
	big.write('TAIL-MARKER', big.byteLength - 11)
	const capped = capTail([big])
	assert.equal(capped.byteLength, LAYOUT_TAIL_CAP, 'capped to LAYOUT_TAIL_CAP')
	assert.ok(capped.toString('utf8').endsWith('TAIL-MARKER'), 'keeps the TAIL, drops the head')
	const small = capTail([Buffer.from('ab'), Buffer.from('cd')])
	assert.equal(small.toString('utf8'), 'abcd', 'under-cap chunks concatenate untouched')
	assert.equal(capTail([]).byteLength, 0, 'empty ring → empty tail')
}

// layoutFilePath: env override wins; else $HOME/.ensembleworks-layout.json.
assert.equal(layoutFilePath({ ENSEMBLEWORKS_LAYOUT_FILE: '/tmp/custom.json' } as NodeJS.ProcessEnv), '/tmp/custom.json')
assert.equal(
	layoutFilePath({ HOME: '/home/u' } as NodeJS.ProcessEnv),
	path.join('/home/u', '.ensembleworks-layout.json'),
)

// readProcCwd: a live pid (our own) resolves on linux; garbage pids → undefined.
if (process.platform === 'linux') {
	assert.equal(readProcCwd(process.pid), process.cwd(), 'own /proc cwd resolves')
}
assert.equal(readProcCwd(999999999), undefined, 'dead pid → undefined, never a throw')
assert.equal(readProcCwd(undefined), undefined, 'unknown pid → undefined')

console.log('ok: layout helpers — round-trip, defensive parse, tail cap, paths, proc cwd')
