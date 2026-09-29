// Run: npx vitest run tests/artifact-compat.test.ts
//
// Canvas artifact viewer, stage 1a — the compatibility reader. Nothing here
// renders or serves an artifact; this release only has to make sure that a
// Canvas build which KNOWS the `artifact` kind is never undone by one that
// does not. Every repair pass drops shapes of a kind the build lacks, so the
// danger is always an older reader writing its repaired view back:
//
//   - an older BUNDLE joining the live room (the schemaVersion gate), and
//   - an older or newer PLUGIN writing the room's SQLite (the stored format).
//
// Everything runs against the real store, room host and plugin factory, with
// createFakePluginHost standing in for bb.
import { Buffer } from "node:buffer";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { Frame, SyncClientPeer, encode, makePair } from "@ensembleworks/canvas-sync";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { bytesToBase64 } from "../canvas/base64.js";
import { CanvasRoomHost } from "../canvas/room.js";
import * as storeModule from "../canvas/store.js";
import { CANVAS_MIGRATIONS, CanvasStore } from "../canvas/store.js";
import * as wire from "../canvas/wire.js";
import {
  createBbTransport,
  envelopeBytesFor,
  newPeerId,
  type BbTransport,
} from "../transport.js";
import plugin from "../server.js";

const { CANVAS_CHANNEL } = wire;
// Read through the namespace so a build without the gate fails on the
// assertions below, not on a missing named import.
const SCHEMA = (wire as Record<string, unknown>).CANVAS_SCHEMA_VERSION as number;
const UPDATED = "Canvas has been updated. Reopen this panel to continue editing.";
const REFUSAL =
  'Canvas room "main" was saved by a newer Canvas plugin (storage format 2; this build reads up to 1). Refusing to load, repair, or overwrite it — update the Canvas plugin.';

const artifactProps = {
  w: 720,
  h: 540,
  schemaVersion: 1,
  source: "thread-storage",
  threadId: "thr_fixture01",
  path: "reports/deck/index.html",
  title: "Launch deck",
};

function envelope(id: string, kind: string, props: Record<string, unknown>) {
  return {
    id,
    kind,
    parentId: "page:p",
    props,
    index: "a1",
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
  } as never;
}

const artifact = (id: string) => envelope(id, "artifact", artifactProps);
const note = (id: string) => envelope(id, "note", {});

/** A base64 SyncRequest from an empty doc — the first frame any client sends. */
const SYNC_REQUEST = bytesToBase64(encode(Frame.SyncRequest, new Uint8Array()));

function makePump(host: FakePluginHost, transport: BbTransport, id: string) {
  let drained = 0;
  return async function pump(): Promise<void> {
    for (let turn = 0; turn < 50; turn += 1) {
      await transport.flush();
      const signals = host.harness.inspection.realtimeSignals;
      if (drained >= signals.length) return;
      const batch = signals.slice(drained);
      drained = signals.length;
      for (const signal of batch) {
        if (signal.channel !== CANVAS_CHANNEL) continue;
        const bytes = envelopeBytesFor(id, signal.payload);
        if (bytes !== null) transport.deliver(bytes);
      }
    }
    throw new Error("pump did not settle");
  };
}

/** An up-to-date client: versioned join + a real SyncClientPeer. */
async function connect(host: FakePluginHost, id: string) {
  const transport = createBbTransport({
    clientId: id,
    sendFrame: async (payload) => {
      await host.harness.behavior.callRpc("canvas_frame", payload);
    },
    onError: (error) => {
      throw error;
    },
  });
  await host.harness.behavior.callRpc("canvas_join", {
    clientId: id,
    schemaVersion: SCHEMA,
  });
  const peer = new SyncClientPeer({ peerId: newPeerId(), transport });
  const pump = makePump(host, transport, id);
  await pump();
  await peer.ready();
  return { peer, transport, pump };
}

async function debug(host: FakePluginHost) {
  return (await host.harness.behavior.callRpc("canvas_debug", null)) as {
    shapeIds: string[];
    clientIds: string[];
  };
}

