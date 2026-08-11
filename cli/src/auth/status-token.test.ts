// auth status states + auth token (SP5): ok / unreachable / credential
// expired are distinct; token prints a fresh app token to stdout. Network-free
// via the fake. Run with: bun src/auth/status-token.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveHosts, type HostsFile } from '../hosts.ts'
import { realAccessDeps } from './access.ts'
import { makeJwt, startFakeAccess } from './fake-access.ts'
import { status } from './status.ts'
import { tokenCmd } from './token.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-status-'))
const env = { ...process.env, XDG_CONFIG_HOME: tmp } as NodeJS.ProcessEnv
delete env.ENSEMBLEWORKS_URL
delete env.ENSEMBLEWORKS_ACCESS_TOKEN
const hostsFile = path.join(tmp, 'ensembleworks', 'hosts.toml')
const deps = { ...realAccessDeps(), pollIntervalMs: 5, pollTimeoutMs: 500 }

const fake = startFakeAccess()
const nowSec = Math.floor(Date.now() / 1000)

const hosts: HostsFile = {
	default_instance: fake.origin,
	instances: {
		// live access-browser instance (stale app cache → forces a mint)
		[fake.origin]: {
			method: 'access-browser',
			org_token: fake.orgToken,
			app_token: makeJwt({ email: fake.email, exp: nowSec - 10 }),
			team_domain: 'team.example',
			aud: fake.aud,
			default_room: 'team',
		},
		// expired org token → credential expired, decided locally
		'https://dead.example.com': {
			method: 'access-browser',
			org_token: makeJwt({ email: 'x@y', exp: nowSec - 10 }),
			default_room: 'team',
		},
		// unreachable none instance
		'http://127.0.0.1:1': { method: 'none', default_room: 'team' },
	},
}
saveHosts(hostsFile, hosts)

const captureStdout = async (fn: () => Promise<number>): Promise<{ code: number; out: string }> => {
	const chunks: string[] = []
	const real = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => {
		chunks.push(String(s))
		return true
	}
	try {
		const code = await fn()
		return { code, out: chunks.join('') }
	} finally {
		;(process.stdout as any).write = real
	}
}

try {
	// status --json: three rows, three distinct states.
	const { code, out } = await captureStdout(() => status({ json: true }, env, deps))
	assert.equal(code, 1, 'any non-ok row → exit 1')
	const rows = JSON.parse(out) as Array<{ url: string; state: string; identity?: string | null }>
	const byUrl = Object.fromEntries(rows.map((r) => [r.url, r]))
	assert.equal(byUrl[fake.origin]!.state, 'ok')
	assert.equal(byUrl[fake.origin]!.identity, `sso:${fake.email}`, 'whoami through the freshly minted token')
	assert.equal(byUrl['https://dead.example.com']!.state, 'credential expired', 'the §2 distinct state — decided locally, no network')
	assert.equal(byUrl['http://127.0.0.1:1']!.state, 'unreachable')

	// auth token prints the fresh app token to STDOUT (scriptable).
	const t = await captureStdout(() => tokenCmd({ url: fake.origin }, env, deps))
	assert.equal(t.code, 0)
	assert.equal(t.out.trim(), fake.appToken)

	// auth token on a non-access instance → clear refusal.
	await assert.rejects(() => tokenCmd({ url: 'http://127.0.0.1:1' }, env, deps), /not a.*access-browser/i)
} finally {
	fake.stop()
}
console.log('ok: status/token — ok vs unreachable vs credential-expired, token prints fresh jwt')
