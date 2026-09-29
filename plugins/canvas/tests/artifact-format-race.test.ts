import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { Frame, encode } from "@ensembleworks/canvas-sync";
import { CanvasStore, CANVAS_MIGRATIONS } from "../canvas/store.js";
import { CanvasRoomHost } from "../canvas/room.js";

const rows = (db: Database.Database) => JSON.stringify(
  ["canvas_snapshot", "canvas_updates", "canvas_format"].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()),
);

function fixture(run: (s: {
  db: Database.Database; other: Database.Database; store: CanvasStore;
  afterCheck: (hook: () => void) => void;
}) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "canvas-format-race-"));
  const db = new Database(path.join(dir, "room.sqlite"));
  const other = new Database(db.name);
  other.pragma("busy_timeout = 0");
  for (const sql of CANVAS_MIGRATIONS) db.exec(sql);
  let hook: (() => void) | undefined;
  class BarrierStore extends CanvasStore {
    override formatVersion(room: string) {
      const version = super.formatVersion(room);
      const next = hook;
      hook = undefined;
      next?.(); // exact check/use boundary; no sleeps or scheduling lottery
      return version;
    }
  }
  try { run({ db, other, store: new BarrierStore(db), afterCheck: (fn) => { hook = fn; } }); }
  finally { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
}

function update() {
  const doc = LoroCanvasDoc.create({ peerId: 123n });
  doc.putPage({ id: "page:p", name: "P" });
  doc.putShape({ id: "shape:late", kind: "note", parentId: "page:p", index: "a1",
    x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} });
  doc.commit();
  return encode(Frame.Update, doc.exportUpdate());
}

describe("stored-format atomicity", () => {
  for (const operation of ["startup", "frame", "append", "compact"] as const) {
    it(`${operation}: a competing stamp cannot commit between check and use`, () => fixture((s) => {
      s.store.stampFormat("main", 1);
      const room = operation === "startup" ? undefined : new CanvasRoomHost({ store: s.store, publish: () => {} });
      room?.join("c", 0);
      let attempted = false;
      let blocked = false;
      s.afterCheck(() => {
        attempted = true;
        try { s.other.prepare("UPDATE canvas_format SET version = 2 WHERE room = 'main'").run(); }
        catch (error) {
          if ((error as { code: string }).code !== "SQLITE_BUSY") throw error;
          blocked = true;
        }
      });
      let started = room;
      try {
        if (operation === "startup") started = new CanvasRoomHost({ store: s.store, publish: () => {} });
        if (operation === "frame") room!.frame("c", update(), 1);
        if (operation === "append") s.store.appendUpdate("main", new Uint8Array([1]));
        if (operation === "compact") room!.compact();
        expect(attempted, "the barrier must run").toBe(true);
        expect(blocked, "newer stamp must wait until this operation commits").toBe(true);
        s.other.prepare("UPDATE canvas_format SET version = 2 WHERE room = 'main'").run();
        const fenced = rows(s.db);
        const inMemory = started!.peer.doc.listShapes();
        expect(() => started!.frame("c", update(), 2)).toThrow("storage format 2");
        expect(started!.peer.doc.listShapes()).toEqual(inMemory);
        expect(started!.peer.malformedFrames).toBe(0);
        expect(started!.refusal).toContain("storage format 2");
        expect(started!.touch("c", 3)).toBe(false);
        started!.sweep(1e9);
        started!.leave("c");
        started!.compact();
        started!.close();
        expect(rows(s.db)).toBe(fenced);
      } finally { started?.close(); }
    }));
  }

  it("direct append and own-format stamping refuse after a newer stamp", () => fixture((s) => {
    s.store.stampFormat("main", 2);
    const fenced = rows(s.db);
    expect(() => s.store.appendUpdate("main", new Uint8Array([1]))).toThrow("storage format 2");
    expect(() => s.store.stampFormat("main", 1)).toThrow("storage format 2");
    expect(rows(s.db)).toBe(fenced);
  }));

  it("publishes update frames only after another connection can read the commit", () => fixture((s) => {
    let relayed = 0;
    const room = new CanvasRoomHost({ store: s.store, publish: (message) => {
      if (!("data" in message)) return;
      relayed++;
      expect(new CanvasStore(s.other).updateCount("main")).toBe(1);
      expect(s.db.inTransaction).toBe(false);
    } });
    try {
      room.join("writer", 0);
      room.join("reader", 0);
      room.frame("writer", update(), 1);
      expect(relayed).toBeGreaterThan(0);
    } finally { room.close(); }
  }));
});
