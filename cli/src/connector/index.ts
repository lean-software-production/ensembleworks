/**
 * runConnector — the engine the #4 `terminal connect` slot calls. Builds the
 * ConnectorSessionManager with the shared canvasTmuxSpawnSpec factory (reading
 * the tmux conf from ENSEMBLEWORKS_TMUX_CONF / TMUX_CONF — real-FS paths only,
 * never import.meta-relative, so #7's `bun build --compile` is a no-op, spec §8),
 * installs a one-shot SIGINT/SIGTERM handler that aborts an internal
 * AbortController (mirroring main.go's signal.NotifyContext), awaits the
 * reconnect transport, and resolves the process exit code (0 on clean signal).
 * All imports are static (compile-safe).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import WebSocket from 'ws'
import { canvasShellSpawnSpec, canvasTmuxSpawnSpec, openTmuxSession, type SpawnSpec } from '@ensembleworks/contracts/session-manager'
import type { ConnectConfig } from '../native/connect.ts'
import { layoutFilePath, parseLayout, readProcCwd, serializeLayout } from './layout.ts'
import { runTransport, type Timers } from './relay-client.ts'
import { ConnectorSessionManager } from './session.ts'

export const realTimers: Timers = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h),
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (h) => clearInterval(h),
}

/** The tmux conf path is env-driven (the clean-break story #8 wires): the `q`
 *  reload binding + `-f` gate read it. Undefined → the helper skips `-f` and the
 *  session silently degrades clipboard/status-bar (never crashes). */
function tmuxConfPath(env: NodeJS.ProcessEnv): string | undefined {
	return env.ENSEMBLEWORKS_TMUX_CONF ?? env.TMUX_CONF
}

/** Per-session spawn policy behind the --backend flag: 'tmux' is the legacy
 *  default (sessions survive connector restarts via the tmux server); 'pty' is
 *  the connector-owned raw login shell (EW Codespaces coexistence spec §6.1 —
 *  accepted trade: shells die with the connector; host supervision mitigates).
 *  `cwd` is the SP4 layout seed: a restored session respawns in its last
 *  directory; absent → the HOME default. */
export function spawnSpecFor(backend: 'tmux' | 'pty', sessionId: string, env: NodeJS.ProcessEnv, cwd?: string): SpawnSpec {
	if (backend === 'pty') return canvasShellSpawnSpec({ shell: env.SHELL, home: cwd ?? env.HOME })
	return canvasTmuxSpawnSpec({ sessionId, tmuxConf: tmuxConfPath(env), home: cwd ?? env.HOME })
}

export async function runConnector(
	cfg: ConnectConfig,
	headers: Record<string, string>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const mgr = new ConnectorSessionManager((id, cols, rows, cwd) =>
		openTmuxSession(spawnSpecFor(cfg.backend, id, env, cwd), cols, rows),
	)

	// SP4 layout restore (decision #4) — pty backend only: tmux sessions ARE
	// their own layout (the tmux server survives us). Read is defensive: a
	// missing/corrupt file is a cold start, never a crash.
	const layoutFile = layoutFilePath(env)
	if (cfg.backend === 'pty') {
		let raw: string | null = null
		try {
			raw = readFileSync(layoutFile, 'utf8')
		} catch {
			// no layout — cold start
		}
		const layout = parseLayout(raw)
		if (layout) mgr.preseedLayout(layout)
	}

	const ac = new AbortController()
	const onSignal = () => {
		// Snapshot BEFORE aborting the transport — the shells are still alive,
		// so /proc/<pid>/cwd is readable. SIGTERM per decision #4; SIGINT gets
		// the same treatment (both are the supervisor's graceful-stop signals).
		if (cfg.backend === 'pty') {
			try {
				writeFileSync(layoutFile, serializeLayout(mgr.snapshotLayout(readProcCwd)))
			} catch {
				// snapshot is best-effort — never block shutdown
			}
		}
		ac.abort()
	}
	process.once('SIGINT', onSignal)
	process.once('SIGTERM', onSignal)
	try {
		await runTransport(cfg.wsUrl, headers, mgr, { timers: realTimers, rng: Math.random, WebSocketCtor: WebSocket }, ac.signal)
	} finally {
		process.off('SIGINT', onSignal)
		process.off('SIGTERM', onSignal)
	}
	return 0
}
