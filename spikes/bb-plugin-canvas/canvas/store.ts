// Durable canvas state in the plugin's own SQLite database.
//
// Two tables, snapshot + append-only update log:
//   canvas_snapshot(room, blob)  — one Loro snapshot per room, the compaction base
//   canvas_updates(room, seq, blob) — raw inbound Update payloads since that snapshot
//
// Recovery is "restore the snapshot, then replay the log". Compaction writes a
// fresh snapshot and truncates the log in one transaction.
import type BetterSqlite3 from "better-sqlite3";
import { Buffer } from "node:buffer";

/** Append-only (statement index = migration id). Never reorder or edit. */
export const CANVAS_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS canvas_snapshot (
     room TEXT PRIMARY KEY,
     blob BLOB NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS canvas_updates (
     room TEXT NOT NULL,
     seq INTEGER NOT NULL,
     blob BLOB NOT NULL,
     PRIMARY KEY (room, seq)
   )`,
  // The room transcript (see canvas/transcript.ts). Deliberately NOT part of
  // the canvas document: an utterance is not a shape, nobody edits it, and it
  // must be queryable by time/speaker/text — which is a table, not a CRDT.
  `CREATE TABLE IF NOT EXISTS canvas_transcript (
     id INTEGER PRIMARY KEY,
     ts INTEGER NOT NULL,
     speaker TEXT NOT NULL,
     text TEXT NOT NULL
   )`,
  // Every query this plugin runs is a time window (a tail, a "--since", a
  // mention's last-15-minutes) and every one of them reads it newest-first.
  `CREATE INDEX IF NOT EXISTS canvas_transcript_ts ON canvas_transcript (ts)`,
];

export class CanvasStore {
  readonly #db: BetterSqlite3.Database;
  /** Next seq per room, seeded from MAX(seq) on first use. One writer only. */
  readonly #nextSeq = new Map<string, number>();

  constructor(db: BetterSqlite3.Database) {
    this.#db = db;
  }

  loadSnapshot(room: string): Uint8Array | null {
    const row = this.#db
      .prepare<[string], { blob: Buffer }>(
        `SELECT blob FROM canvas_snapshot WHERE room = ?`,
      )
      .get(room);
    return row === undefined ? null : new Uint8Array(row.blob);
  }

  /** Every logged update since the snapshot, oldest first. */
  loadUpdates(room: string): Array<{ seq: number; bytes: Uint8Array }> {
    const rows = this.#db
      .prepare<[string], { seq: number; blob: Buffer }>(
        `SELECT seq, blob FROM canvas_updates WHERE room = ? ORDER BY seq ASC`,
      )
      .all(room);
    return rows.map((row) => ({ seq: row.seq, bytes: new Uint8Array(row.blob) }));
  }

  updateCount(room: string): number {
    const row = this.#db
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM canvas_updates WHERE room = ?`,
      )
      .get(room);
    return row?.n ?? 0;
  }

  /**
   * Append one raw Update payload and return the seq it was written at.
   * `Buffer.from` COPIES: canvas-sync's onUpdatePayload aliases the inbound
   * frame buffer, so retaining it without a copy would be a use-after-reuse
   * bug.
   */
  appendUpdate(room: string, payload: Uint8Array): number {
    const seq = this.#claimSeq(room);
    this.#db
      .prepare(`INSERT INTO canvas_updates (room, seq, blob) VALUES (?, ?, ?)`)
      .run(room, seq, Buffer.from(payload));
    return seq;
  }

  /**
   * Write a fresh snapshot and drop the log rows it supersedes, atomically.
   *
   * `upToSeq` bounds the delete to updates the caller's snapshot actually
   * contains. During a plugin reload two room hosts briefly overlap (bb builds
   * the replacement before disposing the old one), so an unbounded delete
   * would let the outgoing host truncate rows only the incoming one knows
   * about. Bounded, the worst case is a stale snapshot row plus surviving
   * newer updates — which replays to the same state.
   */
  compact(room: string, snapshot: Uint8Array, upToSeq: number): void {
    const write = this.#db.transaction((blob: Buffer) => {
      this.#db
        .prepare(
          `INSERT INTO canvas_snapshot (room, blob) VALUES (?, ?)
           ON CONFLICT(room) DO UPDATE SET blob = excluded.blob`,
        )
        .run(room, blob);
      this.#db
        .prepare(`DELETE FROM canvas_updates WHERE room = ? AND seq <= ?`)
        .run(room, upToSeq);
    });
    write(Buffer.from(snapshot));
  }

  #claimSeq(room: string): number {
    let next = this.#nextSeq.get(room);
    if (next === undefined) {
      const row = this.#db
        .prepare<[string], { max: number | null }>(
          `SELECT MAX(seq) AS max FROM canvas_updates WHERE room = ?`,
        )
        .get(room);
      next = (row?.max ?? 0) + 1;
    }
    this.#nextSeq.set(room, next + 1);
    return next;
  }
}
