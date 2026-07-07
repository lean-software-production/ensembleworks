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
}
