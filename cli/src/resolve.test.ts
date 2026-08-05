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

// -- access auth (SP5): env token, header emission, precedence ---------------
{
	// ENSEMBLEWORKS_ACCESS_TOKEN alone (the in-container connector case: SP2's
	// supervisor injects exactly this) → access auth.
	const conn = resolveConn(
		{},
		{ ENSEMBLEWORKS_URL: 'https://canvas.example.com', ENSEMBLEWORKS_ACCESS_TOKEN: 'app.jwt.here' },
		{ instances: {} },
	)
	assert.deepEqual(conn.auth, { method: 'access', appToken: 'app.jwt.here' })

	// It wins over a service-token pair in the same env (most specific first).
	const both = resolveConn(
		{},
		{
			ENSEMBLEWORKS_URL: 'https://canvas.example.com',
			ENSEMBLEWORKS_ACCESS_TOKEN: 'app.jwt.here',
			ENSEMBLEWORKS_TOKEN_ID: 'tid',
			ENSEMBLEWORKS_TOKEN_SECRET: 'tsec',
		},
		{ instances: {} },
	)
	assert.equal(both.auth.method, 'access')

	// An access-browser FILE record resolves to method none here — minting is
	// async and lives in resolveConnFresh (Task 8); pure resolveConn stays sync.
	const rec = resolveConn({}, { ENSEMBLEWORKS_URL: 'https://canvas.example.com' }, {
		instances: {
			'https://canvas.example.com': { method: 'access-browser', org_token: 'org.jwt', default_room: 'team' },
		},
	})
	assert.equal(rec.auth.method, 'none')

	// The header is cf-access-token (Discovery #4) — NOT Authorization.
	assert.deepEqual(authHeaders({ method: 'access', appToken: 'app.jwt.here' }), { 'cf-access-token': 'app.jwt.here' })
	console.log('ok: resolve — access env token, precedence, cf-access-token header')
}
