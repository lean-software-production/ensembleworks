// Tests for bin/dev's pure logic (service table gating, parsers).
// Run with: bun bin/dev.test.ts
import assert from 'node:assert/strict'
import {
	PORTS,
	atLeast,
	attachInstructions,
	buildServices,
	forwardArgv,
	hold,
	parseDotEnv,
	parsePortOffset,
	parseToolVersions,
	parsePublicOrigin,
	portsFor,
	resolveMode,
	workspaceDirFor,
} from './dev-lib.mjs'

// A baseline context: everything installed, no keys, no public host — what a
// fresh devcontainer looks like before dev.env exists.
function ctx(overrides: Record<string, unknown> = {}) {
	return {
		repoDir: '/repo',
		dataDir: '/home/u/.local/share/ensembleworks/data',
		databaseDir: '/home/u/.local/share/ensembleworks/databases',
		databaseBackupsDir: '/home/u/.local/share/ensembleworks/database-backups',
		publicOrigin: null,
		livekitNodeIp: null,
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
	const w = hold('bun run dev', 'client')
	assert.ok(w.startsWith('trap ":" INT; '), 'SIGINT trap is first (load-bearing)')
	assert.ok(w.includes('bun run dev'), 'command included')
	assert.ok(w.includes('[client exited $code]'), 'label in the epilogue')
	assert.ok(w.endsWith('exec bash'), 'drops to an interactive shell')
	console.log('ok: hold() wrapper shape')
}

// parseToolVersions reads a tool's pin from .tool-versions; atLeast does the floor compare.
{
	assert.equal(parseToolVersions('bun 1.3.14\n', 'bun'), '1.3.14')
	assert.equal(parseToolVersions('# comment\nbun v1.3.14\n', 'bun'), '1.3.14', 'v-prefix + comments tolerated')
	assert.equal(parseToolVersions('node 22\n', 'bun'), '', 'absent tool -> empty')
	assert.equal(atLeast('1.3.14', '1.3.14'), true, 'equal satisfies the floor')
	assert.equal(atLeast('1.3.20', '1.3.14'), true)
	assert.equal(atLeast('1.3.4', '1.3.14'), false, 'the 1.3.4 default is below the floor')
	console.log('ok: parseToolVersions + atLeast')
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
	for (const name of ['sync', 'term', 'files', 'client', 'caddy', 'livekit', 'whisper']) {
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
	assert.ok(sync.cmd.includes(`DATA_DIR='/home/u/.local/share/ensembleworks/data'`), 'data dir inline')
	assert.ok(
		sync.cmd.includes(`DATABASE_DIR='/home/u/.local/share/ensembleworks/databases'`),
		'database dir inline (required triple)',
	)
	assert.ok(
		sync.cmd.includes(`DATABASE_BACKUPS_DIR='/home/u/.local/share/ensembleworks/database-backups'`),
		'database backups dir inline (required triple)',
	)
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

// parsePublicOrigin: PUBLIC_ORIGIN is the general form (scheme optional → http);
// PUBLIC_HOST is back-compat shorthand for https://<host>; junk → null.
{
	assert.deepEqual(parsePublicOrigin('http://192.168.1.77:8080', undefined), {
		scheme: 'http',
		host: '192.168.1.77',
		port: 8080,
	})
	assert.deepEqual(parsePublicOrigin('192.168.1.77:8080', undefined), {
		scheme: 'http',
		host: '192.168.1.77',
		port: 8080,
	}, 'bare host:port defaults to http')
	assert.deepEqual(parsePublicOrigin('https://x.ts.net', undefined), {
		scheme: 'https',
		host: 'x.ts.net',
		port: null,
	})
	assert.deepEqual(parsePublicOrigin(undefined, 'x.ts.net'), {
		scheme: 'https',
		host: 'x.ts.net',
		port: null,
	}, 'PUBLIC_HOST back-compat → https')
	assert.equal(parsePublicOrigin('http://o', 'ignored')?.host, 'o', 'origin wins over host')
	assert.equal(parsePublicOrigin(undefined, undefined), null, 'neither → localhost')
	console.log('ok: parsePublicOrigin')
}

// LAN over plain http:8080 — the browser reaches baljeet's LAN address, so the
// LiveKit signaling url and the origin handed to Vite are ws / :8080, not wss.
{
	const s = buildServices(ctx({ publicOrigin: parsePublicOrigin('http://192.168.1.77:8080', undefined) }))
	assert.ok(svc(s, 'sync').cmd.includes("LIVEKIT_URL='ws://192.168.1.77:8080/livekit'"), 'ws signaling on :8080')
	assert.ok(svc(s, 'client').cmd.includes("ENSEMBLEWORKS_PUBLIC_ORIGIN='http://192.168.1.77:8080'"), 'origin to Vite')
	console.log('ok: LAN http origin wiring')
}

// TLS edge (tailnet/tunnel): wss LiveKit url with the default port omitted.
{
	const s = buildServices(ctx({ publicOrigin: parsePublicOrigin(undefined, 'baljeet.cyprus-macaroni.ts.net') }))
	assert.ok(svc(s, 'sync').cmd.includes("LIVEKIT_URL='wss://baljeet.cyprus-macaroni.ts.net/livekit'"), 'wss, no :443')
	assert.ok(svc(s, 'client').cmd.includes("ENSEMBLEWORKS_PUBLIC_ORIGIN='https://baljeet.cyprus-macaroni.ts.net'"))
	console.log('ok: tls edge wiring')
}

// LiveKit node_ip: 127.0.0.1 by default (localhost-only voice); a LAN IP makes
// the SFU advertise a browser-reachable media address.
{
	assert.ok(svc(buildServices(ctx()), 'livekit').cmd.includes('--node-ip 127.0.0.1'), 'default localhost')
	const lan = svc(buildServices(ctx({ livekitNodeIp: '192.168.1.77' })), 'livekit')
	assert.ok(lan.cmd.includes('--node-ip 192.168.1.77'), 'advertises the LAN IP')
	assert.ok(lan.cmd.includes('--bind 0.0.0.0'), 'still binds all interfaces')
	console.log('ok: livekit node_ip override')
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

// Caddy TLS: plain :8080 by default; CADDY_TLS=internal + an https origin makes
// Caddy self-terminate TLS (secure context for LAN — crypto.randomUUID, mic).
{
	const plain = svc(buildServices(ctx()), 'caddy')
	assert.ok(plain.cmd.includes("ENSEMBLEWORKS_CADDY_SITE=':8080'"), 'default plain :8080')
	assert.ok(plain.cmd.includes("ENSEMBLEWORKS_CADDY_TLS_DIRECTIVE=''"), 'no tls by default')

	const tls = svc(
		buildServices(
			ctx({
				publicOrigin: parsePublicOrigin('https://192.168.1.77:8080', undefined),
				env: { ENSEMBLEWORKS_CADDY_TLS: 'internal' },
			}),
		),
		'caddy',
	)
	assert.ok(tls.cmd.includes("ENSEMBLEWORKS_CADDY_SITE='https://192.168.1.77:8080'"), 'https site')
	assert.ok(tls.cmd.includes("ENSEMBLEWORKS_CADDY_TLS_DIRECTIVE='tls internal'"), 'internal CA')
	assert.ok(tls.cmd.includes("ENSEMBLEWORKS_CADDY_GLOBAL='default_sni 192.168.1.77'"), 'default_sni for no-SNI IP access')
	assert.match(tls.reason, /self-signed/, 'reason warns about the click-through')

	// CADDY_TLS=internal but an http origin (or none) must NOT enable TLS.
	const httpOrigin = svc(
		buildServices(ctx({ publicOrigin: parsePublicOrigin('http://192.168.1.77:8080', undefined), env: { ENSEMBLEWORKS_CADDY_TLS: 'internal' } })),
		'caddy',
	)
	assert.ok(httpOrigin.cmd.includes("ENSEMBLEWORKS_CADDY_SITE=':8080'"), 'http origin stays plain')
	console.log('ok: caddy TLS internal')
}

// Host controller: mode detection (engine inside the container or under the
// native escape hatch; controller on the host by default).
{
	assert.equal(resolveMode({ ENSEMBLEWORKS_IN_DEVCONTAINER: '1' }), 'engine', 'inside container → engine')
	assert.equal(resolveMode({ ENSEMBLEWORKS_NATIVE: '1' }), 'engine', 'native escape hatch → engine')
	assert.equal(resolveMode({}), 'controller', 'plain host → controller')
	console.log('ok: resolveMode')
}

// Forwarding: the workspace cwd and the docker exec argv the controller builds.
{
	assert.equal(workspaceDirFor('/home/u/Work/ensembleworks'), '/workspaces/ensembleworks')
	assert.equal(workspaceDirFor('/home/u/Work/ensembleworks/'), '/workspaces/ensembleworks', 'trailing slash ok')
	assert.deepEqual(
		forwardArgv('c123', '/workspaces/ensembleworks', ['status', '--json']),
		['exec', '-w', '/workspaces/ensembleworks', 'c123', 'bin/dev', 'status', '--json'],
	)
	console.log('ok: forwardArgv + workspaceDirFor')
}

// attach on the host prints instructions (the exec line + the nested-detach
// caveat), never nests into the container tmux.
{
	const text = attachInstructions('lucid_hofstadter')
	assert.ok(text.includes('docker exec -it lucid_hofstadter tmux attach'), 'attach command')
	assert.ok(text.includes('Ctrl-b Ctrl-b d'), 'nested-detach caveat')
	console.log('ok: attachInstructions')
}

// portsFor: every port shifted by the offset; 0 = the documented defaults.
{
	const base = portsFor(0)
	assert.equal(base.sync, 8788)
	assert.equal(base.caddy, 8080)
	assert.equal(base.livekit, 7880)
	assert.equal(base.livekitTcp, 7881)
	assert.equal(base.livekitUdp, 7882)
	assert.equal(base.neko, 8090)
	assert.equal(base.whisper, 8091)
	const off = portsFor(100)
	for (const [name, port] of Object.entries(base)) {
		assert.equal((off as Record<string, number>)[name], port + 100, `${name} shifted by 100`)
	}
	assert.deepEqual(PORTS, base, 'PORTS stays the offset-0 map')
	console.log('ok: portsFor')
}

// parsePortOffset: unset/empty -> 0; a non-negative int string -> the int;
// anything else -> null (caller dies with the remedy).
{
	assert.equal(parsePortOffset(undefined), 0)
	assert.equal(parsePortOffset(''), 0)
	assert.equal(parsePortOffset('0'), 0)
	assert.equal(parsePortOffset('100'), 100)
	assert.equal(parsePortOffset('-1'), null)
	assert.equal(parsePortOffset('1.5'), null)
	assert.equal(parsePortOffset('abc'), null)
	assert.equal(parsePortOffset('60000'), null, 'ports must stay < 65536')
	console.log('ok: parsePortOffset')
}

console.log('all dev-lib tests passed')
