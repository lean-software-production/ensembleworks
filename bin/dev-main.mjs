// @ts-check
/**
 * bin/dev — the EnsembleWorks dev stack, one command. tmux is the engine:
 * each service runs in a window of the `workspace` session (the same shape
 * the Debian boxes run under systemd), wrapped by hold() so a crash leaves
 * exit code + scrollback + a live shell instead of a vanished window.
 *
 * Pure logic (service table, gating, parsing) lives in ./dev-lib.mjs and is
 * unit-tested; this file owns the I/O: process env, tmux, health polls, CLI.
 * Dependency-free on purpose — node: builtins only — so it runs on a fresh
 * clone before bun install.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
	PORTS,
	atLeast,
	buildServices,
	hold,
	originToString,
	parseDotEnv,
	parseToolVersions,
	parsePublicOrigin,
	resolveMode,
} from './dev-lib.mjs'
import { runDoctor } from './dev-doctor.mjs'
import { runController } from './dev-host.mjs'
import { probePort } from './dev-net.mjs'

export const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const session = process.env.WORKSPACE_TMUX_SESSION ?? 'workspace'
const tmuxConf = path.join(repoDir, 'deploy', 'tmux-ensembleworks.conf')

// ---- role dispatch: controller (host) vs engine (in the container / native) --
// The expected usage is from the HOST: there bin/dev drives the devcontainer
// (up starts it; status/logs/… forward into it) and needs none of the engine's
// Bun/tmux/caddy machinery — so dispatch to the controller here, before the
// Bun-version gate and dev.env sourcing below. runController() never returns.
if (resolveMode(process.env) === 'controller') {
	runController(repoDir, process.argv.slice(2))
}
// Engine mode (inside the container, or ENSEMBLEWORKS_NATIVE=1 on the host):
process.stderr.write(
	`bin/dev [${process.env.ENSEMBLEWORKS_IN_DEVCONTAINER === '1' ? 'devcontainer' : 'native'}] · executing natively\n`,
)

/** @param {string} bin */
export const onPath = (bin) => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0
/** @param {...string} args */
const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' })
/** @param {...string} args */
const tmuxOk = (...args) => spawnSync('tmux', args, { stdio: 'ignore' }).status === 0
export const sessionRunning = () => tmuxOk('has-session', '-t', session)

/** @param {string} msg @returns {never} */
function die(msg) {
	console.error(`bin/dev: ${msg}`)
	process.exit(1)
}

// ---- Bun version: enforce the floor, re-exec through mise if it can ----------
// bin/dev runs under Bun (shebang). The floor exists because Bun.Terminal + the
// build need >= 1.3.14 while the default mise bun was 1.3.4 during the
// migration. .tool-versions is the single source of truth. If a too-old bun is
// running and mise is on PATH, re-exec once through the pinned bun; else fail
// with the exact remedy.
export const wantedBun = parseToolVersions(readFileSync(path.join(repoDir, '.tool-versions'), 'utf8'), 'bun')
const runningBun = process.versions.bun
if (!runningBun) {
	die(
		`bin/dev must run under Bun, but it is running under Node ${process.version}.\n` +
			`  fix: install Bun >= ${wantedBun} (\`mise use -g bun@${wantedBun}\` or https://bun.sh) and re-run.`,
	)
}
if (!atLeast(runningBun, wantedBun)) {
	if (onPath('mise') && !process.env.ENSEMBLEWORKS_DEV_REEXEC) {
		const r = spawnSync(
			'mise',
			['exec', `bun@${wantedBun}`, '--', 'bun', ...process.argv.slice(1)],
			{ stdio: 'inherit', env: { ...process.env, ENSEMBLEWORKS_DEV_REEXEC: '1' } },
		)
		process.exit(r.status ?? 1)
	}
	die(
		`running bun ${runningBun}, but .tool-versions pins bun ${wantedBun} (Bun.Terminal + build floor).\n` +
			`  fix: install it — e.g. \`mise use -g bun@${wantedBun}\` — and re-run.`,
	)
}

