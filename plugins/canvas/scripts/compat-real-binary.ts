// Run: node --import tsx scripts/compat-real-binary.ts --previous <dir> --current <dir>
//      (or: npx tsx scripts/compat-real-binary.ts …)
//
// Canvas artifact viewer, stage 1a: the real-binary half of the §12
// compatibility tests. Each <dir> is a plugins/canvas directory inside a
// checkout of that release, already through `bb plugin build .`:
//
//   - the HOST is the release's built backend, <dir>/dist/server.js — the
//     bundle bb loads, canvas-model/doc/sync compiled in — driven through
//     createFakePluginHost the way bb drives it (rpc input validated against
//     that bundle's own contract; reload = build the incoming host, then
//     dispose the outgoing one);
//   - a PANEL of that release is its own sync client, the SyncClientPeer from
//     <dir>/../../canvas-sync/src, which repairs every import against that
//     release's canvas-model just as the panel does. It joins the way that
//     release's panel does (with or without schemaVersion).
//
// What is PERSISTED is listed by a raw Loro read of the rows with this
// checkout's canvas-doc (no repair), so it reports what the database holds,
// not what either build would keep.
//
// Scenarios:
//   (i)   previous writes ordinary shapes -> current loads it: all kept, format 1
//   (ii)  current writes an artifact -> previous loads it (BELOW the rollback
//         floor): observed, not asserted — this is why the floor exists
//   (iii) two current hosts overlapping on one database, both writing artifacts
//   (iv)  current against a room a newer plugin stamped: refused, rows untouched
//   plus  an already-open previous-release panel against current, in (i)
import { Buffer } from "node:buffer";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import type { SyncClientPeer } from "@ensembleworks/canvas-sync";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CANVAS_CHANNEL, CANVAS_SCHEMA_VERSION } from "../canvas/wire.js";
import { createBbTransport, envelopeBytesFor, newPeerId } from "../transport.js";

interface Build {
  name: string;
  host: (bb: BbPluginApi) => void | Promise<void>;
  Peer: typeof SyncClientPeer;
  /** This release's panel sends schemaVersion; the previous one's contract is strict and must not get it. */
  versioned: boolean;
}

const UPDATED = "Canvas has been updated. Reopen this panel to continue editing.";

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
    id, kind, parentId: "page:p", props, index: "a1",
    x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {},
  } as never;
}
const artifact = (id: string, title = artifactProps.title) => envelope(id, "artifact", { ...artifactProps, title });
const note = (id: string) => envelope(id, "note", {});

// ---- reporting ----

