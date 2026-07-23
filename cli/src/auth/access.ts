/**
 * Native Cloudflare Access CLI login (SP5 — auth design doc §1-§3), the same
 * mechanics as `cloudflared access login`, reimplemented on fetch + tweetnacl
 * so `ew` stays one binary. Pinned against cloudflared master (token/token.go,
 * transfer.go, encrypt.go — see the plan's Discovery findings):
 *   probe    : unauthenticated GET; behind Access ⇒ 302 whose Location is
 *              https://<team>/cdn-cgi/access/login/<app>?kid=<AUD>
 *   browser  : open <app>/cdn-cgi/access/cli?token=<pubkey>&aud=…&
 *              send_org_token=true&edge_token_transfer=true, long-poll
 *              <store>/transfer/<pubkey> for the NaCl-boxed
 *              {app_token, org_token} JSON. NO loopback listener — delivery
 *              rides Cloudflare's transfer store, so the printed URL works
 *              from ANY machine (headless-host relay for free, design §3).
 *   exchange : org token ⇒ app token browser-free via the login/authorized
 *              redirect dance with CF_Authorization / CF_AppSession cookies.
 * All network + browser + clock access goes through AccessDeps so every unit
 * test runs against a loopback fake.
 */
import nacl from 'tweetnacl'
import { CliError } from '../errors.ts'
import { narrate } from '../output.ts'

export const ACCESS_LOGIN_PATH = '/cdn-cgi/access/login'
export const ACCESS_AUTHORIZED_PATH = '/cdn-cgi/access/authorized'
/** cloudflared's transfer store (transfer.go baseStoreURL). Unverifiable
 *  offline — manual-e2e item #2 confirms it against a live team. */
export const DEFAULT_TRANSFER_STORE = 'https://login.cloudflareaccess.org/'

export interface AccessDeps {
	fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
	/** open a URL in the user's browser; false ⇒ print-URL fallback */
	openBrowser: (url: string) => Promise<boolean>
	/** transfer-store base URL; tests point it at the fake */
	storeBaseUrl: string
	now: () => number
	pollIntervalMs: number
	pollTimeoutMs: number
}

export function realAccessDeps(): AccessDeps {
	return {
		fetch: (input, init) => fetch(input, init),
		openBrowser: openBrowserReal,
		storeBaseUrl: DEFAULT_TRANSFER_STORE,
		now: () => Date.now(),
		pollIntervalMs: 2_000,
		pollTimeoutMs: 300_000, // 5 min — a full first-time SSO can be slow
	}
}

/** Best-effort platform browser open; false (never throw) when unavailable. */
export async function openBrowserReal(url: string): Promise<boolean> {
	const cmd =
		process.platform === 'darwin' ? ['open', url]
		: process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url]
		: ['xdg-open', url]
	try {
		const p = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' })
		return (await p.exited) === 0
	} catch {
		return false
	}
}

// -- JWT payload helpers (decode-only; Discovery #5: the edge verifies) -------

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split('.')
	if (parts.length !== 3) return null
	try {
		return JSON.parse(Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
	} catch {
		return null
	}
}

/** true when undecodable, exp-less, or exp within skewMs of nowMs. */
export function jwtExpired(token: string, nowMs: number, skewMs = 60_000): boolean {
	const p = decodeJwtPayload(token)
	if (!p || typeof p.exp !== 'number') return true
	return p.exp * 1000 <= nowMs + skewMs
}

export function jwtEmail(token: string): string | undefined {
	const p = decodeJwtPayload(token)
	return p && typeof p.email === 'string' ? p.email : undefined
}

// -- Probe (design §1 step 1 / cloudflared GetAppInfo) ------------------------

export type ProbeResult =
	| { kind: 'access'; teamDomain: string; aud: string }
	| { kind: 'open' }

/** Hit the origin unauthenticated. 2xx ⇒ open; 3xx to
 *  …/cdn-cgi/access/login/…?kid=<AUD> ⇒ behind Access (team domain + AUD
 *  discovered from the redirect — the URL is the only thing the user types);
 *  anything else ⇒ CliError, nothing stored. */