type Rows = Record<string, Array<Record<string, unknown>>>;

/** Every persisted canvas row, blobs as hex, so two captures compare byte for byte. */
function rowsOf(db: BetterSqlite3.Database): Rows {
  const out: Rows = {};
  for (const table of ["canvas_snapshot", "canvas_updates", "canvas_format"]) {
    out[table] = (db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all() as Array<Record<string, unknown>>)
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            Buffer.isBuffer(value) ? value.toString("hex") : value,
          ]),
        )
      );
  }
  return out;
}

/** What a newer plugin would leave behind: its format table, stamped. */
function stampNewer(db: BetterSqlite3.Database, version: number): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS canvas_format (room TEXT PRIMARY KEY, version INTEGER NOT NULL)`,
  );
  db.prepare(
    `INSERT INTO canvas_format (room, version) VALUES ('main', ?)
     ON CONFLICT(room) DO UPDATE SET version = excluded.version`,
  ).run(version);
}

/** The shapes a fresh load would see: stored snapshot + every logged update. */
function persistedShapeIds(db: BetterSqlite3.Database): string[] {
  const snapshot = db
    .prepare(`SELECT blob FROM canvas_snapshot WHERE room = 'main'`)
    .get() as { blob: Buffer } | undefined;
  const doc = snapshot === undefined
    ? LoroCanvasDoc.create({ peerId: 9n })
    : LoroCanvasDoc.fromSnapshot(new Uint8Array(snapshot.blob), { peerId: 9n });
  const updates = db
    .prepare(`SELECT blob FROM canvas_updates WHERE room = 'main' ORDER BY seq`)
    .all() as Array<{ blob: Buffer }>;
  for (const update of updates) doc.import(new Uint8Array(update.blob));
  return doc.listShapes().map((shape) => shape.id).sort();
}

/**
 * Dispose `host` the way bb does on a reload — its dispose hooks (and so the
 * room's final compaction) run — but keep the storage, and hand back the
 * database as it stands afterwards. `dispose()` itself deletes the storage
 * root, which would leave nothing to inspect.
 */
async function disposeKeepingStorage(host: FakePluginHost) {
  const after = await host.harness.lifecycle.reload(() => {});
  return { after, db: after.bb.storage.database() };
}

describe("the schemaVersion gate", () => {
  it("is version 4 — distinct from main's gateless bundles and PR #118's 3", () => {
    expect(SCHEMA).toBe(4);
  });

  it("refuses every bundle that is not exactly this one, and leaves the artifact alone", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);
    const writer = await connect(host, "writer");
    writer.peer.doc.putPage({ id: "page:p", name: "P" });
    writer.peer.putShape(artifact("shape:art"));
    await writer.pump();
    expect((await debug(host)).shapeIds).toEqual(["shape:art"]);

    const rpc = host.harness.behavior.callRpc;
    await expect(rpc("canvas_join", { clientId: "gateless" })).rejects.toThrow(UPDATED);
    await expect(rpc("canvas_join", { clientId: "pr118", schemaVersion: 3 })).rejects.toThrow(UPDATED);
    await expect(rpc("canvas_join", { clientId: "future", schemaVersion: 5 })).rejects.toThrow(UPDATED);
    // An old tab that never re-joins still sends frames; auto-join must not
    // let it in through that door either.
    await expect(rpc("canvas_frame", { clientId: "old-frame", data: SYNC_REQUEST })).rejects.toThrow(UPDATED);

    const after = await debug(host);
    expect(after.clientIds).toEqual(["writer"]);
    expect(after.shapeIds).toEqual(["shape:art"]);

    const reader = await connect(host, "reader");
    expect(reader.peer.doc.getShape("shape:art")?.props).toEqual(artifactProps);

    await host.harness.lifecycle.dispose();
  });
});

describe("the stored format version", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) refuses a room saved by a newer plugin without mutating a single row", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, CANVAS_MIGRATIONS);
    // A snapshot plus a logged update, as the newer plugin left them.
    const doc = LoroCanvasDoc.create({ peerId: 77n });
    doc.putPage({ id: "page:p", name: "P" });
    doc.putShape(note("shape:seeded"));
    doc.commit();
    const base = doc.versionBytes();
    const snapshot = doc.exportSnapshot();
    doc.putShape(note("shape:logged"));
    doc.commit();
    db.prepare(`INSERT INTO canvas_snapshot (room, blob) VALUES ('main', ?)`).run(Buffer.from(snapshot));
    db.prepare(`INSERT INTO canvas_updates (room, seq, blob) VALUES ('main', 1, ?)`).run(
      Buffer.from(doc.exportUpdate(base)),
    );
    stampNewer(db, 2);
    const before = rowsOf(db);

    await plugin(host.bb);
    const rpc = host.harness.behavior.callRpc;
    await expect(rpc("canvas_join", { clientId: "a", schemaVersion: SCHEMA })).rejects.toThrow(REFUSAL);
    await expect(
      rpc("canvas_frame", { clientId: "a", data: SYNC_REQUEST, schemaVersion: SCHEMA }),
    ).rejects.toThrow(REFUSAL);

    // The read-only surfaces keep working, and loaded nothing.
    expect(await debug(host)).toMatchObject({ shapeIds: [], clientIds: [] });
    const status = await host.harness.behavior.runCli(["status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(REFUSAL);
    const json = await host.harness.behavior.runCli(["status", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ refusal: REFUSAL });

    vi.useFakeTimers();
    const service = host.harness.behavior.runService("canvas-gc");
    await vi.advanceTimersByTimeAsync(31_000);
    service.controller.abort();
    await service.done;
    vi.useRealTimers();

    expect(host.harness.inspection.logEntries.map((entry) => entry.message)).toContain(REFUSAL);
    const { after, db: kept } = await disposeKeepingStorage(host);
    expect(rowsOf(kept)).toEqual(before);
    await after.harness.lifecycle.dispose();
  });

  it("(b) keeps an artifact across a reload, props intact, and stamps format 1", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);
    const writer = await connect(host, "writer");
    writer.peer.doc.putPage({ id: "page:p", name: "P" });
    writer.peer.putShape(artifact("shape:art"));
    await writer.pump();

    const reloaded = await host.harness.lifecycle.reload(plugin);
    const reader = await connect(reloaded, "reader");
    expect(reader.peer.doc.getShape("shape:art")?.props).toEqual(artifactProps);
    const format = reloaded.bb.storage
      .database()
      .prepare(`SELECT version FROM canvas_format WHERE room = 'main'`)
      .get() as { version: number } | undefined;
    expect(format?.version).toBe(1);
    expect(reloaded.harness.inspection.logEntries.map((entry) => entry.message)).toContain(
      "canvas storage format 1",
    );

    await reloaded.harness.lifecycle.dispose();
  });

  it("(c) two overlapping hosts on one database never delete each other's shapes", () => {
    // A plugin reload builds the incoming host before the outgoing one is
    // disposed, and each has its own store. Both take writes in the overlap.
    // Plain notes on purpose: this is about the log and the snapshot, not
    // about any one kind, so it must hold on a build without `artifact` too.
    const db = new Database(":memory:");
    for (const statement of CANVAS_MIGRATIONS) db.exec(statement);
    const outgoing = new CanvasRoomHost({ store: new CanvasStore(db), publish: () => {} });
    const [outgoingServer, outgoingEnd] = makePair();
    outgoing.peer.connect(outgoingServer);
    const viaOutgoing = new SyncClientPeer({ peerId: 501n, transport: outgoingEnd });
    viaOutgoing.doc.putPage({ id: "page:p", name: "P" });
    viaOutgoing.doc.commit();
    viaOutgoing.putShape(note("shape:old-1"));

    const incoming = new CanvasRoomHost({ store: new CanvasStore(db), publish: () => {} });
    const [incomingServer, incomingEnd] = makePair();
    incoming.peer.connect(incomingServer);
    const viaIncoming = new SyncClientPeer({ peerId: 502n, transport: incomingEnd });
    viaIncoming.putShape(note("shape:new-1"));
    viaOutgoing.putShape(note("shape:old-2"));

    outgoing.close();
    expect(persistedShapeIds(db)).toEqual(["shape:new-1", "shape:old-1", "shape:old-2"]);

    viaIncoming.putShape(note("shape:new-2"));
    incoming.close();
    expect(persistedShapeIds(db)).toEqual([
      "shape:new-1",
      "shape:new-2",
      "shape:old-1",
      "shape:old-2",
    ]);

    const fresh = new CanvasRoomHost({ store: new CanvasStore(db), publish: () => {} });
    expect(fresh.peer.doc.listShapes().map((shape) => shape.id).sort()).toEqual([
      "shape:new-1",
      "shape:new-2",
      "shape:old-1",
      "shape:old-2",
    ]);
    fresh.close();
    db.close();
  });

  it("(d) a live host that finds a newer format stamped stops, drops its clients and writes nothing", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);
    const a = await connect(host, "a");
    a.peer.doc.putPage({ id: "page:p", name: "P" });
    a.peer.putShape(note("shape:before"));
    await a.pump();
    expect((await debug(host)).clientIds).toEqual(["a"]);

    // A newer plugin, loaded alongside, claims the room.
    const db = host.bb.storage.database();
    stampNewer(db, 2);
    const stamped = rowsOf(db);

    const rpc = host.harness.behavior.callRpc;
    await expect(rpc("canvas_join", { clientId: "b", schemaVersion: SCHEMA })).rejects.toThrow(REFUSAL);
    expect((await debug(host)).clientIds).toEqual([]);
    await expect(
      rpc("canvas_frame", { clientId: "a", data: SYNC_REQUEST, schemaVersion: SCHEMA }),
    ).rejects.toThrow(REFUSAL);
    expect(
      host.harness.inspection.logEntries.filter((entry) => entry.message === REFUSAL),
    ).toHaveLength(1);

    const { after, db: kept } = await disposeKeepingStorage(host);
    expect(rowsOf(kept)).toEqual(stamped);
    await after.harness.lifecycle.dispose();
  });

  it("(e) stampFormat only ever raises the stored version", () => {
    const db = new Database(":memory:");
    for (const statement of CANVAS_MIGRATIONS) db.exec(statement);
    const store = new CanvasStore(db) as CanvasStore & {
      formatVersion(room: string): number | null;
      stampFormat(room: string, version: number): void;
    };
    expect(store.formatVersion("main")).toBeNull();
    store.stampFormat("main", 1);
    expect(store.formatVersion("main")).toBe(1);
    store.stampFormat("main", 3);
    store.stampFormat("main", 1);
    expect(store.formatVersion("main")).toBe(3);
    expect(store.formatVersion("elsewhere")).toBeNull();
    db.close();
  });

  it("(e) compaction re-checks the format and refuses without writing", () => {
    const db = new Database(":memory:");
    for (const statement of CANVAS_MIGRATIONS) db.exec(statement);
    const host = new CanvasRoomHost({ store: new CanvasStore(db), publish: () => {} });
    const [server, end] = makePair();
    host.peer.connect(server);
    const client = new SyncClientPeer({ peerId: 601n, transport: end });
    client.doc.putPage({ id: "page:p", name: "P" });
    client.doc.commit();
    client.putShape(note("shape:n"));

    stampNewer(db, 2);
    const stamped = rowsOf(db);
    const Refused = (storeModule as Record<string, unknown>).CanvasFormatRefusedError as
      | (new (...args: never[]) => Error)
      | undefined;
    expect(Refused).toBeTypeOf("function");
    expect(() => new CanvasStore(db).compact("main", () => new Uint8Array([1]))).toThrow(Refused!);
    host.compact();
    expect(host.refusal).toBe(REFUSAL);
    host.close();
    expect(rowsOf(db)).toEqual(stamped);
    db.close();
  });
});
