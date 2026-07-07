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
import WebSocket from 'ws'
import { canvasTmuxSpawnSpec, openTmuxSession } from '@ensembleworks/contracts/session-manager'
import type { ConnectConfig } from '../native/connect.ts'
import { runTransport, type Timers } from './relay-client.ts'
import { ConnectorSessionManager } from './session.ts'

const realTimers: Timers = {
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

export async function runConnector(
	cfg: ConnectConfig,
	headers: Record<string, string>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const conf = tmuxConfPath(env)
	const mgr = new ConnectorSessionManager((id, cols, rows) =>
		openTmuxSession(canvasTmuxSpawnSpec({ sessionId: id, tmuxConf: conf, home: env.HOME }), cols, rows),
	)
	const ac = new AbortController()
	const onSignal = () => ac.abort()
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
