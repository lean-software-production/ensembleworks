/**
 * Test-support fake of the three Cloudflare Access surfaces the CLI talks to
 * (SP5): the app origin behind Access, the team-domain login/authorized dance,
 * and the transfer store — one Bun.serve on a loopback ephemeral port plays
 * all three, so every SP5 unit test is network-free. NEVER imported by
 * production code; not matched by the *.test.ts discovery glob.
 */
import nacl from 'tweetnacl'

/** An unsigned-but-well-formed JWT (we only ever DECODE payloads client-side —
 *  Discovery #5: the edge is the verifier). */
export function makeJwt(payload: Record<string, unknown>): string {
	const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
	return `${enc({ alg: 'RS256', kid: 'fake-kid' })}.${enc(payload)}.${Buffer.from('fake-sig').toString('base64url')}`
}

export interface FakeAccess {
	origin: string
	storeBaseUrl: string
	aud: string
	email: string
	orgToken: string
	appToken: string
	/** simulate the user finishing SSO in a browser for the given pubkey */
	completeLogin: (publicKeyB64: string) => void
	/** swap the org token (e.g. for an expired one) */
	setOrgToken: (t: string) => void
	/** method+path log, for zero-network assertions */
	requests: string[]
	stop: () => void
}

export function startFakeAccess(opts: { email?: string; orgExpSec?: number; appExpSec?: number } = {}): FakeAccess {
	const email = opts.email ?? 'sam@example.com'
	const aud = 'fake-aud-1234'
	const nowSec = Math.floor(Date.now() / 1000)
	let orgToken = makeJwt({ email, exp: nowSec + (opts.orgExpSec ?? 3600) })
	const appToken = makeJwt({ email, aud, exp: nowSec + (opts.appExpSec ?? 3600) })
	const serviceKeys = nacl.box.keyPair()
	const completed = new Set<string>()
	const requests: string[] = []

	const fromB64url = (s: string) => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))

	const server: import('bun').Server<undefined> = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(req): Response {
			const u = new URL(req.url)
			requests.push(`${req.method} ${u.pathname}`)
			const origin = `http://127.0.0.1:${server.port}`
			const cookie = req.headers.get('cookie') ?? ''

			// 1. Transfer store: 404 until completeLogin(pubkey); then the
			// nacl-boxed {app_token, org_token} JSON (Discovery #2).
			if (u.pathname.startsWith('/store/transfer/')) {
				const key = decodeURIComponent(u.pathname.slice('/store/transfer/'.length))
				if (!completed.has(key)) return new Response('pending login', { status: 404 })
				const nonce = nacl.randomBytes(24)
				const plain = new TextEncoder().encode(JSON.stringify({ app_token: appToken, org_token: orgToken }))
				const boxed = nacl.box(plain, nonce, fromB64url(key), serviceKeys.secretKey)
				return new Response(Buffer.concat([Buffer.from(nonce), Buffer.from(boxed)]).toString('base64'), {
					status: 200,
					headers: { 'service-public-key': Buffer.from(serviceKeys.publicKey).toString('base64') },
				})
			}

			// 2. Team-domain login (the org→app exchange leg, Discovery #3):
			// valid CF_Authorization=<org token> cookie → 302 to authorized,
			// planting CF_AppSession; otherwise the interactive login page (200,
			// no redirect — a browser-only dead end for the exchange).
			if (u.pathname.includes('/cdn-cgi/access/login')) {
				if (cookie.includes(`CF_Authorization=${orgToken}`)) {
					return new Response(null, {
						status: 302,
						headers: {
							location: `${origin}/cdn-cgi/access/authorized?code=fake`,
							'set-cookie': 'CF_AppSession=fake-app-session; Path=/; HttpOnly',
						},
					})
				}
				return new Response('<html>interactive SSO page</html>', { status: 200 })
			}

			// 3. Authorized endpoint: needs the CF_AppSession planted above; its
			// CF_Authorization Set-Cookie IS the app token (Discovery #3).
			if (u.pathname.includes('/cdn-cgi/access/authorized')) {
				if (!cookie.includes('CF_AppSession=fake-app-session')) return new Response('missing app session', { status: 400 })
				return new Response(null, {
					status: 302,
					headers: { location: `${origin}/`, 'set-cookie': `CF_Authorization=${appToken}; Path=/; HttpOnly` },
				})
			}

			// 4. The canvas's whoami, reachable with a valid cf-access-token
			// header (Discovery #4; what verifyWhoami and auth status hit).
			if (u.pathname === '/api/whoami') {
				if (req.headers.get('cf-access-token') === appToken)
					return Response.json({ identity: `sso:${email}`, kind: 'user', via: 'access' })
				return new Response('forbidden', { status: 403 })
			}

			// 5. Everything else on the app origin: behind Access → 302 to the
			// team login carrying kid=<AUD> (what probeAccess parses).
			return new Response(null, {
				status: 302,
				headers: { location: `${origin}/team/cdn-cgi/access/login/app.example?kid=${aud}&meta=1` },
			})
		},
	})

	return {
		origin: `http://127.0.0.1:${server.port}`,
		storeBaseUrl: `http://127.0.0.1:${server.port}/store/`,
		aud,
		email,
		orgToken,
		appToken,
		completeLogin: (k) => completed.add(k),
		setOrgToken: (t) => {
			orgToken = t
		},
		requests,
		stop: () => server.stop(true),
	}
}
