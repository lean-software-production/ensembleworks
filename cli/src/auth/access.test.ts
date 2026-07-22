// Native Access client (SP5, discovery-pinned against cloudflared master):
// this file grows with access.ts across Tasks 3-6. Network-free — every
// server is a loopback Bun.serve. Run with: bun src/auth/access.test.ts
import assert from 'node:assert/strict'
import { decodeJwtPayload, jwtEmail, jwtExpired, probeAccess } from './access.ts'
import { makeJwt } from './fake-access.ts'

// -- JWT helpers: decode-only (the edge verifies signatures, we never do) -----
{
	const t = makeJwt({ email: 'sam@example.com', exp: 1_000_000 })
	assert.equal(decodeJwtPayload(t)?.email, 'sam@example.com')
	assert.equal(jwtEmail(t), 'sam@example.com')
	assert.equal(decodeJwtPayload('not-a-jwt'), null)
	assert.equal(jwtEmail('not-a-jwt'), undefined)
	// exp is in SECONDS (1_000_000 s = 1_000_000_000 ms); ms comparisons with a
	// default 60s skew.
	assert.equal(jwtExpired(t, 1_000_000_000 - 61_000), false, '61s before exp → fresh')
	assert.equal(jwtExpired(t, 1_000_000_000 - 59_000), true, 'inside the 60s skew → treated expired')
	assert.equal(jwtExpired(t, 1_000_000_001 * 1000), true, 'past exp → expired')
	assert.equal(jwtExpired('garbage', 0), true, 'undecodable → expired')
	assert.equal(jwtExpired(makeJwt({ email: 'x@y' }), 0), true, 'no exp claim → expired')
	console.log('ok: access — jwt decode/expiry helpers')
}

// -- probeAccess: the three §1 outcomes ---------------------------------------
{
	// One fake origin that answers per-path so all outcomes share a server.
	const srv: import('bun').Server<undefined> = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(req): Response {
			const u = new URL(req.url)
			if (u.pathname === '/open') return new Response('canvas', { status: 200 })
			if (u.pathname === '/broken') return new Response('boom', { status: 500 })
			if (u.pathname === '/elsewhere')
				return new Response(null, { status: 302, headers: { location: 'https://example.com/not-access' } })
			// default: behind Access → 302 to the team login carrying kid=AUD
			return new Response(null, {
				status: 302,
				headers: { location: `http://127.0.0.1:${srv.port}/fake-team/cdn-cgi/access/login/app.example?kid=aud-42&meta=1` },
			})
		},
	})
	const deps = { fetch: (i: string | URL | Request, init?: RequestInit) => fetch(i, init) }
	try {
		const access = await probeAccess(`http://127.0.0.1:${srv.port}/`, deps)
		assert.deepEqual(access, { kind: 'access', teamDomain: `127.0.0.1:${srv.port}`, aud: 'aud-42' },
			'302-to-Access → team domain from Location host, AUD from kid — never prompted (design §1)')

		const open = await probeAccess(`http://127.0.0.1:${srv.port}/open`, deps)
		assert.deepEqual(open, { kind: 'open' }, 'plain 200 → no auth boundary')

		await assert.rejects(() => probeAccess(`http://127.0.0.1:${srv.port}/broken`, deps), /500/,
			'anything else → clear error, nothing stored')
		await assert.rejects(() => probeAccess(`http://127.0.0.1:${srv.port}/elsewhere`, deps), /not Cloudflare Access/,
			'redirect to a non-Access target → clear error')
	} finally {
		srv.stop(true)
	}
	console.log('ok: access — probe detects behind-Access / open / error')
}