export async function probeAccess(originUrl: string, deps: Pick<AccessDeps, 'fetch'>): Promise<ProbeResult> {
	let res: Response
	try {
		res = await deps.fetch(originUrl, { redirect: 'manual' })
	} catch (err) {
		throw new CliError(`could not reach ${originUrl}: ${(err as Error).message}`)
	}
	if (res.status >= 200 && res.status < 300) return { kind: 'open' }
	if (res.status >= 300 && res.status < 400) {
		const loc = res.headers.get('location')
		if (loc) {
			const u = new URL(loc, originUrl)
			if (u.pathname.includes(ACCESS_LOGIN_PATH)) {
				const aud = u.searchParams.get('kid')
				if (!aud) throw new CliError(`Access login redirect carries no kid (AUD): ${u.href}`)
				return { kind: 'access', teamDomain: u.host, aud }
			}
		}
		throw new CliError(`probe: ${originUrl} redirects to ${loc ?? '(no Location)'} — not Cloudflare Access; refusing to store anything`)
	}
	throw new CliError(`probe: ${originUrl} answered ${res.status} — neither an open canvas nor behind Access`)
}

// -- Token transfer (design §1 step 2 / cloudflared transfer.go + encrypt.go) --

export interface TransferKeys {
	/** Go base64.URLEncoding of the 32-byte Curve25519 public key (padded,
	 *  URL-safe) — the transfer-store key AND the browser URL's token param. */
	publicKeyB64: string
	secretKey: Uint8Array
}

function b64urlPadded(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
}

/** Tolerant base64 (accepts std and URL-safe alphabets, padded or not). */
function b64decode(s: string): Uint8Array {
	return new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}

export function generateTransferKeys(): TransferKeys {
	const kp = nacl.box.keyPair()
	return { publicKeyB64: b64urlPadded(kp.publicKey), secretKey: kp.secretKey }
}

/** The browser-leg URL — on the APP origin (cloudflared buildRequestURL):
 *  /cdn-cgi/access/cli?token=<pubkey>&aud=…&redirect_url=<origin>&
 *  send_org_token=true&edge_token_transfer=true */
export function buildCliLoginUrl(originUrl: string, aud: string, publicKeyB64: string): string {
	const u = new URL('/cdn-cgi/access/cli', originUrl)
	u.searchParams.set('token', publicKeyB64)
	u.searchParams.set('aud', aud)
	u.searchParams.set('redirect_url', new URL(originUrl).origin)
	u.searchParams.set('send_org_token', 'true')
	u.searchParams.set('edge_token_transfer', 'true')
	return u.toString()
}

export interface TransferTokens {
	app_token: string
	org_token: string
}

/** Body = std-base64(nonce(24) ‖ nacl.box ciphertext); sender key rides the
 *  service-public-key header (encrypt.go). Throws CliError on any mismatch. */
export function decryptTransfer(bodyB64: string, servicePublicKeyB64: string, secretKey: Uint8Array): TransferTokens {
	const data = b64decode(bodyB64)
	if (data.length <= 24) throw new CliError('transfer response too short to decrypt')
	const nonce = data.slice(0, 24)
	const opened = nacl.box.open(data.slice(24), nonce, b64decode(servicePublicKeyB64), secretKey)
	if (!opened) throw new CliError('failed to decrypt transfer response (key mismatch or corrupt payload)')
	let parsed: { app_token?: unknown; org_token?: unknown }
	try {
		parsed = JSON.parse(new TextDecoder().decode(opened))
	} catch {
		throw new CliError('decrypted transfer response is not JSON')
	}
	if (typeof parsed.app_token !== 'string' || parsed.app_token === '')
		throw new CliError('transfer response carries no app_token')
	if (typeof parsed.org_token !== 'string' || parsed.org_token === '')
		throw new CliError('transfer response carries no org_token — cannot refresh silently; is send_org_token honored for this org? (see manual-e2e item 2c)')
	return { app_token: parsed.app_token, org_token: parsed.org_token }
}

/** Long-poll the transfer store for our pubkey until SSO completes (non-200 =
 *  "still waiting", cloudflared transferRequest) — then decrypt. */