// ---- config: dev.env (set -a semantics), data dir, optional livekit conf ----
export const devEnvPath =
	process.env.ENSEMBLEWORKS_DEV_ENV ?? path.join(homedir(), '.config', 'ensembleworks', 'dev.env')
if (existsSync(devEnvPath)) {
	for (const [k, v] of Object.entries(parseDotEnv(readFileSync(devEnvPath, 'utf8')))) {
		if (process.env[k] === undefined) process.env[k] = v // real env wins over dev.env
	}
}

const stateDir =
	process.env.ENSEMBLEWORKS_DATA_DIR ?? path.join(homedir(), '.local', 'share', 'ensembleworks')
// Storage geometry triple — the sync server REQUIRES all three and validates
// them at startup (kernel/storage-geometry.ts). Nested as siblings under the
// dev state root so the no-nesting rules pass on a single-disk dev box.
const dataDir = path.join(stateDir, 'data')
const databaseDir = path.join(stateDir, 'databases')
const databaseBackupsDir = path.join(stateDir, 'database-backups')
const livekitConfPath =
	process.env.ENSEMBLEWORKS_LIVEKIT_CONF ??
	path.join(homedir(), '.config', 'ensembleworks', 'livekit-dev.yaml')
const whisperModel = process.env.WHISPER_MODEL ?? '/usr/local/share/whisper/ggml-base.bin'

// LiveKit --node-ip for LAN voice: explicit env wins; else the LAN IP the
// devcontainer's initializeCommand detected (host-lan-ip, next to dev.env,
// symlinked into the container); else null → 127.0.0.1 (localhost-only voice).
const hostLanIpPath = path.join(path.dirname(devEnvPath), 'host-lan-ip')
const hostLanIp = existsSync(hostLanIpPath)
	? readFileSync(hostLanIpPath, 'utf8').trim() || null
	: null

