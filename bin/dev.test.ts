// Tests for bin/dev's pure logic (service table gating, parsers).
// Run with: npx tsx bin/dev.test.ts
import assert from 'node:assert/strict'
import { PORTS, buildServices, hold, parseDotEnv, parseNvmrc } from './dev-lib.mjs'

// A baseline context: everything installed, no keys, no public host — what a
// fresh devcontainer looks like before dev.env exists.
function ctx(overrides: Record<string, unknown> = {}) {
	return {
		repoDir: '/repo',
		dataDir: '/home/u/.local/share/ensembleworks',
		publicHost: null,
		livekitConf: null,
		whisperModel: '/usr/local/share/whisper/ggml-base.bin',
		tailscaleIp: null,
		has: { caddy: true, livekit: true, whisper: true, docker: false },
		env: {},
		...overrides,
	} as Parameters<typeof buildServices>[0]
}

function svc(services: ReturnType<typeof buildServices>, name: string) {
	const s = services.find((x) => x.name === name)
	assert.ok(s, `service ${name} exists`)
	return s
}

// hold() wraps a command so the tmux window survives crash and Ctrl-C.
{
	const w = hold('npm run dev', 'client')
	assert.ok(w.startsWith('trap ":" INT; '), 'SIGINT trap is first (load-bearing)')
	assert.ok(w.includes('npm run dev'), 'command included')
	assert.ok(w.includes('[client exited $code]'), 'label in the epilogue')
	assert.ok(w.endsWith('exec bash'), 'drops to an interactive shell')
	console.log('ok: hold() wrapper shape')
}

// parseNvmrc tolerates v-prefix and whitespace.
{
	assert.equal(parseNvmrc('22.22.3\n'), '22.22.3')
	assert.equal(parseNvmrc('v22.22.3'), '22.22.3')
	console.log('ok: parseNvmrc')
}

// parseDotEnv: comments/blanks skipped, quotes stripped, export prefix ok,
// no interpolation.
{
	const got = parseDotEnv('# c\n\nA=1\nexport B="two"\nC=\'th ree\'\nbad line\n')
	assert.deepEqual(got, { A: '1', B: 'two', C: 'th ree' })
	console.log('ok: parseDotEnv')
}

// Baseline: core four + livekit + whisper enabled; scribe rides local whisper;
// shared-browser off (no docker).
{
	const s = buildServices(ctx())
	for (const name of ['sync', 'term', 'client', 'caddy', 'livekit', 'whisper']) {
		assert.equal(svc(s, name).enabled, true, `${name} enabled`)
	}
	assert.equal(svc(s, 'scribe').enabled, true, 'scribe enabled via local whisper')
	assert.equal(svc(s, 'shared-browser').enabled, false, 'no docker -> no neko')
	console.log('ok: baseline devcontainer gating')
}

// LiveKit dev mode: --dev command, devkey/secret inline on sync, loopback API
// url, browser URL via Caddy /livekit on plain localhost.
{
	const s = buildServices(ctx())
	const lk = svc(s, 'livekit')
	assert.ok(lk.cmd.includes('--dev'), 'dev mode')
	const sync = svc(s, 'sync')
	assert.ok(sync.cmd.includes(`LIVEKIT_URL='ws://localhost:${PORTS.caddy}/livekit'`), 'localhost ws url')
	assert.ok(sync.cmd.includes("LIVEKIT_API_KEY='devkey'"), 'dev key inline (not a secret)')
	assert.ok(sync.cmd.includes(`LIVEKIT_API_URL='http://localhost:${PORTS.livekit}'`), 'loopback RoomService')
	assert.ok(sync.cmd.includes(`DATA_DIR='/home/u/.local/share/ensembleworks'`), 'data dir inline')
	console.log('ok: livekit dev mode wiring')
}