let failed = 0;
function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}
function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`}`);
}
function observe(label: string, value: unknown): void {
  console.log(`  OBSERVED  ${label}: ${JSON.stringify(value)}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- builds, hosts and panels ----

async function loadBuild(name: string, dir: string, versioned: boolean): Promise<Build> {
  const server = path.resolve(dir, "dist", "server.js");
  const sync = path.resolve(dir, "..", "..", "canvas-sync", "src", "index.ts");
  console.log(`${name}: host ${server}\n${" ".repeat(name.length)}  panel sync client ${sync}`);
  const host = ((await import(pathToFileURL(server).href)) as { default: Build["host"] }).default;
  const { SyncClientPeer: Peer } = (await import(pathToFileURL(sync).href)) as { SyncClientPeer: typeof SyncClientPeer };
  return { name, host, Peer, versioned };
}

/** A panel of `build` on `host`: its join, then its sync client over the rpc/realtime transport. */
async function openPanel(host: FakePluginHost, id: string, build: Build) {
  const rpc = host.harness.behavior.callRpc;
  const transport = createBbTransport({
    clientId: id,
    sendFrame: async (payload) => {
      await rpc("canvas_frame", build.versioned ? payload : { clientId: payload.clientId, data: payload.data });
    },
    onError: (error) => {
      throw error;
    },
  });
  await rpc("canvas_join", build.versioned ? { clientId: id, schemaVersion: CANVAS_SCHEMA_VERSION } : { clientId: id });
  const peer = new build.Peer({ peerId: newPeerId(), transport });
  let drained = 0;
  const pump = async (): Promise<void> => {
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
  await pump();
  await peer.ready();
  const shapes = () => peer.doc.listShapes().map((shape) => shape.id).sort();
  return { peer, pump, shapes };
}

async function hostShapes(host: FakePluginHost): Promise<string[]> {
  const debug = (await host.harness.behavior.callRpc("canvas_debug", null)) as { shapeIds: string[] };
  return [...debug.shapeIds].sort();
}

/** Dispose `host` as a reload does (dispose hooks, final compaction) but keep its storage. */
async function unload(host: FakePluginHost): Promise<FakePluginHost> {
  return host.harness.lifecycle.reload(() => {});
}

const logs = (host: FakePluginHost) => host.harness.inspection.logEntries.map((entry) => entry.message);

async function outcome(call: Promise<unknown>): Promise<string> {
  return call.then(() => "accepted", (error: Error) => error.message);
}

// ---- the database, read raw ----

function tables(db: BetterSqlite3.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

/** Shapes a fresh load would start from: stored snapshot + every logged update, no repair. */
function persisted(db: BetterSqlite3.Database): string[] {
  const snapshot = db.prepare(`SELECT blob FROM canvas_snapshot WHERE room = 'main'`).get() as
    | { blob: Buffer }
    | undefined;
  const doc = snapshot === undefined
    ? LoroCanvasDoc.create({ peerId: 9n })
    : LoroCanvasDoc.fromSnapshot(new Uint8Array(snapshot.blob), { peerId: 9n });
  const updates = db.prepare(`SELECT blob FROM canvas_updates WHERE room = 'main' ORDER BY seq`).all() as Array<{
    blob: Buffer;
  }>;
  for (const update of updates) doc.import(new Uint8Array(update.blob));
  return doc.listShapes().map((shape) => `${shape.id} (${shape.kind})`).sort();
}

function logged(db: BetterSqlite3.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM canvas_updates WHERE room = 'main'`).get() as { n: number }).n;
}

function formatRow(db: BetterSqlite3.Database): number | null {
  if (!tables(db).includes("canvas_format")) return null;
  const row = db.prepare(`SELECT version FROM canvas_format WHERE room = 'main'`).get() as { version: number } | undefined;
  return row?.version ?? null;
}

/** Every persisted row the plugin owns, blobs as hex, for a byte-for-byte comparison. */
function rowsOf(db: BetterSqlite3.Database): string {
  const out: Record<string, unknown[]> = {};
  for (const table of ["canvas_snapshot", "canvas_updates", "canvas_format", "_bb_migrations"]) {
    if (!tables(db).includes(table)) continue;
    out[table] = (db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Array<Record<string, unknown>>).map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString("hex") : v]))
    );
  }
  return JSON.stringify(out);
}

// ---- scenarios ----

async function scenarioI(previous: Build, current: Build): Promise<void> {
  heading("(i) previous writes a room with ordinary shapes -> current loads it");
  const host = createFakePluginHost({ pluginId: "canvas" });
  await previous.host(host.bb);
  const old = await openPanel(host, "old-panel", previous);
  old.peer.doc.putPage({ id: "page:p", name: "P" });
  old.peer.doc.commit();
  old.peer.putShape(note("shape:note"));
  old.peer.putShape(envelope("shape:geo", "geo", {}));
  await old.pump();
  const written = await hostShapes(host);
  observe("previous host holds", written);

  // The real upgrade path: bb builds the incoming host, then disposes the old one.
  const upgraded = await host.harness.lifecycle.reload(current.host);
  const db = upgraded.bb.storage.database();
  check("current keeps every shape", same(await hostShapes(upgraded), written), await hostShapes(upgraded));
  check("current stamps storage format 1", formatRow(db) === 1, formatRow(db));
  check("current logs its storage format at startup", logs(upgraded).includes("canvas storage format 1"));
  const fresh = await openPanel(upgraded, "new-panel", current);
  check("a current panel sees them", same(fresh.shapes(), written), fresh.shapes());

  // The previous release's panel, still open across the upgrade.
  const rpc = upgraded.harness.behavior.callRpc;
  const join = await outcome(rpc("canvas_join", { clientId: "old-panel" }));
  check("an already-open previous-release panel's join is refused", join === UPDATED, join);
  const frame = await outcome(rpc("canvas_frame", { clientId: "old-panel", data: "" }));
  check("…and so is its next frame (no auto-join back in)", frame === UPDATED, frame);

  const after = await unload(upgraded);
  check("after current unloads, the persisted room still has every shape", persisted(after.bb.storage.database()).length === 2);
  await after.harness.lifecycle.dispose();
}

