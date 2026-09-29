// Durable canvas state in the plugin's own SQLite database.
//
// Snapshot + append-only update log, plus the format that wrote them:
//   canvas_snapshot(room, blob)  — one Loro snapshot per room, the compaction base
//   canvas_updates(room, seq, blob) — raw inbound Update payloads since that snapshot
//   canvas_format(room, version) — the newest storage format that has written the room
//
// Recovery is "restore the snapshot, then replay the log". Compaction writes a
// fresh snapshot and truncates the log in one transaction.
import type BetterSqlite3 from "better-sqlite3";
import { Buffer } from "node:buffer";

/**
 * The storage format this build reads and writes. Loading a room repairs it,
 * and repair drops every shape kind a build does not know — so a build must
 * never load, repair or compact a room stamped with a NEWER format than this
 * (see CanvasRoomHost's refused mode). Bump it when a newer build writes data
 * this one would destroy. Builds from before the stamp ignore the table.
 */
export const CANVAS_FORMAT_VERSION = 1;

/** What the refusing build says, in the log, the CLI and every rejected rpc. */
export function formatRefusal(room: string, stored: number): string {
  return `Canvas room "${room}" was saved by a newer Canvas plugin (storage format ${stored}; this build reads up to ${CANVAS_FORMAT_VERSION}). Refusing to load, repair, or overwrite it — update the Canvas plugin.`;
}

/** Thrown instead of writing to a room stamped with a newer format. */
export class CanvasFormatRefusedError extends Error {
  readonly room: string;
  readonly stored: number;
  readonly supported = CANVAS_FORMAT_VERSION;

  constructor(room: string, stored: number) {
    super(formatRefusal(room, stored));
    this.name = "CanvasFormatRefusedError";
    this.room = room;
    this.stored = stored;
  }
}

/** Everything persisted for one room, as compaction finds it. */
export interface StoredRoom {
  snapshot: Uint8Array | null;
  updates: Array<{ seq: number; bytes: Uint8Array }>;
}

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
  `CREATE TABLE IF NOT EXISTS canvas_format (
     room TEXT PRIMARY KEY,
     version INTEGER NOT NULL
   )`,
];

export class CanvasStore {
  readonly #db: BetterSqlite3.Database;

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

  /** The newest storage format stamped on this room, or null if none has been. */
  formatVersion(room: string): number | null {
    const row = this.#db
      .prepare<[string], { version: number }>(
        `SELECT version FROM canvas_format WHERE room = ?`,
      )
      .get(room);
    return row?.version ?? null;
  }

  /** Record that `version` has written this room. Only ever raises the stamp. */
  stampFormat(room: string, version: number): void {
    this.#db
      .prepare(
        `INSERT INTO canvas_format (room, version) VALUES (?, ?)
         ON CONFLICT(room) DO UPDATE SET version = MAX(version, excluded.version)`,
      )
      .run(room, version);
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
    // The seq is claimed from the table in the same statement, never from a
    // per-store counter: during a plugin reload two hosts (two stores) append
    // to one room, and a cached counter hands both the same seq.
    const row = this.#db
      .prepare<[string, Buffer, string], { seq: number }>(
        `INSERT INTO canvas_updates (room, seq, blob)
         SELECT ?, COALESCE(MAX(seq), 0) + 1, ? FROM canvas_updates WHERE room = ?
         RETURNING seq`,
      )
      .get(room, Buffer.from(payload), room);
    return row!.seq;
  }

  /**
   * Replace the snapshot with `build(stored)` and drop every log row it read,
   * atomically — or throw CanvasFormatRefusedError, writing nothing, if a
   * newer build has stamped the room since the caller last looked.
   *
   * `build` receives EVERYTHING stored for the room, not just what the caller
   * wrote: during a plugin reload two room hosts briefly overlap on one
   * database (bb builds the replacement before disposing the old one), and
   * each logs updates the other never imported. A snapshot of one host's doc
   * alone would drop the other's shapes, whether by truncating its rows or by
   * overwriting a snapshot it had already compacted them into. IMMEDIATE, so
   * no other connection can append between the read and the delete.
   */
  compact(room: string, build: (stored: StoredRoom) => Uint8Array): void {
    const write = this.#db.transaction(() => {
      const format = this.formatVersion(room);
      if (format !== null && format > CANVAS_FORMAT_VERSION) {
        throw new CanvasFormatRefusedError(room, format);
      }
      const updates = this.loadUpdates(room);
      const snapshot = build({ snapshot: this.loadSnapshot(room), updates });
      this.#db
        .prepare(
          `INSERT INTO canvas_snapshot (room, blob) VALUES (?, ?)
           ON CONFLICT(room) DO UPDATE SET blob = excluded.blob`,
        )
        .run(room, Buffer.from(snapshot));
      this.#db
        .prepare(`DELETE FROM canvas_updates WHERE room = ? AND seq <= ?`)
        .run(room, updates.at(-1)?.seq ?? 0);
    });
    write.immediate();
  }
}
