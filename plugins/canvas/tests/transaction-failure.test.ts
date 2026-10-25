import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { decode, encode, Frame } from "@ensembleworks/canvas-sync";
import { CanvasRoomHost } from "../canvas/room.js";
import { CANVAS_MIGRATIONS, CanvasStore } from "../canvas/store.js";
import type { CanvasServerMessage } from "../canvas/wire.js";

const shape = { id: "shape:not-durable", kind: "note", parentId: "page:p", index: "a1",
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as const;
function update() {
  const doc = LoroCanvasDoc.create({ peerId: 707n });
  doc.putPage({ id: "page:p", name: "P" }); doc.putShape(shape); doc.commit();
  return encode(Frame.Update, doc.exportUpdate());
}
function fixture(run: (db: Database.Database, reader: Database.Database) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "canvas-transaction-failure-"));
  const db = new Database(path.join(dir, "room.sqlite"));
  const reader = new Database(db.name);
  db.pragma("busy_timeout = 0"); reader.pragma("busy_timeout = 0");
  for (const sql of CANVAS_MIGRATIONS) db.exec(sql);
  try { run(db, reader); }
  finally { reader.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
}
const rows = (db: Database.Database) => JSON.stringify(
  ["canvas_snapshot", "canvas_updates", "canvas_format"].map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
);

/** Request with a real empty-doc version vector, as in the reviewer's leak. */
function observe(room: CanvasRoomHost, messages: CanvasServerMessage[]) {
  const observer = LoroCanvasDoc.create({ peerId: 708n });
  try { room.frame("observer", encode(Frame.SyncRequest, observer.versionBytes()), 2); }
  catch { /* a refused host is allowed to reject; it must never send history */ }
  for (const message of messages) {
    if (!("data" in message) || message.to !== "observer") continue;
    const frame = decode(new Uint8Array(Buffer.from(message.data, "base64")));
    if (frame.tag === Frame.Update) observer.import(frame.payload);
  }
  return observer.listShapes();
}

function assertQuarantined(room: CanvasRoomHost, db: Database.Database, messages: CanvasServerMessage[], before: string) {
  expect(observe(room, messages), "later SyncRequest must never publish rolled-back history").toEqual([]);
  expect(messages, "neither initial outbox nor later responses may leak").toEqual([]);
  expect(room.refusal).toContain("storage failure");
  expect(room.peer.doc.listShapes(), "failed live document is discarded").toEqual([]);
  expect(room.pendingUpdates).toBe(0);
  expect(room.clientCount).toBe(0);
  expect(room.touch("writer", 3)).toBe(false);
  expect(room.sweep(1e9)).toBe(0);
  room.leave("writer"); room.compact(); room.close(); room.close();
  expect(rows(db), "close must never persist rejected state").toBe(before);
  const reloaded = new CanvasRoomHost({ store: new CanvasStore(db), publish: () => {} });
  expect(reloaded.refusal).toBeNull();
  expect(reloaded.peer.doc.listShapes()).toEqual([]);
  reloaded.close();
}

describe("transaction failure quarantines live state", () => {
  for (const compactEvery of [1, 200]) {
    it(`real SQLITE_BUSY at outer COMMIT cannot leak on later sync/close (compactEvery=${compactEvery})`, () => fixture((db, reader) => {
      const messages: CanvasServerMessage[] = [];
      const room = new CanvasRoomHost({ store: new CanvasStore(db), compactEvery, publish: (m) => messages.push(m) });
      room.join("writer", 0); room.join("observer", 0); messages.length = 0;
      const before = rows(db);
      // DELETE journal SHARED lock allows BEGIN IMMEDIATE and writes, but
      // prevents COMMIT. Deterministic real SQLite failure, no timing hook.
      reader.exec("BEGIN"); reader.prepare("SELECT * FROM canvas_format").all();
      expect(() => room.frame("writer", update(), 1)).toThrow("database is locked");
      reader.exec("COMMIT");
      expect(rows(db)).toBe(before);
      expect(messages).toEqual([]);
      assertQuarantined(room, db, messages, before);
    }));
  }
  for (const failure of ["ABORT", "ROLLBACK"]) {
    it(`append ${failure} after import (including rollback of outer/savepoint) cannot leak`, () => fixture((db) => {
      const messages: CanvasServerMessage[] = [];
      const room = new CanvasRoomHost({ store: new CanvasStore(db), publish: (m) => messages.push(m) });
      room.join("writer", 0); room.join("observer", 0); messages.length = 0;
      const before = rows(db);
      db.exec(`CREATE TRIGGER fail_append BEFORE INSERT ON canvas_updates BEGIN SELECT RAISE(${failure}, 'disk rejected append'); END`);
      expect(() => room.frame("writer", update(), 1)).toThrow();
      db.exec("DROP TRIGGER fail_append");
      assertQuarantined(room, db, messages, before);
    }));
  }
  for (const phase of ["frame compaction", "explicit compaction", "close", "join", "frame begin"]) {
    it(`${phase} failure stops all subsequent serving/writes`, () => fixture((db, reader) => {
      const messages: CanvasServerMessage[] = [];
      const room = new CanvasRoomHost({ store: new CanvasStore(db), compactEvery: 1, publish: (m) => messages.push(m) });
      room.join("writer", 0); messages.length = 0;
      const before = rows(db);
      if (phase === "frame begin" || phase === "join") reader.exec("BEGIN IMMEDIATE");
      else { reader.exec("BEGIN"); reader.prepare("SELECT * FROM canvas_format").all(); }
      if (phase === "close") room.close();
      else expect(() => {
        if (phase === "explicit compaction") room.compact();
        else if (phase === "join") room.join("new", 1);
        else room.frame("writer", update(), 1);
      }).toThrow("database is locked");
      reader.exec("COMMIT");
      assertQuarantined(room, db, messages, before);
    }));
  }
  it("failed startup cannot expose a peer or stamp; next construction can retry", () => fixture((db, reader) => {
    reader.exec("BEGIN"); reader.prepare("SELECT * FROM canvas_format").all();
    expect(() => new CanvasRoomHost({ store: new CanvasStore(db), publish: () => { throw new Error("must not publish"); } })).toThrow("database is locked");
    reader.exec("COMMIT");
    expect(new CanvasStore(db).formatVersion("main")).toBeNull();
    const room = new CanvasRoomHost({ store: new CanvasStore(db), publish: () => {} });
    expect(room.refusal).toBeNull(); room.close();
  }));
});

