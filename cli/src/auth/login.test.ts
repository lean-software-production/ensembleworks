// auth login (SP5): probe-driven method resolution — behind Access → the full
// browser leg (keypair → open → poll → verify → store access-browser record);
// open origin → auth = none stored as before. Fully flag-driven (no prompts).
// Network-free via the fake. Run with: bun src/auth/login.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadHosts } from '../hosts.ts'
import type { AccessDeps } from './access.ts'
import { startFakeAccess } from './fake-access.ts'
import { login } from './login.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-login-'))
const env = { ...process.env, XDG_CONFIG_HOME: tmp } as NodeJS.ProcessEnv
const hostsFile = path.join(tmp, 'ensembleworks', 'hosts.toml')

// -- behind Access, no --method → probe picks the browser leg -----------------
{
	const fake = startFakeAccess()
	const opened: string[] = []
	const deps: AccessDeps = {
		fetch: (i, init) => fetch(i, init),
		openBrowser: async (u) => {
			opened.push(u)
			fake.completeLogin(new URL(u).searchParams.get('token')!)
			return true
		},
		storeBaseUrl: fake.storeBaseUrl,
		now: () => Date.now(),
		pollIntervalMs: 5,
		pollTimeoutMs: 2_000,
	}
	try {
		const code = await login({ url: fake.origin, room: 'team' }, env, deps)
		assert.equal(code, 0)
		const rec = loadHosts(hostsFile).instances[fake.origin]!
		assert.equal(rec.method, 'access-browser')
		assert.equal(rec.org_token, fake.orgToken, 'org token stored — the credential')
		assert.equal(rec.app_token, fake.appToken, 'app token cached')
		assert.equal(rec.aud, fake.aud, 'AUD from the probe redirect, never prompted')
		assert.equal(rec.team_domain, `127.0.0.1:${new URL(fake.origin).port}`, 'team domain from the redirect host')
		assert.equal(rec.identity, `sso:${fake.email}`, 'identity from /api/whoami through the app token')
		assert.equal(rec.default_room, 'team')
		assert.equal(loadHosts(hostsFile).default_instance, fake.origin, 'last login wins the default')
	} finally {
		fake.stop()
	}
	console.log('ok: login — probe → browser leg → access-browser record stored')
}

// -- open origin, no --method → stored as none (design §1 outcome 2) ----------
{
	const open = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(req) {
			const u = new URL(req.url)
			if (u.pathname === '/api/whoami') return Response.json({ identity: null, kind: 'anonymous', via: 'none' })
			return new Response('canvas', { status: 200 })
		},
	})
	const deps: AccessDeps = {
		fetch: (i, init) => fetch(i, init),
		openBrowser: async () => {
			throw new Error('browser must not open for an open origin')
		},
		storeBaseUrl: 'http://127.0.0.1:1/never/',
		now: () => Date.now(),
		pollIntervalMs: 5,
		pollTimeoutMs: 100,
	}
	try {
		const code = await login({ url: `http://127.0.0.1:${open.port}`, room: 'team' }, env, deps)
		assert.equal(code, 0)
		assert.equal(loadHosts(hostsFile).instances[`http://127.0.0.1:${open.port}`]!.method, 'none')
	} finally {
		open.stop(true)
	}
	console.log('ok: login — probe → open origin stored as none')
}

// -- --method access-browser against a NON-Access origin → clear error --------
{
	const open = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok', { status: 200 }) })
	const deps: AccessDeps = {
		fetch: (i, init) => fetch(i, init),
		openBrowser: async () => true,
		storeBaseUrl: 'http://127.0.0.1:1/never/',
		now: () => Date.now(),
		pollIntervalMs: 5,
		pollTimeoutMs: 100,
	}
	try {
		await assert.rejects(
			() => login({ url: `http://127.0.0.1:${open.port}`, method: 'access-browser', room: 'team' }, env, deps),
			/not behind Cloudflare Access/,
		)
	} finally {
		open.stop(true)
	}
	console.log('ok: login — forced access-browser against an open origin refuses')
}
