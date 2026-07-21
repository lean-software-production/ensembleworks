/**
 * Shared tmux session primitive — one implementation of "open a tmux client
 * through a PTY, write/resize/read it," used by the server terminal gateway and
 * (later) the CLI connector. Transport-agnostic: it deals in raw bytes + a
 * resize/exit lifecycle; callers translate to the 5-message WS protocol
 * (contracts/terminal-protocol.ts) and own their own scrollback/fan-out.
 *
 * Bun/server-only (spawns a PTY via Bun.spawn). Reachable only through the
 * `@ensembleworks/contracts/session-manager` subpath — never the browser barrel.
 */
import { existsSync } from 'node:fs'
import { spawnPty, type Pty } from './pty.js'
import { TMUX_SESSION_PREFIX } from './constants.js'

/** How to spawn the tmux client on this host (the caller's policy). */
export interface SpawnSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface TmuxSession {
  onData(cb: (data: string) => void): void
  onExit(cb: () => void): void
  write(data: string): void
  /** integer-check + clamp cols[20..500]/rows[5..200] + changed-check; applies
   *  to the PTY and updates cols/rows. Returns true iff the size actually changed. */
  resize(cols: number, rows: number): boolean
  kill(): void
  readonly cols: number
  readonly rows: number
}

const COLS_MIN = 20
const COLS_MAX = 500
const ROWS_MIN = 5
const ROWS_MAX = 200
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

export function openTmuxSession(spec: SpawnSpec, cols: number, rows: number): TmuxSession {
  const pty: Pty = spawnPty(spec.file, spec.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: spec.cwd,
    env: spec.env,
  })
  let curCols = cols
  let curRows = rows

  return {
    onData: (cb) => pty.onData(cb),
    onExit: (cb) => pty.onExit(cb),
    write: (data) => pty.write(data),
    kill: () => pty.kill(),
    resize(cols, rows) {
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return false
      const c = clamp(cols, COLS_MIN, COLS_MAX)
      const r = clamp(rows, ROWS_MIN, ROWS_MAX)
      if (c === curCols && r === curRows) return false
      curCols = c
      curRows = r
      pty.resize(c, r)
      return true
    },
    get cols() {
      return curCols
    },
    get rows() {
      return curRows
    },
  }
}

/** The tmux grid bounds get one exported home (the same literals resize()
 *  clamps with; no second copy anywhere). session.go's getOrCreate clamps the
 *  initial grid BEFORE spawn — openTmuxSession stores its construction size
 *  unclamped (its clamp lives only in resize()), so the connector's session
 *  manager clamps here first. */
export function clampTmuxGrid(cols: number, rows: number): { cols: number; rows: number } {
	return { cols: clamp(cols, COLS_MIN, COLS_MAX), rows: clamp(rows, ROWS_MIN, ROWS_MAX) }
}

export interface CanvasTmuxSpawnOptions {
	sessionId: string
	/** tmux config path; `-f` is applied only when the file exists (missing conf
	 *  silently degrades clipboard/status-bar, never crashes — tmux.go semantics). */
	tmuxConf?: string
	/** cwd for the tmux client; defaults to $HOME then process.cwd(). */
	home?: string
}

/** Credential env vars the connector/gateway hold to authenticate, that a
 *  hosted canvas terminal must never inherit (it would let any terminal user
 *  exfiltrate the machine's service-token). Stripped in canvasTmuxSpawnSpec. */
export const SPAWN_ENV_SCRUB = [
	'ENSEMBLEWORKS_TOKEN_ID',
	'ENSEMBLEWORKS_TOKEN_SECRET',
	'CF_ACCESS_CLIENT_ID', // belt-and-suspenders: the pre-clean-break spelling
	'CF_ACCESS_CLIENT_SECRET',
] as const

/** The canvas tmux spawn policy shared by the server gateway and the connector:
 *  `tmux [-f conf] new-session -A -s canvas-<id>` with the xterm-256color /
 *  light-bg / conf-reload env. Behaviour-identical to terminal-gateway.ts's
 *  direct (non-RUN_AS) branch (charter §"#5"). */
export function canvasTmuxSpawnSpec(opts: CanvasTmuxSpawnOptions): SpawnSpec {
	const sessionName = `${TMUX_SESSION_PREFIX}${opts.sessionId}`
	const baseArgs = opts.tmuxConf && existsSync(opts.tmuxConf) ? ['-f', opts.tmuxConf] : []
	const parentEnv = { ...(process.env as Record<string, string>) }
	for (const k of SPAWN_ENV_SCRUB) delete parentEnv[k]
	const env: Record<string, string> = {
		...parentEnv,
		TERM: 'xterm-256color',
		COLORFGBG: '0;15', // light-bg hint for tmux < 3.4 (drops OSC 11 queries)
	}
	if (opts.tmuxConf) env.ENSEMBLEWORKS_TMUX_CONF = opts.tmuxConf // the `q` reload binding reads this
	// A tmux client with no LC_CTYPE-affecting var comes up non-UTF-8 and mangles
	// every non-Latin-1 glyph to "_" per cell. systemd units don't inherit the
	// host locale, so guarantee one here — without overriding an operator's choice.
	if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'C.UTF-8'
	return {
		file: 'tmux',
		args: [...baseArgs, 'new-session', '-A', '-s', sessionName],
		cwd: opts.home ?? process.env.HOME ?? process.cwd(),
		env,
	}
}

export interface CanvasShellSpawnOptions {
	/** shell binary; defaults to $SHELL then /bin/bash. */
	shell?: string
	/** cwd for the shell; defaults to $HOME then process.cwd(). */
	home?: string
}

/** The raw-shell spawn policy for connector-owned PTYs (EW Codespaces
 *  coexistence spec §6.1 / design doc §7): the user's login shell directly on
 *  the PTY — no tmux anywhere. Env hygiene is identical to canvasTmuxSpawnSpec:
 *  credential scrub, xterm-256color, light-bg hint, and the C.UTF-8 locale
 *  guarantee (same LC_CTYPE foot-gun, same non-override rule). Trade-off owned
 *  by the caller: sessions spawned this way die with the spawning process. */
export function canvasShellSpawnSpec(opts: CanvasShellSpawnOptions = {}): SpawnSpec {
	const parentEnv = { ...(process.env as Record<string, string>) }
	for (const k of SPAWN_ENV_SCRUB) delete parentEnv[k]
	const env: Record<string, string> = {
		...parentEnv,
		TERM: 'xterm-256color',
		COLORFGBG: '0;15', // light-bg hint (same rationale as canvasTmuxSpawnSpec)
	}
	if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'C.UTF-8'
	return {
		file: opts.shell ?? process.env.SHELL ?? '/bin/bash',
		args: ['-l'], // login shell (bash/zsh/fish all accept -l) — profile loads, like a Codespaces terminal
		cwd: opts.home ?? process.env.HOME ?? process.cwd(),
		env,
	}
}
