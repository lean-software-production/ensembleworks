// The connection-resolution chain (§5.2): flag>env>file per-variable merge,
// the lone-URL case (keeps file creds), env token override, an unknown-instance
// env-only case, default_instance fallback, the no-instance error, and
// authHeaders emitting the pair only for service-token.
// Run with: bun src/resolve.test.ts
import assert from 'node:assert/strict'
import { CliError } from './errors.ts'
import type { HostsFile } from './hosts.ts'
import { authHeaders, resolveConn } from './resolve.ts'

const hosts: HostsFile = {
	default_instance: 'https://prod.example.com',
	instances: {
		'https://prod.example.com': {
			method: 'service-token',
			token_id: 'file-id',
			token_secret: 'file-secret',
			default_room: 'prod-room',
		},
	},
}

// default_instance fallback + file creds/room.
{
	const c = resolveConn({}, {}, hosts)
	assert.equal(c.url, 'https://prod.example.com')
	assert.equal(c.room, 'prod-room')
	assert.deepEqual(c.auth, { method: 'service-token', tokenId: 'file-id', tokenSecret: 'file-secret' })
}

// Lone ENSEMBLEWORKS_URL pointing at a KNOWN instance keeps the file's creds/room.
{
	const c = resolveConn({}, { ENSEMBLEWORKS_URL: 'https://prod.example.com' }, hosts)
	assert.equal(c.room, 'prod-room', 'lone URL does not discard file room')
	assert.equal(c.auth.method, 'service-token', 'lone URL keeps file creds')
}

// Env token pair overrides the file pair for the resolved URL (agent-seed case).
{
	const c = resolveConn({}, { ENSEMBLEWORKS_TOKEN_ID: 'env-id', ENSEMBLEWORKS_TOKEN_SECRET: 'env-secret' }, hosts)
	assert.deepEqual(c.auth, { method: 'service-token', tokenId: 'env-id', tokenSecret: 'env-secret' })
}

// ENSEMBLEWORKS_URL to an instance ABSENT from the file → env-only, no error,
// method 'none' when the pair is absent (fully env-driven agent, no file needed).
{
	const c = resolveConn({}, { ENSEMBLEWORKS_URL: 'http://unknown:8788' }, hosts)
	assert.equal(c.url, 'http://unknown:8788')
	assert.equal(c.room, 'team', 'unknown instance → default room')
	assert.deepEqual(c.auth, { method: 'none' })
}

// flag > env > file precedence for url and room.
{
	const c = resolveConn({ url: 'http://flag:1', room: 'flag-room' }, { ENSEMBLEWORKS_URL: 'http://env:2', ENSEMBLEWORKS_ROOM: 'env-room' }, hosts)
	assert.equal(c.url, 'http://flag:1')
	assert.equal(c.room, 'flag-room')
}

// No instance anywhere → CliError (exit 2).
{
	assert.throws(() => resolveConn({}, {}, { instances: {} }), (e) => e instanceof CliError && (e as CliError).exitCode === 2)
}

// authHeaders: pair only for service-token; none → empty.
assert.deepEqual(authHeaders({ method: 'service-token', tokenId: 'i', tokenSecret: 's' }), {
	'CF-Access-Client-Id': 'i',
	'CF-Access-Client-Secret': 's',
})
assert.deepEqual(authHeaders({ method: 'none' }), {})

console.log('ok: resolve — per-variable merge, lone-URL, env override, unknown-instance, precedence, no-instance error, authHeaders')
