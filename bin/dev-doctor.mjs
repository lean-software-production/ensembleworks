// @ts-check
/**
 * bin/dev doctor — the prerequisites as executable checks instead of prose.
 * Every failing check prints its remedy; exit code 0 = ready to `bin/dev up`.
 * required = the stack can't run without it; optional = a service stays off.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { atLeast } from './dev-lib.mjs'
import {
	devEnvPath,
	makeCtx,
	onPath,
	repoDir,
	sessionRunning,
	wantedBun,
} from './dev-main.mjs'
import { probePort } from './dev-net.mjs'

/**
 * @typedef {{ name: string, level: 'required' | 'optional' | 'info',
 *             ok: boolean, detail: string, remedy?: string }} Check
 */

/** @param {{ json: boolean }} opts @returns {Promise<number>} */
export async function runDoctor(opts) {
	const ctx = makeCtx()
	/** @type {Check[]} */
	const checks = []

	// Bun: if we're executing, the floor gate in dev-main already passed (or
	// re-exec'd via mise) — report it for completeness.
	const runningBun = process.versions.bun
	checks.push({
		name: 'bun',
		level: 'required',
		ok: runningBun !== undefined && atLeast(runningBun, wantedBun),
		detail: runningBun
			? `bun ${runningBun} (want >= ${wantedBun} from .tool-versions)`
			: `not running under Bun (${process.version})`,
		remedy: `install Bun >= ${wantedBun}: \`mise use -g bun@${wantedBun}\` or https://bun.sh`,
	})

	const tmuxV = spawnSync('tmux', ['-V'], { encoding: 'utf8' })
	const tmuxVer = tmuxV.status === 0 ? (tmuxV.stdout.match(/(\d+\.\d+)/)?.[1] ?? '0') : null
	checks.push({
		name: 'tmux',
		level: 'required',
		ok: tmuxVer !== null && Number.parseFloat(tmuxVer) >= 3.3,
		detail: tmuxVer ? `tmux ${tmuxVer} (min 3.3)` : 'not on PATH',
		remedy: 'apt install tmux (>= 3.3, per deploy/runtime-requirements)',
	})

	checks.push({
		name: '.local ignored',
		level: 'required',
		ok: spawnSync('git', ['-C', repoDir, 'check-ignore', '-q', '.local/probe'], { stdio: 'ignore' }).status === 0,
		detail: 'the devcontainer keeps state+keys under <repo>/.local — it must never be committed',
		remedy: 'add a `.local/` line to .gitignore',
	})

	checks.push({
		name: 'caddy',
		level: 'optional',
		ok: ctx.has.caddy,
		detail: ctx.has.caddy ? 'on PATH' : 'missing — no :8080 edge (/dev/{port}, /livekit routes)',
		remedy: 'https://caddyserver.com/docs/install (min 2.7)',
	})
	checks.push({
		name: 'livekit-server',
		level: 'optional',
		ok: ctx.has.livekit,
		detail: ctx.has.livekit ? 'on PATH' : 'missing — voice/video stays disabled',
		remedy: 'install livekit-server 1.13.1 (deploy/runtime-requirements pin)',
	})
	checks.push({
		name: 'whisper-server',
		level: 'optional',
		ok: ctx.has.whisper,
		detail: ctx.has.whisper
			? `binary + model (${ctx.whisperModel})`
			: 'binary or model missing — no keyless transcription (a hosted STT_API_KEY also works)',
		remedy: `build whisper.cpp's whisper-server and put a ggml model at ${ctx.whisperModel} (or set WHISPER_MODEL)`,
	})
	checks.push({
		name: 'docker',
		level: 'optional',
		ok: ctx.has.docker,
		detail: ctx.has.docker ? 'on PATH (shared browser available)' : 'missing — shared browser off (optional)',
		remedy: 'install docker if you want the neko shared browser',
	})

	// Ports: only meaningful when OUR session isn't the thing holding them.
	if (!sessionRunning()) {
		const taken = []
		for (const [name, port] of Object.entries(ctx.ports).filter(
			// livekitUdp can't be detected by a TCP probe (it's a UDP mux) — skip it.
			([name]) => name !== 'livekitUdp' && (name !== 'neko' || ctx.has.docker),
		)) {
			if (await probePort(port)) taken.push(`${name}:${port}`)
		}
		checks.push({
			name: 'ports free',
			level: 'required',
			ok: taken.length === 0,
			detail: taken.length ? `already bound: ${taken.join(', ')}` : 'all service ports free',
			remedy: "stop whatever holds those ports (another checkout's stack?)",
		})
	}

	checks.push({
		name: 'dev.env',
		level: 'info',
		ok: existsSync(devEnvPath),
		detail: existsSync(devEnvPath)
			? `present at ${devEnvPath}`
			: `absent (${devEnvPath}) — fine: defaults are keyless`,
	})

	checks.push({
		name: 'port offset',
		level: 'info',
		ok: true,
		detail: ctx.portOffset
			? `+${ctx.portOffset} (session workspace-${ctx.portOffset}, edge :${ctx.ports.caddy})`
			: 'none (default ports)',
	})

	if (opts.json) {
		console.log(JSON.stringify({ checks }, null, 2))
	} else {
		for (const c of checks) {
			const mark = c.ok ? '✓' : c.level === 'required' ? '✗' : c.level === 'optional' ? '–' : ' '
			console.log(`${mark} ${c.name.padEnd(15)} ${c.detail}`)
			if (!c.ok && c.remedy) console.log(`     fix: ${c.remedy}`)
		}
	}
	const failed = checks.filter((c) => c.level === 'required' && !c.ok)
	if (!opts.json) {
		console.log(failed.length ? `\nnot ready: ${failed.map((c) => c.name).join(', ')}` : '\nready — bin/dev up')
	}
	return failed.length ? 1 : 0
}