// LiveKit config-file mode: real keys must come from the (inherited) env and
// never appear inline; missing keys disable livekit with a pointed reason.
{
	const withKeys = buildServices(
		ctx({ livekitConf: '/home/u/.config/ensembleworks/livekit-dev.yaml', env: { LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' } }),
	)
	const lk = svc(withKeys, 'livekit')
	assert.equal(lk.enabled, true)
	assert.ok(lk.cmd.includes('--config'), 'config file wins over --dev')
	assert.ok(!svc(withKeys, 'sync').cmd.includes("LIVEKIT_API_KEY='k'"), 'real key NOT inline')

	const noKeys = buildServices(ctx({ livekitConf: '/x/livekit-dev.yaml' }))
	assert.equal(svc(noKeys, 'livekit').enabled, false)
	assert.match(svc(noKeys, 'livekit').reason, /LIVEKIT_API_KEY/, 'reason names the missing keys')
	console.log('ok: livekit config-file mode')
}

// livekit-server absent: voice off, scribe off (needs the SFU to hear).
{
	const s = buildServices(ctx({ has: { caddy: true, livekit: false, whisper: true, docker: false } }))
	assert.equal(svc(s, 'livekit').enabled, false)
	assert.equal(svc(s, 'scribe').enabled, false)
	assert.ok(!svc(s, 'sync').cmd.includes('LIVEKIT_URL'), 'sync starts without LIVEKIT_*')
	console.log('ok: no livekit binary degrades cleanly')
}

// Scribe STT resolution order: explicit STT_URL wins (no inline default);
// STT_API_KEY alone works (Groq default url inside the transcriber);
// otherwise local whisper's /v1 endpoint is exported inline.
{
	const local = buildServices(ctx())
	assert.ok(svc(local, 'scribe').cmd.includes(`export STT_URL='http://localhost:${PORTS.whisper}/v1'`), 'local whisper default')
	assert.ok(svc(local, 'scribe').cmd.includes("STT_MODEL='whisper-1'"), 'model name for local server')

	const explicit = buildServices(ctx({ env: { STT_URL: 'http://elsewhere/v1' } }))
	assert.ok(!svc(explicit, 'scribe').cmd.includes('export STT_URL'), 'explicit STT_URL rides the env, not argv')

	const groq = buildServices(ctx({ has: { caddy: true, livekit: true, whisper: false, docker: false }, env: { STT_API_KEY: 'gsk_x' } }))
	assert.equal(svc(groq, 'scribe').enabled, true, 'hosted key alone enables scribe')
	assert.ok(!svc(groq, 'scribe').cmd.includes('STT_URL'), 'no url override for hosted default')

	const nothing = buildServices(ctx({ has: { caddy: true, livekit: true, whisper: false, docker: false } }))
	assert.equal(svc(nothing, 'scribe').enabled, false)
	assert.match(svc(nothing, 'scribe').reason, /STT/, 'reason explains what to set')
	console.log('ok: scribe STT resolution')
}

// Scribe waits for sync AND the SFU before starting, and talks to the SFU on
// loopback (same as the retired launcher).
{
	const cmd = svc(buildServices(ctx()), 'scribe').cmd
	assert.ok(cmd.includes(`export LIVEKIT_URL='ws://localhost:${PORTS.livekit}'`), 'loopback SFU for the scribe')
	assert.ok(cmd.includes('until curl -fsS http://localhost:8788/api/health'), 'waits for sync')
	assert.ok(cmd.includes(`/dev/tcp/localhost/${PORTS.livekit}`), 'waits for the SFU port')
	console.log('ok: scribe startup gate')
}

// Public host (tailnet/tunnel): wss LiveKit url, Vite told the host.
{
	const s = buildServices(ctx({ publicHost: 'baljeet.cyprus-macaroni.ts.net' }))
	assert.ok(svc(s, 'sync').cmd.includes("LIVEKIT_URL='wss://baljeet.cyprus-macaroni.ts.net/livekit'"))
	assert.ok(svc(s, 'client').cmd.includes("ENSEMBLEWORKS_PUBLIC_HOST='baljeet.cyprus-macaroni.ts.net'"))
	console.log('ok: public host wiring')
}

// Shared browser: docker + default-on; SHARED_BROWSER_ENABLE=0 kills it;
// NAT1TO1 resolution env > tailscale ip > loopback.
{
	const on = buildServices(ctx({ has: { caddy: true, livekit: true, whisper: true, docker: true }, tailscaleIp: '100.1.2.3' }))
	assert.equal(svc(on, 'shared-browser').enabled, true)
	assert.ok(svc(on, 'shared-browser').cmd.includes("NEKO_WEBRTC_NAT1TO1='100.1.2.3'"), 'tailscale ip fallback')
	const off = buildServices(ctx({ has: { caddy: true, livekit: true, whisper: true, docker: true }, env: { SHARED_BROWSER_ENABLE: '0' } }))
	assert.equal(svc(off, 'shared-browser').enabled, false)
	console.log('ok: shared-browser gating')
}

// Caddy absent: window disabled with a reason that names what breaks.
{
	const s = buildServices(ctx({ has: { caddy: false, livekit: true, whisper: true, docker: false } }))
	assert.equal(svc(s, 'caddy').enabled, false)
	assert.match(svc(s, 'caddy').reason, /dev\/\{port\}/, 'reason names the lost routes')
	console.log('ok: caddy gating')
}

console.log('all dev-lib tests passed')