async function scenarioII(previous: Build, current: Build): Promise<void> {
  heading("(ii) current writes an artifact -> previous loads it (BELOW the rollback floor; observed, not asserted)");

  console.log("  -- (ii-a) clean rollback: current unloads (final compaction), then previous loads");
  let host = createFakePluginHost({ pluginId: "canvas" });
  await current.host(host.bb);
  const writer = await openPanel(host, "new-panel", current);
  writer.peer.doc.putPage({ id: "page:p", name: "P" });
  writer.peer.doc.commit();
  writer.peer.putShape(artifact("shape:art"));
  writer.peer.putShape(note("shape:note"));
  await writer.pump();
  host = await unload(host);
  let db = host.bb.storage.database();
  observe("persisted after current unloads", persisted(db));
  observe("tables / canvas_format / logged updates", [tables(db), formatRow(db), logged(db)]);

  host = await host.harness.lifecycle.reload(previous.host);
  db = host.bb.storage.database();
  // reload() rethrows a factory failure, so getting here means previous's migrate() accepted the storage.
  observe("previous loaded over newer storage; _bb_migrations ids", (db.prepare(`SELECT id FROM _bb_migrations ORDER BY id`).all() as Array<{ id: number }>).map((r) => r.id));
  observe("previous host holds after load (snapshot only: no load-time repair)", await hostShapes(host));
  observe("an already-open CURRENT panel joining the rolled-back host", await outcome(host.harness.behavior.callRpc("canvas_join", { clientId: "new-panel", schemaVersion: CANVAS_SCHEMA_VERSION })));
  const panel = await openPanel(host, "old-panel", previous);
  observe("a previous-release panel's own doc after sync (its client repair ran)", panel.shapes());
  observe("previous host holds after that panel synced", await hostShapes(host));
  panel.peer.putShape(note("shape:edit"));
  await panel.pump();
  observe("previous host holds after that panel's first edit", await hostShapes(host));
  observe("persisted while previous is live", persisted(db));
  host = await unload(host);
  db = host.bb.storage.database();
  observe("persisted after previous unloads", persisted(db));
  observe("canvas_format after previous unloads (previous never reads or writes it)", formatRow(db));
  host = await host.harness.lifecycle.reload(current.host);
  observe("current, rolled forward again, holds", await hostShapes(host));
  await host.harness.lifecycle.dispose();

  console.log("  -- (ii-b) rollback by reload: previous is built while current is live with un-compacted updates");
  host = createFakePluginHost({ pluginId: "canvas" });
  await current.host(host.bb);
  const again = await openPanel(host, "new-panel", current);
  again.peer.doc.putPage({ id: "page:p", name: "P" });
  again.peer.doc.commit();
  again.peer.putShape(artifact("shape:art"));
  again.peer.putShape(note("shape:note"));
  await again.pump();
  observe("logged updates before the reload", logged(host.bb.storage.database()));
  host = await host.harness.lifecycle.reload(previous.host);
  db = host.bb.storage.database();
  observe("previous host holds after load (logged updates -> load-time repair)", await hostShapes(host));
  observe("persisted once current's final compaction has run", persisted(db));
  host = await unload(host);
  db = host.bb.storage.database();
  observe("persisted after previous unloads", persisted(db));
  host = await host.harness.lifecycle.reload(current.host);
  observe("current, rolled forward again, holds", await hostShapes(host));
  await host.harness.lifecycle.dispose();
}

