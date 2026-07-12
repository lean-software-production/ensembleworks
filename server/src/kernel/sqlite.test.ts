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

// close: releases the handle. Pinned to bun:sqlite's actual (probed)
// behavior — prepare() on a closed db throws RangeError "Cannot use a closed
// database"; a statement prepared BEFORE the close throws Error "Database
// has closed" on run() (writes), but its all()/iterate() STILL READ (bun
// defers the real close while live statements exist). Every write path is
// refused either way; a fresh handle on the same file works normally.
const preClosedRead = db.prepare('SELECT COUNT(*) AS c FROM kv')
const preClosedWrite = db.prepare("INSERT INTO kv (k, v) VALUES ('c', 'gamma')")
db.close()
assert.throws(() => db.prepare('SELECT 1'), /Cannot use a closed database/, 'prepare after close is refused')
assert.throws(() => preClosedWrite.run(), /Database has closed/, 'pre-close WRITE statement is refused after close')
assert.equal(
  (preClosedRead.all()[0] as { c: number }).c, 2,
  'quirk, pinned: a pre-close READ statement still works (bun defers close while statements are live)',
)
const db2 = new DatabaseSync(path.join(dir, 'test.sqlite'))
assert.equal((db2.prepare('SELECT COUNT(*) AS c FROM kv').all()[0] as { c: number }).c, 2, 'reopen sees the rows')
db2.close()

console.log('ok: bun:sqlite DatabaseSync adapter')