export async function pollTransferStore(keys: TransferKeys, deps: AccessDeps): Promise<TransferTokens> {
	const url = new URL(`transfer/${keys.publicKeyB64}`, deps.storeBaseUrl)
	const deadline = deps.now() + deps.pollTimeoutMs
	for (;;) {
		try {
			const res = await deps.fetch(url, { redirect: 'manual' })
			if (res.status === 200) {
				const servicePub = res.headers.get('service-public-key')
				if (!servicePub) throw new CliError('transfer store answered 200 without a service-public-key header')
				return decryptTransfer(await res.text(), servicePub, keys.secretKey)
			}
		} catch (err) {
			if (err instanceof CliError) throw err // decrypt/shape errors are fatal, not retriable
			// transient network error → keep polling
		}
		if (deps.now() >= deadline) {
			throw new CliError('timed out waiting for the browser login to complete — re-run `ew auth login` and finish the SSO page')
		}
		await new Promise((r) => setTimeout(r, deps.pollIntervalMs))
	}
}

export interface BrowserLoginResult {
	appToken: string
	orgToken: string
	teamDomain: string
	aud: string
}

/** The browser leg (design §1 step 2): keypair → open (or print) the
 *  cli-login URL → poll the store → decrypt. The URL is ALWAYS printed —
 *  delivery is keyed by our pubkey at the store, so it works opened from any
 *  machine (the design-§3 headless-human relay needs nothing more). */
export async function browserLogin(
	originUrl: string,
	probe: { teamDomain: string; aud: string },
	deps: AccessDeps,
): Promise<BrowserLoginResult> {
	const keys = generateTransferKeys()
	const loginUrl = buildCliLoginUrl(originUrl, probe.aud, keys.publicKeyB64)
	const opened = await deps.openBrowser(loginUrl)
	narrate(opened ? 'Opening browser to authenticate…' : 'No browser available — open this URL on any machine:')
	narrate(loginUrl)
	const tokens = await pollTransferStore(keys, deps)
	return { appToken: tokens.app_token, orgToken: tokens.org_token, teamDomain: probe.teamDomain, aud: probe.aud }
}

/** Exit code for "stored credential is expired/revoked — re-login" so callers
 *  (auth status, the SP2 supervisor) can distinguish it from generic failures
 *  (design §2: a distinct state, not a generic disconnect). */
export const CREDENTIAL_EXPIRED_EXIT = 4

/** Org token → fresh app token with zero browser (cloudflared
 *  exchangeOrgToken/handleRedirects): walk the app's redirect chain manually;
 *  attach CF_Authorization=<org> at the login hop and the observed
 *  CF_AppSession at the authorized hop; the authorized response's
 *  CF_Authorization Set-Cookie is the app token. */
export async function exchangeOrgToken(
	originUrl: string,
	orgToken: string,
	deps: Pick<AccessDeps, 'fetch' | 'now'>,
): Promise<string> {
	if (jwtExpired(orgToken, deps.now())) {
		throw new CliError('Access session expired — run `ew auth login` again', CREDENTIAL_EXPIRED_EXIT)
	}
	let target = originUrl
	let appSession: string | undefined
	for (let hop = 0; hop < 10; hop++) {
		const pathNow = new URL(target).pathname
		const cookies: string[] = []
		if (pathNow.includes(ACCESS_LOGIN_PATH)) cookies.push(`CF_Authorization=${orgToken}`)
		if (pathNow.includes(ACCESS_AUTHORIZED_PATH) && appSession) cookies.push(`CF_AppSession=${appSession}`)
		let res: Response
		try {
			res = await deps.fetch(target, {
				method: 'HEAD',
				redirect: 'manual',
				headers: cookies.length ? { cookie: cookies.join('; ') } : {},
			})
		} catch (err) {
			throw new CliError(`token refresh: could not reach ${new URL(target).origin}: ${(err as Error).message}`)
		}
		for (const sc of res.headers.getSetCookie()) {
			const pair = sc.split(';', 1)[0]!
			const eq = pair.indexOf('=')
			if (eq < 0) continue
			const name = pair.slice(0, eq).trim()
			const value = pair.slice(eq + 1)
			if (name === 'CF_AppSession') appSession = value
			if (name === 'CF_Authorization' && pathNow.includes(ACCESS_AUTHORIZED_PATH)) return value
		}
		const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
		if (!loc) break // dead end (e.g. the interactive login page) — the org session is no longer honored
		target = new URL(loc, target).toString()
	}
	throw new CliError(
		'could not mint an app token from the stored Access session — it may be expired or revoked; run `ew auth login` again',
		CREDENTIAL_EXPIRED_EXIT,
	)
}