async function scenarioIII(current: Build): Promise<void> {
  heading("(iii) two current hosts overlapping on one database, both writing artifacts");
  // bb's reload overlap is the window between building the incoming host and
  // disposing the outgoing one; the harness closes it inside reload(). So run
  // the two hosts as two fake hosts, the second on its own connection to the
  // first's database FILE — two live plugin instances on one storage, the
  // worst case of that window, held open while both take writes.
  const first = createFakePluginHost({ pluginId: "canvas" });
  const file = first.bb.storage.database().name;
  const second = createFakePluginHost({ pluginId: "canvas" });
  const own = new Database(file);
  own.pragma("busy_timeout = 5000");
  const sharedStorage = new Proxy(second.bb.storage, {
    get: (target, key, receiver) => (key === "database" ? () => own : Reflect.get(target, key, receiver)),
  });
  const secondBb = new Proxy(second.bb, {
    get: (target, key, receiver) => (key === "storage" ? sharedStorage : Reflect.get(target, key, receiver)),
  });

  await current.host(first.bb);
  const a = await openPanel(first, "a", current);
  a.peer.doc.putPage({ id: "page:p", name: "P" });
  a.peer.doc.commit();
  a.peer.putShape(artifact("shape:a-1", "A one"));
  await a.pump();

  await current.host(secondBb as BbPluginApi);
  const b = await openPanel(second, "b", current);
  b.peer.putShape(artifact("shape:b-1", "B one"));
  await b.pump();
  a.peer.putShape(artifact("shape:a-2", "A two"));
  await a.pump();

  const reader = new Database(file, { readonly: true });
  const firstGone = await unload(first); // the outgoing host's final compaction
  observe("persisted after the outgoing host's final compaction", persisted(reader));
  b.peer.putShape(artifact("shape:b-2", "B two"));
  await b.pump();
  const secondGone = await unload(second);
  const expected = ["shape:a-1 (artifact)", "shape:a-2 (artifact)", "shape:b-1 (artifact)", "shape:b-2 (artifact)"];
  check("after both unload, the database holds all four artifacts", same(persisted(reader), expected), persisted(reader));
  reader.close();
  own.close();
  const fresh = await firstGone.harness.lifecycle.reload(current.host);
  check("a fresh current host loads all four", same(await hostShapes(fresh), ["shape:a-1", "shape:a-2", "shape:b-1", "shape:b-2"]), await hostShapes(fresh));
  await fresh.harness.lifecycle.dispose();
  await secondGone.harness.lifecycle.dispose();
}

async function scenarioIV(current: Build): Promise<void> {
  heading("(iv) current against a room a newer plugin stamped");
  let host = createFakePluginHost({ pluginId: "canvas" });
  await current.host(host.bb);
  const writer = await openPanel(host, "writer", current);
  writer.peer.doc.putPage({ id: "page:p", name: "P" });
  writer.peer.doc.commit();
  writer.peer.putShape(artifact("shape:art"));
  writer.peer.putShape(note("shape:note"));
  await writer.pump();
  host = await unload(host);
  const db = host.bb.storage.database();
  observe("logged updates", logged(db));
  // What a newer plugin leaves behind: its format stamped above this build's.
  db.prepare(`UPDATE canvas_format SET version = 2 WHERE room = 'main'`).run();
  const before = rowsOf(db);

  host = await host.harness.lifecycle.reload(current.host);
  const rpc = host.harness.behavior.callRpc;
  const join = await outcome(rpc("canvas_join", { clientId: "c", schemaVersion: CANVAS_SCHEMA_VERSION }));
  check("join is refused with the format message", join.includes("storage format 2; this build reads up to 1"), join);
  const frame = await outcome(rpc("canvas_frame", { clientId: "c", data: "", schemaVersion: CANVAS_SCHEMA_VERSION }));
  check("a frame is refused the same way", frame === join, frame);
  check("the refused host loaded nothing", (await hostShapes(host)).length === 0);
  const status = await host.harness.behavior.runCli(["status"]);
  check("`canvas status` reports the refusal", status.stdout.includes("refused:"), status.stdout.trim().split("\n").at(-1));
  check("the refusal is logged", logs(host).some((m) => m.includes("Refusing to load, repair, or overwrite")));
  host = await unload(host);
  check("every row is byte-identical after load, refused calls and unload", rowsOf(host.bb.storage.database()) === before);
  await host.harness.lifecycle.dispose();
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { previous: { type: "string" }, current: { type: "string" } } });
  if (values.previous === undefined || values.current === undefined) {
    console.error("usage: compat-real-binary.ts --previous <plugins/canvas dir> --current <plugins/canvas dir>");
    process.exit(2);
  }
  const previous = await loadBuild("previous", values.previous, false);
  const current = await loadBuild("current", values.current, true);
  await scenarioI(previous, current);
  await scenarioII(previous, current);
  await scenarioIII(current);
  await scenarioIV(current);
  console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
