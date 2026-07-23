// hosts.toml store: smol-toml round-trip (quoted-URL table keys survive),
// setInstance sets default_instance, removeInstance reassigns/clears it, 0600
// on write, and the read-side perm check warns on 0644 / is silent on 0600.
// Run with: bun src/hosts.test.ts
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadHosts, removeInstance, saveHosts, setInstance, type HostsFile } from './hosts.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-hosts-'))
const file = path.join(dir, 'hosts.toml')

// Round-trip: two instances, one service-token (quoted-URL key) and one none.
let hosts: HostsFile = { instances: {} }
hosts = setInstance(hosts, 'https://canvas.example.com', {
	method: 'service-token',
	token_id: '1a2b.access',
	token_secret: 's3cr3t',
	default_room: 'team',
	identity: '🤖 codespace-3',
})
hosts = setInstance(hosts, 'http://localhost:8788', { method: 'none', default_room: 'team' })
saveHosts(file, hosts)

// 0600 asserted on write.
assert.equal(statSync(file).mode & 0o777, 0o600, 'saveHosts writes mode 0600')

const reloaded = loadHosts(file)
assert.equal(reloaded.default_instance, 'http://localhost:8788', 'last setInstance is the default')
assert.deepEqual(reloaded.instances['https://canvas.example.com'], {
	method: 'service-token',
	token_id: '1a2b.access',
	token_secret: 's3cr3t',
	default_room: 'team',
	identity: '🤖 codespace-3',
}, 'quoted-URL table key round-trips losslessly')

// logout: remove the default, reassign to the remaining instance.
const afterLogout = removeInstance(reloaded, 'http://localhost:8788')
assert.equal(afterLogout.instances['http://localhost:8788'], undefined, 'record removed')
assert.equal(afterLogout.default_instance, 'https://canvas.example.com', 'default reassigned to survivor')
// logout the last one → default cleared.
const empty = removeInstance(afterLogout, 'https://canvas.example.com')
assert.equal(empty.default_instance, undefined, 'default cleared when no instances remain')

// Read-side perm check: 0644 warns on stderr; 0600 is silent.
const warnFile = path.join(dir, 'loose.toml')
writeFileSync(warnFile, 'default_instance = "http://x"\n[instances."http://x"]\nmethod = "none"\n')
chmodSync(warnFile, 0o644)
const captured: string[] = []
const realWrite = process.stderr.write.bind(process.stderr)
;(process.stderr as any).write = (s: string) => { captured.push(String(s)); return true }
try {
	loadHosts(warnFile)
	chmodSync(warnFile, 0o600)
	loadHosts(warnFile)
} finally {
	;(process.stderr as any).write = realWrite
}
assert.equal(captured.filter((l) => l.includes('should be 0600')).length, 1, 'warns once (the 0644 load), silent on 0600')

// access-browser records (SP5): org/app tokens + team domain + aud round-trip
// losslessly; logout removes the whole record (tokens leave the disk with it).
{
	let h: HostsFile = { instances: {} }
	h = setInstance(h, 'https://canvas.leansoftware.ai', {
		method: 'access-browser',
		org_token: 'eyJhbGciOiJSUzI1NiJ9.e30.sig-org',
		app_token: 'eyJhbGciOiJSUzI1NiJ9.e30.sig-app',
		team_domain: 'lean-software.cloudflareaccess.com',
		aud: 'a1b2c3d4e5f6',
		default_room: 'team',
		identity: 'sam@leansoftware.ai',
	})
	const f = path.join(dir, 'access.toml')
	saveHosts(f, h)
	const back = loadHosts(f)
	assert.deepEqual(back.instances['https://canvas.leansoftware.ai'], {
		method: 'access-browser',
		org_token: 'eyJhbGciOiJSUzI1NiJ9.e30.sig-org',
		app_token: 'eyJhbGciOiJSUzI1NiJ9.e30.sig-app',
		team_domain: 'lean-software.cloudflareaccess.com',
		aud: 'a1b2c3d4e5f6',
		default_room: 'team',
		identity: 'sam@leansoftware.ai',
	}, 'access-browser record round-trips losslessly')
	assert.equal(statSync(f).mode & 0o777, 0o600, 'still written 0600')
	// logout drops the record — and with it every stored token.
	const out = removeInstance(back, 'https://canvas.leansoftware.ai')
	assert.equal(out.instances['https://canvas.leansoftware.ai'], undefined, 'logout removes tokens with the record')
	console.log('ok: hosts — access-browser record round-trip + logout')
}

console.log('ok: hosts — round-trip, default_instance set/reassign/clear, 0600 write, warn-on-loose-read')
