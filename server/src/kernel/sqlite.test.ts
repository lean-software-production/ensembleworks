// Run: bun src/kernel/sqlite.test.ts
// Locks the bun:sqlite-backed DatabaseSync adapter's contract (exec + prepared
// all/run/iterate) independently of a running server. Mirrors the surface
// sync-core's NodeSqliteWrapper / SQLiteSyncStorage consume.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from './sqlite.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-sqlite-test-'))
const db = new DatabaseSync(path.join(dir, 'test.sqlite'))

// journal_mode: WAL is enabled at construction (persisted in the DB header),
// which is what cut the sync server's fsync-heavy write amplification (#18).
const journalRows = db.prepare('PRAGMA journal_mode').all() as { journal_mode: string }[]
assert.equal(journalRows[0]?.journal_mode, 'wal', 'constructor enables WAL journal mode')

// exec: multi-statement DDL, no result.
db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)')

// prepared run: reports one changed row.
const insert = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)')
const r = insert.run('a', 'alpha')
assert.equal(Number(r.changes), 1, 'run reports one changed row')
insert.run('b', 'beta')

// prepared all: both rows, ordered.
const rows = db.prepare('SELECT k, v FROM kv ORDER BY k').all() as { k: string; v: string }[]
assert.deepEqual(rows, [{ k: 'a', v: 'alpha' }, { k: 'b', v: 'beta' }], 'all returns both rows')

// prepared iterate: yields each row lazily.
const seen: string[] = []
for (const row of db.prepare('SELECT k FROM kv ORDER BY k').iterate() as IterableIterator<{ k: string }>) {
  seen.push(row.k)
}
assert.deepEqual(seen, ['a', 'b'], 'iterate yields each row')

console.log('ok: bun:sqlite DatabaseSync adapter')