function tailscaleIp() {
	try {
		const out = execSync('tailscale ip -4', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
		return out.split('\n')[0].trim() || null
	} catch {
		return null
	}
}

/** @returns {import('./dev-lib.mjs').ServiceCtx} */
export function makeCtx() {
	return {
		repoDir,
		dataDir,
		databaseDir,
		databaseBackupsDir,
		publicOrigin: parsePublicOrigin(
			process.env.ENSEMBLEWORKS_PUBLIC_ORIGIN,
			process.env.ENSEMBLEWORKS_PUBLIC_HOST,
		),
		livekitNodeIp: process.env.ENSEMBLEWORKS_LIVEKIT_NODE_IP ?? hostLanIp,
		livekitConf: existsSync(livekitConfPath) ? livekitConfPath : null,
		whisperModel,
		tailscaleIp: tailscaleIp(),
		has: {
			caddy: onPath('caddy'),
			livekit: onPath('livekit-server'),
			whisper: onPath('whisper-server') && existsSync(whisperModel),
			docker: onPath('docker'),
		},
		env: process.env,
		// TODO(port-offset): a later task parses ENSEMBLEWORKS_PORT_OFFSET here
		// (parsePortOffset, from Task 1) and writes the generated LiveKit yaml;
		// offset-0 defaults keep current behavior unchanged for now.
		ports: PORTS,
		portOffset: 0,
		livekitGeneratedConf: path.join(dataDir, 'livekit-dev.generated.yaml'),
	}
}

// ---- health ------------------------------------------------------------------
/** @param {import('./dev-lib.mjs').Service['health']} health */
async function probe(health) {
	if (!health) return null
	if (health.kind === 'port') return probePort(health.port)
	try {
		const res = await fetch(health.url, { signal: AbortSignal.timeout(1000) })
		return res.ok
	} catch {
		return false
	}
}

/** @param {import('./dev-lib.mjs').Service[]} enabled */
async function waitHealthy(enabled, timeoutMs = 180_000) {
	const pending = new Set(enabled.filter((s) => s.health))
	const deadline = Date.now() + timeoutMs
	while (pending.size && Date.now() < deadline) {
		for (const svc of [...pending]) {
			if (await probe(svc.health)) {
				console.log(`  ✓ ${svc.name}`)
				pending.delete(svc)
			}
		}
		if (pending.size) await new Promise((r) => setTimeout(r, 1500))
	}
	if (pending.size) {
		const names = [...pending].map((s) => s.name).join(', ')
		die(`not healthy after ${timeoutMs / 1000}s: ${names} — check \`bin/dev logs <svc>\``)
	}
}

// ---- subcommands ---------------------------------------------------------------
/** @param {{ noInstall: boolean, attach: boolean }} flags */
async function up(flags) {
	mkdirSync(dataDir, { recursive: true })
	mkdirSync(databaseDir, { recursive: true })
	mkdirSync(databaseBackupsDir, { recursive: true })
	const services = buildServices(makeCtx())
	const enabled = services.filter((s) => s.enabled)
	if (sessionRunning()) {
		tmux('set-environment', '-g', 'ENSEMBLEWORKS_TMUX_CONF', tmuxConf)
		tmux('source-file', tmuxConf)
		console.log(`already running (tmux session '${session}').`)
	} else {
		if (!flags.noInstall) {
			console.log('==> bun install (skip with --no-install)')
			execFileSync('bun', ['install'], { cwd: repoDir, stdio: 'inherit' })
		}
		for (const s of services.filter((x) => !x.enabled)) console.log(`  - ${s.name} off: ${s.reason}`)
		const [first, ...rest] = enabled
		// Exported before the tmux SERVER starts, so canvas terminals inherit it.
		process.env.ENSEMBLEWORKS_TMUX_CONF = tmuxConf
		tmux('-f', tmuxConf, 'new-session', '-d', '-s', session, '-n', first.name, '-c', repoDir, hold(first.cmd, first.name))
		tmux('set-environment', '-g', 'ENSEMBLEWORKS_TMUX_CONF', tmuxConf)
		// -f above only applies when this call STARTS the tmux server; if the
		// contributor already had one running, the session came up without our
		// conf — source it unconditionally so the bindings always apply.
		tmux('source-file', tmuxConf)
		for (const s of rest) {
			tmux('new-window', '-t', session, '-n', s.name, '-c', repoDir, hold(s.cmd, s.name))
		}
		console.log('==> waiting for services')
		await waitHealthy(enabled)
	}
	cheatSheet(enabled)
	if (flags.attach) attach()
}

/** @param {import('./dev-lib.mjs').Service[]} enabled */
function cheatSheet(enabled) {
	const ctx = makeCtx()
	const url = originToString(ctx.publicOrigin) ?? `http://localhost:${PORTS.caddy}`
	const voice =
		enabled.some((s) => s.name === 'livekit') && ctx.livekitNodeIp
			? `\n  voice: LiveKit advertises ${ctx.livekitNodeIp} (media udp mux 7882)`
			: ''
	console.log(`
EnsembleWorks dev stack — ${url}${voice}
  windows: ${enabled.map((s) => s.name).join('  ')}
  bin/dev status | logs <svc> | restart <svc> | attach | down   (agents: status --json)
  tmux: prefix Ctrl-Space (Ctrl-b works too) — prefix+<n> switch window, prefix+d detach`)
}

function windowNames() {
	if (!sessionRunning()) return []
	return tmux('list-windows', '-t', session, '-F', '#{window_name}').trim().split('\n')
}

/** @param {{ json: boolean }} flags */
async function status(flags) {
	const services = buildServices(makeCtx())
	const windows = windowNames()
	const rows = []
	for (const s of services) {
		rows.push({
			name: s.name,
			enabled: s.enabled,
			reason: s.reason,
			window: windows.includes(s.name),
			healthy: s.enabled ? await probe(s.health) : null,
			health: s.health,
		})
	}
	if (flags.json) {
		console.log(JSON.stringify({ session, running: sessionRunning(), services: rows }, null, 2))
		return
	}
	console.log(`session '${session}': ${sessionRunning() ? 'running' : 'not running'}`)
	for (const r of rows) {
		const state = !r.enabled
			? `off — ${r.reason}`
			: r.healthy === true
				? 'healthy'
				: r.healthy === false
					? r.window
						? 'UNHEALTHY (window up, probe failing)'
						: 'not started'
					: r.window
						? 'running (no probe)'
						: 'not started'
		console.log(`  ${r.name.padEnd(15)} ${state}`)
	}
}

/** @param {string} name @param {number} tail */
function logs(name, tail) {
	if (!sessionRunning()) die(`session '${session}' is not running`)
	if (!windowNames().includes(name)) die(`no window '${name}' — bin/dev status lists services`)
	process.stdout.write(tmux('capture-pane', '-p', '-t', `${session}:${name}`, '-S', `-${tail}`))
}

/** @param {string} name */
function restart(name) {
	if (!sessionRunning()) die(`session '${session}' is not running — use bin/dev up`)
	const svc = buildServices(makeCtx()).find((s) => s.name === name)
	if (!svc) die(`unknown service '${name}' — bin/dev status lists services`)
	if (!svc.enabled) die(`'${name}' is disabled: ${svc.reason}`)
	if (windowNames().includes(name)) {
		tmux('respawn-window', '-k', '-t', `${session}:${name}`, hold(svc.cmd, svc.name))
	} else {
		tmux('new-window', '-t', session, '-n', svc.name, '-c', repoDir, hold(svc.cmd, svc.name))
	}
	console.log(`respawned ${name}`)
}

function down() {
	if (sessionRunning()) {
		tmux('kill-session', '-t', session)
		console.log(`killed tmux session '${session}'`)
	} else {
		console.log(`session '${session}' is not running`)
	}
	// Caddy reads the pane-close SIGHUP as "reload", not "exit", so it outlives
	// the session and keeps holding :8080 — which then blocks the next `up`
	// (and left a stale plain-HTTP caddy in front of a new TLS one). Reap any
	// stray caddy still serving our Caddyfile.
	spawnSync('pkill', ['-f', `caddy run --config ${path.join(repoDir, 'deploy', 'Caddyfile')}`], {
		stdio: 'ignore',
	})
}

function attach() {
	if (!sessionRunning()) die(`session '${session}' is not running — use bin/dev up`)
	const args = process.env.TMUX ? ['switch-client', '-t', session] : ['attach', '-t', session]
	const r = spawnSync('tmux', args, { stdio: 'inherit' })
	process.exit(r.status ?? 0)
}

function usage() {
	console.log(`bin/dev — the EnsembleWorks dev stack (tmux session '${session}')

  bin/dev up [--attach] [--no-install]   start everything (idempotent; bun install on fresh start)
  bin/dev down                           kill the session
  bin/dev status [--json]                per-service state (--json for agents)
  bin/dev logs <svc> [--tail N]          one service's scrollback (default 200 lines)
  bin/dev restart <svc>                  respawn one service window
  bin/dev attach                         enter the tmux session (prefix Ctrl-Space, prefix+d detaches)
  bin/dev doctor [--json]                environment check — every failure prints its remedy

Config: ~/.config/ensembleworks/dev.env (optional). State: ~/.local/share/ensembleworks/{data,databases,database-backups}.
Optional binaries light up more services: caddy, livekit-server, whisper-server, docker.`)
}

// ---- dispatch ------------------------------------------------------------------
const { values: flags, positionals } = parseArgs({
	args: process.argv.slice(2),
	options: {
		json: { type: 'boolean', default: false },
		attach: { type: 'boolean', default: false },
		'no-install': { type: 'boolean', default: false },
		tail: { type: 'string', default: '200' },
		help: { type: 'boolean', short: 'h', default: false },
	},
	allowPositionals: true,
})
const [cmd, arg] = positionals

if (flags.help || cmd === 'help') {
	usage()
	process.exit(0)
}

switch (cmd) {
	case 'up':
		await up({ noInstall: flags['no-install'], attach: flags.attach })
		break
	case 'down':
		down()
		break
	case 'status':
		await status({ json: flags.json })
		break
	case 'logs':
		logs(arg ?? die('usage: bin/dev logs <svc> [--tail N]'), Number(flags.tail))
		break
	case 'restart':
		restart(arg ?? die('usage: bin/dev restart <svc>'))
		break
	case 'attach':
		attach()
		break
	case 'doctor':
		process.exit(await runDoctor({ json: flags.json }))
		break
	case undefined:
		usage()
		break
	default:
		usage()
		process.exit(1)
}
