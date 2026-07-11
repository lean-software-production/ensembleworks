// @ts-check
/**
 * bin/dev's host-side controller — the default when bin/dev runs OUTSIDE the
 * devcontainer. `up` starts the devcontainer, `down` stops it, and
 * status/logs/restart forward into it via `docker exec`. Every detection +
 * forwarding step is narrated to STDERR so a forwarded `status --json` keeps
 * clean, parseable stdout. node: builtins only (runs on a fresh clone).
 *
 * The engine that actually runs the tmux stack lives in dev-main.mjs and runs
 * INSIDE the container (or under ENSEMBLEWORKS_NATIVE=1). See resolveMode().
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { attachInstructions, forwardArgv, parsePortOffset, portsFor, workspaceDirFor } from './dev-lib.mjs'
import { probePort } from './dev-net.mjs'

/** @param {string} msg  narrate to stderr (keeps stdout clean for --json) */
function narrate(msg) {
	process.stderr.write(`bin/dev [host] · ${msg}\n`)
}
/** @param {string} msg @returns {never} */
function die(msg) {
	process.stderr.write(`bin/dev [host] · ${msg}\n`)
	process.exit(1)
}
/** @param {string} bin */
const onPath = (bin) => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0

/**
 * Find this repo's devcontainer by the label the devcontainer CLI stamps on it.
 * Running containers only by default; `all: true` includes stopped ones
 * (`devcontainer up` restarts a stopped container rather than recreating it,
 * so `up` must consider them when resolving the port offset).
 * @param {string} repoDir
 * @param {{ all?: boolean }} [opts]
 * @returns {{ id: string, name: string } | null}
 */
function findDevcontainer(repoDir, opts = {}) {
	if (!onPath('docker')) return null
	const out = spawnSync(
		'docker',
		[
			'ps',
			...(opts.all ? ['-a'] : []),
			'--filter',
			`label=devcontainer.local_folder=${repoDir}`,
			'--format',
			'{{.ID}} {{.Names}}',
		],
		{ encoding: 'utf8' },
	)
	const lines = (out.stdout ?? '').trim().split('\n').filter(Boolean)
	if (!lines.length) return null
	if (lines.length > 1) narrate(`${lines.length} devcontainers matched — using the first`)
	const [id, name] = lines[0].split(' ')
	return { id, name }
}

/**
 * When bin/dev runs from a linked git worktree, resolve the main checkout path
 * so devcontainer operations target the canonical folder (which carries the
 * devcontainer.local_folder label and the port bindings).
 * @param {string} repoDir
 * @returns {string}
 */
function resolveMainRepoDir(repoDir) {
	const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir, encoding: 'utf8' })
	if (r.status !== 0) return repoDir
	const firstLine = (r.stdout ?? '').split('\n').find((l) => l.startsWith('worktree '))
	if (!firstLine) return repoDir
	const mainPath = firstLine.slice('worktree '.length).trim()
	if (mainPath !== repoDir) narrate(`git worktree — targeting main checkout at ${mainPath}`)
	return mainPath
}

/**
 * The port offset a container was created with (containerEnv stamps it).
 * Missing/empty -> 0 (pre-offset containers).
 * @param {string} id
 * @returns {number}
 */
function containerOffset(id) {
	const out = spawnSync('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', id], {
		encoding: 'utf8',
	})
	const line = (out.stdout ?? '').split('\n').find((l) => l.startsWith('ENSEMBLEWORKS_PORT_OFFSET='))
	return parsePortOffset(line?.slice('ENSEMBLEWORKS_PORT_OFFSET='.length)) ?? 0
}

/**
 * The stack's port offset as configured on the host: env > .local/port-offset.
 * Returns null when neither is set (auto-pick may then choose one on `up`).
 * Dies on an invalid value.
 * @param {string} mainRepoDir
 * @returns {number | null}
 */
