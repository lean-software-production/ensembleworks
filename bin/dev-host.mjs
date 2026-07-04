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
import { spawnSync } from 'node:child_process'
import { attachInstructions, forwardArgv, workspaceDirFor } from './dev-lib.mjs'

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
 * @param {string} repoDir
 * @returns {{ id: string, name: string } | null}
 */
function findDevcontainer(repoDir) {
	if (!onPath('docker')) return null
	const out = spawnSync(
		'docker',
		['ps', '--filter', `label=devcontainer.local_folder=${repoDir}`, '--format', '{{.ID}} {{.Names}}'],
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
 * @param {string} repoDir  absolute host path to the repo
 * @param {string[]} argv    process.argv.slice(2) — subcommand + flags
 * @returns {never}
 */
export function runController(repoDir, argv) {
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
		if (dc) narrate(`devcontainer '${dc.name}' already running — devcontainer up is idempotent`)
		if (!onPath('docker')) die('docker is not on PATH — install Docker to run the devcontainer')
		if (!onPath('devcontainer'))
			die('the devcontainer CLI is required — install it: npm i -g @devcontainers/cli')
		narrate(`starting → devcontainer up --workspace-folder ${mainRepoDir}`)
		const r = spawnSync('devcontainer', ['up', '--workspace-folder', mainRepoDir], { stdio: 'inherit' })
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
		process.stdout.write(`${attachInstructions(dc.id)}\n`)
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

  bin/dev up                 start the devcontainer (devcontainer up)
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
