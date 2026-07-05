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
import { spawnPty, type Pty } from './pty.js'

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