it("failed pending import is discarded, including its causal cache", () => fixture((db, reader) => {
  const messages: CanvasServerMessage[] = [];
  const room = new CanvasRoomHost({ store: new CanvasStore(db), publish: (m) => messages.push(m) });
  room.join("writer", 0); room.join("observer", 0); messages.length = 0;
  const before = rows(db);
  const writer = LoroCanvasDoc.create({ peerId: 808n });
  writer.putPage({ id: "page:p", name: "P" }); writer.commit();
  const version = writer.versionBytes();
  const gap = writer.exportUpdate();
  writer.putShape(shape); writer.commit();
  reader.exec("BEGIN"); reader.prepare("SELECT * FROM canvas_format").all();
  expect(() => room.frame("writer", encode(Frame.Update, writer.exportUpdate(version)), 1)).toThrow("database is locked");
  reader.exec("COMMIT");
  try { room.frame("writer", encode(Frame.Update, gap), 2); } catch { /* refused */ }
  expect(room.peer.pendingImports).toBe(0);
  assertQuarantined(room, db, messages, before);
}));

it("reload recovers only committed history after an overlapping host advances storage", () => fixture((db, reader) => {
  const store = new CanvasStore(db);
  const room = new CanvasRoomHost({ store, publish: () => {} });
  room.join("writer", 0);
  reader.exec("BEGIN"); reader.prepare("SELECT * FROM canvas_format").all();
  expect(() => room.frame("writer", update(), 1)).toThrow("database is locked");
  reader.exec("COMMIT");
  const healthy = new CanvasRoomHost({ store: new CanvasStore(reader), publish: () => {} });
  const writer = LoroCanvasDoc.create({ peerId: 909n });
  writer.putPage({ id: "page:p", name: "P" });
  writer.putShape({ ...shape, id: "shape:committed" }); writer.commit();
  healthy.frame("other", encode(Frame.Update, writer.exportUpdate()), 2); healthy.close();
  const committed = rows(db);
  room.compact(); room.close();
  expect(rows(db), "failed host must not overwrite the healthy overlapping host").toBe(committed);
  const reloaded = new CanvasRoomHost({ store, publish: () => {} });
  expect(reloaded.peer.doc.listShapes().map(s => s.id)).toEqual(["shape:committed"]);
  reloaded.close();
}));

it("rollback cleanup failure leaves a connection suspect, never a serving peer", () => fixture((db) => {
  // SQLite's rollback may itself fail (e.g. I/O). Model that boundary with a
  // real transaction left OPEN after both injected failures. Nested writes
  // still use real savepoints; no automatic rebuild may read this connection.
  class BrokenRollbackStore extends CanvasStore {
    fail = false;
    override withCurrentFormat<T>(room: string, use: () => T): T {
      if (!this.fail) return super.withCurrentFormat(room, use);
      this.fail = false;
      db.exec("BEGIN IMMEDIATE");
      try { use(); throw new Error("injected COMMIT I/O failure"); }
      catch (cause) { throw new Error("injected ROLLBACK I/O failure", { cause }); }
    }
  }
  const store = new BrokenRollbackStore(db);
  const messages: CanvasServerMessage[] = [];
  const room = new CanvasRoomHost({ store, publish: m => messages.push(m) });
  room.join("writer", 0); room.join("observer", 0); messages.length = 0;
  const before = rows(db);
  store.fail = true;
  expect(() => room.frame("writer", update(), 1)).toThrow("ROLLBACK I/O failure");
  expect(db.inTransaction).toBe(true);
  expect(observe(room, messages), "suspect connection must not be used to rebuild live state").toEqual([]);
  expect(room.peer.doc.listShapes()).toEqual([]);
  room.compact(); room.close();
  expect(new CanvasStore(db).loadSnapshot("main")).toBeNull();
  expect(messages).toEqual([]);
  db.exec("ROLLBACK"); // external storage recovery, never done by the failed host
  assertQuarantined(room, db, messages, before);
}));
