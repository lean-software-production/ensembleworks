/**
 * DatabaseSync — a bun:sqlite-backed drop-in for the surface node:sqlite's
 * DatabaseSync exposed, exactly what @tldraw/sync-core drives:
 * NodeSqliteWrapper calls exec()/prepare(); SQLiteSyncStorage calls the
 * prepared statement's all()/run()/iterate(). node:sqlite is absent under Bun,
 * so this adapter is what lets the sync server run from source on Bun.
 * Contract is locked by ./sqlite.test.ts.
 */
import { Database } from 'bun:sqlite'

export interface RunResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

export interface StatementSync {
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): RunResult
  iterate(...params: unknown[]): IterableIterator<unknown>
}

export class DatabaseSync {
  #db: Database

  constructor(filename: string) {
    this.#db = new Database(filename)
    // WAL mode replaces rollback-journal's create→fsync→delete cycle per write
    // transaction with append-to-WAL + periodic checkpoint, and synchronous=NORMAL
    // drops an fsync per commit (durability weakens only on OS crash, not app
    // crash). Under concurrent multi-user canvas writes this cut the sync
    // server's fsync-heavy disk I/O that stalled it into D-state (see #18).
    // Note: WAL adds -wal/-shm sidecar files next to the DB.
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA synchronous = NORMAL')
  }

  exec(sql: string): void {
    this.#db.exec(sql)
  }

  prepare(sql: string): StatementSync {
    const stmt = this.#db.prepare(sql)
    return {
      all: (...params) => stmt.all(...(params as never[])),
      run: (...params) => {
        const res = stmt.run(...(params as never[]))
        return { changes: res.changes, lastInsertRowid: res.lastInsertRowid }
      },
      iterate: (...params) => stmt.iterate(...(params as never[])),
    }
  }

  // Additive beyond the surface sync-core drives (it never closes its DBs):
  // releases the underlying handle so callers that own short-lived per-room
  // DBs (canvas-v2's DocumentActor / the C3 registry) can evict rooms without
  // leaking fds. After close, prepare() throws RangeError "Cannot use a
  // closed database"; statements prepared BEFORE the close refuse writes
  // ("Database has closed") but still serve reads — bun defers the real close
  // while statements are live (behavior pinned in ./sqlite.test.ts).
  close(): void {
    this.#db.close()
  }
}
