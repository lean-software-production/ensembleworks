/**
 * PTY wrapper backing the shared tmux session manager: presents the node-pty
 * surface (spawn/onData/onExit/resize/write/kill) over Bun's built-in PTY.
 * node-pty is a native Node addon Bun cannot load — this is the replacement.
 * Internal to @ensembleworks/contracts (imported by session-manager.ts); reached
 * only via the ./session-manager subpath, never the browser barrel (index.ts).
 *
 * Bun PTY API pinned against Bun >= 1.3.14: output is delivered via the
 * `terminal.data` callback as Uint8Array (decoded here to a string), NOT a
 * readable stream; process exit comes from `proc.exited`, never the terminal's
 * own `exit` callback (which is PTY-stream lifecycle and fires twice).
 */
export interface PtyOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export interface Pty {
  onData(cb: (data: string) => void): void
  onExit(cb: () => void): void
  resize(cols: number, rows: number): void
  write(data: string): void
  kill(): void
}

export function spawnPty(file: string, args: string[], opts: PtyOptions): Pty {
  const decoder = new TextDecoder()
  let dataCb: ((data: string) => void) | null = null
  let exitCb: (() => void) | null = null

  // Bun delivers PTY output through the terminal `data` callback as a
  // Uint8Array; decode (stream:true so multi-byte UTF-8 isn't split at chunk
  // boundaries) and hand the caller a string. Key is `name`, not `term`.
  const proc = Bun.spawn([file, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      name: opts.name,
      data: (_term, chunk) => {
        if (dataCb) dataCb(decoder.decode(chunk, { stream: true }))
      },
    },
  })
  const term = proc.terminal! // the PTY handle from the spawned process.

  // Real subprocess exit — NOT terminal.exit (PTY-stream lifecycle, fires
  // twice). Release the PTY fd once the child is truly gone (node-pty closed it
  // on exit too; skipping this leaks a descriptor per terminated session).
  proc.exited.then(() => {
    if (exitCb) exitCb()
    term.close()
  })

  return {
    onData(cb) {
      dataCb = cb
    },
    onExit(cb) {
      exitCb = cb
    },
    resize(cols, rows) {
      term.resize(cols, rows)
    },
    write(data) {
      term.write(data)
    },
    kill() {
      proc.kill()
    },
  }
}
