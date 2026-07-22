// Native Access client (SP5, discovery-pinned against cloudflared master):
// this file grows with access.ts across Tasks 3-6. Network-free — every
// server is a loopback Bun.serve. Run with: bun src/auth/access.test.ts
import assert from 'node:assert/strict'
import nacl from 'tweetnacl'
import { buildCliLoginUrl, decodeJwtPayload, decryptTransfer, generateTransferKeys, jwtEmail, jwtExpired, probeAccess } from './access.ts'
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

// -- Transfer crypto: keypair, login URL, NaCl-box decrypt --------------------
{
	const keys = generateTransferKeys()
	// Go base64.URLEncoding parity: URL-safe alphabet WITH '=' padding — the
	// edge stores the token under this exact string (Discovery #2).
	assert.match(keys.publicKeyB64, /^[A-Za-z0-9_-]+={0,2}$/, 'URL-safe base64')
	assert.equal(Buffer.from(keys.publicKeyB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length, 32, '32-byte Curve25519 key')

	const url = new URL(buildCliLoginUrl('https://canvas.example.com', 'aud-42', keys.publicKeyB64))
	assert.equal(url.origin, 'https://canvas.example.com', 'CLI-login page lives on the APP origin')
	assert.equal(url.pathname, '/cdn-cgi/access/cli')
	assert.equal(url.searchParams.get('token'), keys.publicKeyB64)
	assert.equal(url.searchParams.get('aud'), 'aud-42')
	assert.equal(url.searchParams.get('send_org_token'), 'true', 'org token requested — the host is the refresher (design §2)')
	assert.equal(url.searchParams.get('edge_token_transfer'), 'true')
	assert.equal(url.searchParams.get('redirect_url'), 'https://canvas.example.com')

	// Round-trip: seal as the service would (nonce ‖ box, std base64 body,
	// service public key alongside) and decrypt.
	const service = nacl.box.keyPair()
	const plain = new TextEncoder().encode(JSON.stringify({ app_token: 'app.jwt', org_token: 'org.jwt' }))
	const nonce = nacl.randomBytes(24)
	const clientPub = new Uint8Array(Buffer.from(keys.publicKeyB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
	const boxed = nacl.box(plain, nonce, clientPub, service.secretKey)
	const body = Buffer.concat([Buffer.from(nonce), Buffer.from(boxed)]).toString('base64')
	const servicePubB64 = Buffer.from(service.publicKey).toString('base64')

	const out = decryptTransfer(body, servicePubB64, keys.secretKey)
	assert.deepEqual(out, { app_token: 'app.jwt', org_token: 'org.jwt' })

	// Tolerant of a URL-safe-encoded service key (unverified encoding detail).
	const outUrlSafe = decryptTransfer(body, Buffer.from(service.publicKey).toString('base64url'), keys.secretKey)
	assert.deepEqual(outUrlSafe, { app_token: 'app.jwt', org_token: 'org.jwt' })

	// Tampered ciphertext → CliError, never garbage.
	const bad = Buffer.from(body, 'base64')
	bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff
	assert.throws(() => decryptTransfer(bad.toString('base64'), servicePubB64, keys.secretKey), /decrypt/i)
	console.log('ok: access — transfer keys, cli login url, nacl-box decrypt')
}
