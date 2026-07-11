/**
 * CanvasV2Store — per-room append-log + snapshot SQLite for the room-host
 * DocumentActor (Task C2). One SQLite file per room, under a dir the caller
 * passes in (production callers point this at DATABASE_DIR/canvas-v2 — see
 * storage-geometry.ts; this store never touches the live tldraw room DBs).
 *
 * Two tables: `updates` is an append-only log of raw Loro update bytes
 * (`appendUpdate` is a single INSERT — one implicit SQLite transaction, so the
 * log is always a valid prefix even if the process dies mid-write). `snapshots`
 * holds at most one row (id = 0) recording a compacted snapshot and the seq
 * it folds in up to (`upto_seq`). `load()` returns that snapshot (if any) plus
 * every update strictly after `upto_seq`, in seq order — replaying snapshot +
 * updates reconstructs the exact converged state.
 *
 * bun:sqlite blob-copy probe (see store.test.ts): binding a Uint8Array to a
 * BLOB parameter and calling run() COPIES the bytes at bind time — verified by
 * inserting a buffer, mutating it after the call returns, and reading back the
 * original bytes. So appendUpdate/compact do NOT need to `.slice()` a payload
 * that aliases a reused frame buffer (as the DocumentActor's inbound
 * onUpdatePayload does per server-peer.ts's JSDoc) before calling.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from '../kernel/sqlite.ts'

export interface LoadedState {
	snapshot: Uint8Array | null
	updates: Uint8Array[]
}

export class CanvasV2Store {
	private db: DatabaseSync

	constructor(dir: string, roomId: string) {
		mkdirSync(dir, { recursive: true })
		this.db = new DatabaseSync(path.join(dir, `${roomId}.sqlite`))
		this.db.exec('CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, bytes BLOB NOT NULL)')
		this.db.exec(
			'CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY CHECK (id = 0), bytes BLOB NOT NULL, upto_seq INTEGER NOT NULL)',
		)
	}

	/** Append one update to the log. A single INSERT — atomic; never partially written. */
	appendUpdate(bytes: Uint8Array): void {
		this.db.prepare('INSERT INTO updates (bytes) VALUES (?)').run(bytes)
	}

	/** Snapshot row (if any) plus every update after the seq it folds in, in seq order. */
	load(): LoadedState {
		const snapRow = this.db.prepare('SELECT bytes, upto_seq FROM snapshots WHERE id = 0').all()[0] as
			| { bytes: Uint8Array; upto_seq: number | bigint }
			| undefined
		const snapshot = snapRow ? new Uint8Array(snapRow.bytes) : null
		const uptoSeq = snapRow ? Number(snapRow.upto_seq) : 0
		const rows = this.db.prepare('SELECT bytes FROM updates WHERE seq > ? ORDER BY seq ASC').all(uptoSeq) as {
			bytes: Uint8Array
		}[]
		return { snapshot, updates: rows.map((r) => new Uint8Array(r.bytes)) }
	}

	/**
	 * Compaction: persist a fresh snapshot covering every update currently in
	 * the log, then prune the rows it folds in.
	 *
	 * ORDER IS LOAD-BEARING: INSERT/UPSERT the snapshot FIRST, THEN DELETE the
	 * folded-in updates — never reverse it. A crash between the two statements
	 * (both wrapped in one transaction below, but a crash mid-transaction before
	 * commit still leaves the PRE-transaction state, and a crash after commit
	 * but before the WAL checkpoint can, in principle, still only ever leave
	 * either "neither happened" or "both happened" for a single committed
	 * transaction) leaves a harmless SUPERSET: snapshot present + updates that
	 * are already folded into it still on disk — `load()` returns
	 * snapshot.upto_seq correctly and simply reads a few already-applied rows
	 * as zero extra updates (uptoSeq filters them out). Reversing the order
	 * (DELETE then INSERT the snapshot) would risk losing data: a crash after
	 * the DELETE commits but before the snapshot INSERT commits leaves NEITHER
	 * the pruned updates NOR a snapshot recording them — an unrecoverable hole.
	 */
	compact(snapshot: Uint8Array): void {
		const maxSeq = Number(
			(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM updates').all()[0] as { m: number | bigint }).m,
		)
		this.db.exec('BEGIN')
		try {
			this.db
				.prepare(
					'INSERT INTO snapshots (id, bytes, upto_seq) VALUES (0, ?, ?) ' +
						'ON CONFLICT(id) DO UPDATE SET bytes = excluded.bytes, upto_seq = excluded.upto_seq',
				)
				.run(snapshot, maxSeq)
			this.db.prepare('DELETE FROM updates WHERE seq <= ?').run(maxSeq)
			this.db.exec('COMMIT')
		} catch (err) {
			this.db.exec('ROLLBACK')
			throw err
		}
	}
}