function configuredOffset(mainRepoDir) {
	const file = path.join(mainRepoDir, '.local', 'port-offset')
	const raw =
		process.env.ENSEMBLEWORKS_PORT_OFFSET ||
		(existsSync(file) ? readFileSync(file, 'utf8').trim() : '')
	if (!raw) return null
	const n = parsePortOffset(raw)
	if (n === null)
		die(`invalid port offset '${raw}' (ENSEMBLEWORKS_PORT_OFFSET or .local/port-offset) — use a non-negative integer, e.g. 100`)
	return n
}

/**
 * First free offset in {0, 100, …, 900}: free = neither the edge (caddy) nor
 * LiveKit's ICE-TCP host port answers on loopback. UDP isn't probed — it rides
 * the same offset. Used only when no offset is configured and no container is
 * already running for this checkout.
 * @returns {Promise<number | null>}
 */
async function pickFreeOffset() {
	for (const cand of [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
		const p = portsFor(cand)
		if (!(await probePort(p.caddy)) && !(await probePort(p.livekitTcp))) return cand
	}
	return null
}

/**
 * @param {string} repoDir  absolute host path to the repo
 * @param {string[]} argv    process.argv.slice(2) — subcommand + flags
 * @returns {Promise<never>}
 */
export async function runController(repoDir, argv) {
	const cmd = argv[0]
	const mainRepoDir = resolveMainRepoDir(repoDir)
	const workspaceDir = workspaceDirFor(mainRepoDir)
	narrate('not inside a devcontainer → controller mode')

	if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
		process.stdout.write(usage())
		process.exit(0)
	}

	const dc = findDevcontainer(mainRepoDir)

	if (cmd === 'up') {
		if (!onPath('docker')) die('docker is not on PATH — install Docker to run the devcontainer')
		if (!onPath('devcontainer'))
			die('the devcontainer CLI is required — install it: npm i -g @devcontainers/cli')
		let offset = configuredOffset(mainRepoDir)
		const upArgs = ['up', '--workspace-folder', mainRepoDir]
		if (dc) {
			narrate(`devcontainer '${dc.name}' already running — devcontainer up is idempotent`)
			const have = containerOffset(dc.id)
			if (offset !== null && offset !== have)
				narrate(
					`configured offset ${offset} != running container's ${have} — keeping ${have}; run \`bin/dev down\` first to apply the new offset`,
				)
			offset = have // a live container's published ports are immutable
		} else {
			const stopped = findDevcontainer(mainRepoDir, { all: true })
			if (stopped) {
				const have = containerOffset(stopped.id)
				if (offset === null || offset === have) {
					// Adopt the container's offset — don't write .local/port-offset;
					// persistence is an auto-pick-only concern.
					offset = have
					narrate(`stopped devcontainer '${stopped.name}' (port offset ${have}) — restarting it`)
				} else {
					narrate(
						`port offset changed ${have} → ${offset} — recreating the devcontainer (published ports are fixed at create)`,
					)
					upArgs.splice(1, 0, '--remove-existing-container')
				}
			} else if (offset === null) {
				offset = await pickFreeOffset()
				if (offset === null)
					die('no free port offset in 0..900 (probed caddy + livekit-tcp) — set ENSEMBLEWORKS_PORT_OFFSET')
				if (offset !== 0) {
					const f = path.join(mainRepoDir, '.local', 'port-offset')
					mkdirSync(path.dirname(f), { recursive: true })
					writeFileSync(f, `${offset}\n`)
					narrate(`default ports busy — picked port offset ${offset} (persisted to .local/port-offset)`)
				}
			}
		}
		const p = portsFor(offset)
		if (offset) narrate(`port offset ${offset} → edge http://localhost:${p.caddy}`)
		narrate(`starting → devcontainer ${upArgs.join(' ')}`)
		const r = spawnSync('devcontainer', upArgs, {
			stdio: 'inherit',
			// Consumed by ${localEnv:…} substitutions in .devcontainer/devcontainer.json
			// (published host ports) and containerEnv (the engine's offset).
			env: {
				...process.env,
				ENSEMBLEWORKS_PORT_OFFSET: String(offset),
				ENSEMBLEWORKS_HOSTPORT_CADDY: String(p.caddy),
				ENSEMBLEWORKS_HOSTPORT_LIVEKIT_TCP: String(p.livekitTcp),
				ENSEMBLEWORKS_HOSTPORT_LIVEKIT_UDP: String(p.livekitUdp),
			},
		})
		process.exit(r.status ?? 0)
	}

	if (cmd === 'down') {
		if (!dc) {
			narrate('no devcontainer running — nothing to stop')
			process.exit(0)
		}
		narrate(`stopping devcontainer '${dc.name}' → docker stop`)
		const r = spawnSync('docker', ['stop', dc.id], { stdio: 'inherit' })
		process.exit(r.status ?? 0)
	}

	if (cmd === 'attach') {
		if (!dc) die('no devcontainer running — start it with `bin/dev up` first')
		narrate(`devcontainer '${dc.name}' running — printing attach instructions (attach never nests tmux)`)
		const offset = configuredOffset(mainRepoDir) ?? 0
		process.stdout.write(`${attachInstructions(dc.id, offset ? `workspace-${offset}` : 'workspace')}\n`)
		process.exit(0)
	}

	if (cmd === 'doctor') {
		let ok = true
		for (const [name, present, fix] of /** @type {[string, boolean, string][]} */ ([
			['docker', onPath('docker'), 'install Docker'],
			['devcontainer CLI', onPath('devcontainer'), 'npm i -g @devcontainers/cli'],
		])) {
			process.stdout.write(`${present ? '✓' : '✗'} ${name.padEnd(16)} host prerequisite\n`)
			if (!present) {
				process.stdout.write(`     fix: ${fix}\n`)
				ok = false
			}
		}
		if (dc) {
			process.stdout.write("\n— forwarding to the devcontainer's own doctor —\n")
			narrate(`forwarding \`doctor\` → docker exec ${dc.name} bin/dev doctor`)
			const r = spawnSync('docker', forwardArgv(dc.id, workspaceDir, argv), { stdio: 'inherit' })
			process.exit(ok ? (r.status ?? 0) : 1)
		}
		process.stdout.write('\n(no devcontainer running — `bin/dev up`, then doctor checks inside too)\n')
		process.exit(ok ? 0 : 1)
	}

	// status / logs / restart / anything else → forward into the container.
	if (!dc) {
		die(
			`no devcontainer running (searched label devcontainer.local_folder=${mainRepoDir}) — start it with \`bin/dev up\``,
		)
	}
	narrate(`devcontainer '${dc.name}' running`)
	narrate(`forwarding \`${cmd}\` → docker exec -w ${workspaceDir} ${dc.name} bin/dev ${argv.join(' ')}`)
	const r = spawnSync('docker', forwardArgv(dc.id, workspaceDir, argv), { stdio: 'inherit' })
	process.exit(r.status ?? 0)
}

function usage() {
	return `bin/dev — drives the EnsembleWorks devcontainer from the host

  bin/dev up                 start the devcontainer (devcontainer up; picks a free port offset if the defaults are busy)
  bin/dev down               stop the whole devcontainer (docker stop)
  bin/dev status [--json]    forward into the container (agents: --json)
  bin/dev logs <svc> [-...]  forward one service's scrollback
  bin/dev restart <svc>      forward: respawn one service
  bin/dev doctor             host prerequisites, then the container's own doctor
  bin/dev attach             print instructions to attach (never nests tmux)

  Runs inside the container (or with ENSEMBLEWORKS_NATIVE=1) as the engine that
  actually manages the tmux stack. Detection is narrated on stderr.
`
}
