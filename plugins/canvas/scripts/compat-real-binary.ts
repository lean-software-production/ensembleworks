// See docs/artifact-release-n.md for commands, provenance and release gates.
// Compiled backend bundles run through the SDK fake lifecycle on real SQLite.
// Source sync peers model panels; this is NOT a browser or real BB loader test.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import type { Shape } from "@ensembleworks/canvas-model";
import type { SyncClientPeer } from "@ensembleworks/canvas-sync";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CANVAS_CHANNEL, CANVAS_SCHEMA_VERSION } from "../canvas/wire.js";
import { createBbTransport, envelopeBytesFor } from "../transport.js";
import { bytesToBase64 } from "../canvas/base64.js";

interface Build {
  host: (bb: BbPluginApi) => void | Promise<void>;
  Peer: typeof SyncClientPeer;
  versioned: boolean;
}
interface Future extends Build {
  artifactFrame: (shape: Shape, peerId: bigint) => Uint8Array;
  fixtureIdentity: string;
  file: string;
}
const UPDATED = "Canvas has been updated. Reopen this panel to continue editing.";
const props = { w: 720, h: 540, schemaVersion: 1, source: "thread-storage",
  threadId: "thr_fixture01", path: "reports/deck/index.html", title: "Launch deck" };
const shape = (id: string, kind: string, fields: Record<string, unknown>): Shape => ({
  id, kind, parentId: "page:p", props: fields, index: "a1", x: 0, y: 0,
  rotation: 0, isLocked: false, opacity: 1, meta: {},
}) as Shape;
const artifact = (id: string) => shape(id, "artifact", { ...props, title: id });
const note = (id: string) => shape(id, "note", {});
const same = isDeepStrictEqual;
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
let serial = 1000n;
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
async function scenario(label: string, run: () => Promise<void>) {
  console.log(`\n=== ${label} ===`);
  try { await run(); } catch (error) { failures++; console.error("FAIL scenario:", error); }
}
const outcome = (p: Promise<unknown>) => p.then(() => "accepted", (e: Error) => e.message);
const unload = (host: FakePluginHost) => host.harness.lifecycle.reload(() => {});
const hostIds = async (host: FakePluginHost) => ((await host.harness.behavior.callRpc("canvas_debug", null)) as { shapeIds: string[] }).shapeIds.sort();

async function loadBuild(dir: string, versioned: boolean): Promise<Build> {
  const host = (await import(pathToFileURL(path.resolve(dir, "dist/server.js")).href)).default as Build["host"];
  const Peer = (await import(pathToFileURL(path.resolve(dir, "../../canvas-sync/src/index.ts")).href)).SyncClientPeer as Build["Peer"];
  return { host, Peer, versioned };
}

async function panel(host: FakePluginHost, id: string, build: Build) {
  const rpc = host.harness.behavior.callRpc;
  const transport = createBbTransport({ clientId: id,
    sendFrame: async (payload) => { await rpc("canvas_frame", build.versioned ? payload : { clientId: payload.clientId, data: payload.data }); },
    onError: (error) => { throw error; },
  });
  await rpc("canvas_join", build.versioned ? { clientId: id, schemaVersion: CANVAS_SCHEMA_VERSION } : { clientId: id });
  const peer = new build.Peer({ peerId: ++serial, transport });
  let drained = 0;
  const pump = async () => {
    for (let i = 0; i < 50; i++) {
      await transport.flush();
      const signals = host.harness.inspection.realtimeSignals;
      if (drained >= signals.length) return;
      const batch = signals.slice(drained); drained = signals.length;
      for (const signal of batch) {
        if (signal.channel !== CANVAS_CHANNEL) continue;
        const bytes = envelopeBytesFor(id, signal.payload);
        if (bytes !== null) transport.deliver(bytes);
      }
    }
    throw new Error("pump did not settle");
  };
  await pump(); await peer.ready();
  return { peer, pump };
}
async function futureWrite(host: FakePluginHost, future: Future, value: Shape) {
  await host.harness.behavior.callRpc("canvas_frame", { clientId: "future-writer", schemaVersion: CANVAS_SCHEMA_VERSION,
    data: bytesToBase64(future.artifactFrame(value, ++serial)) });
}

function persisted(db: Database.Database): Shape[] {
  const doc = LoroCanvasDoc.create({ peerId: 999n });
  const snapshot = db.prepare("SELECT blob FROM canvas_snapshot WHERE room = 'main'").get() as { blob: Buffer } | undefined;
  if (snapshot) doc.import(snapshot.blob);
  for (const row of db.prepare("SELECT blob FROM canvas_updates WHERE room = 'main' ORDER BY seq").all() as { blob: Buffer }[]) doc.import(row.blob);
  return doc.listShapes().sort((a, b) => a.id.localeCompare(b.id));
}
function rows(db: Database.Database) {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name).filter((name) => /^canvas_[a-z_]+$/.test(name) || name === "_bb_migrations");
  return JSON.stringify(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
}
function withDb(host: FakePluginHost, db: Database.Database): BbPluginApi {
  const storage = new Proxy(host.bb.storage, { get(target, key, receiver) {
    return key === "database" ? () => db : Reflect.get(target, key, receiver);
  } });
  return new Proxy(host.bb, { get(target, key, receiver) {
    return key === "storage" ? storage : Reflect.get(target, key, receiver);
  } });
}

async function upgrade(previous: Build, current: Build) {
  let host = createFakePluginHost({ pluginId: "canvas" });
  try {
    await previous.host(host.bb);
    const old = await panel(host, "old", previous);
    old.peer.doc.putPage({ id: "page:p", name: "P" }); old.peer.doc.commit();
    old.peer.putShape(note("shape:note")); await old.pump();
    host = await host.harness.lifecycle.reload(current.host);
    check("N upgrades the tagged previous release without migration hash conflicts", same(await hostIds(host), ["shape:note"]));
    const rpc = host.harness.behavior.callRpc;
    check("old panel join refused before room access", await outcome(rpc("canvas_join", { clientId: "old" })) === UPDATED);
    check("old panel frame refused before room access", await outcome(rpc("canvas_frame", { clientId: "old", data: "" })) === UPDATED);
    const fresh = await panel(host, "new", current);
    check("N panel preserves ordinary data", fresh.peer.doc.getShape("shape:note")?.kind === "note");
  } finally { await host.harness.lifecycle.dispose(); }
}

async function rollback(previous: Build, current: Build, future: Future) {
  for (const compactFirst of [true, false]) {
    let host = createFakePluginHost({ pluginId: "canvas" });
    try {
      await future.host(host.bb);
      await futureWrite(host, future, artifact("shape:art"));
      // N must load and preserve future history, not originate it itself.
      host = await host.harness.lifecycle.reload(current.host);
      const n = await panel(host, "n", current);
      check("N preserves future fixture artifact props", same(n.peer.doc.getShape("shape:art"), artifact("shape:art")));
      check("N artifact repair is a no-op", n.peer.doc.repair().length === 0);
      n.peer.putShape(note("shape:note")); await n.pump();
      if (compactFirst) host = await unload(host);
      host = await host.harness.lifecycle.reload(previous.host);
      const old = await panel(host, "old", previous);
      old.peer.putShape(note("shape:edit")); await old.pump();
      host = await unload(host);
      const kept = persisted(host.bb.storage.database());
      check("N-1 deletes artifacts on rollback", !kept.some((s) => s.kind === "artifact") && kept.some((s) => s.id === "shape:note"), { compactFirst, ids: kept.map((s) => s.id) });
      host = await host.harness.lifecycle.reload(current.host);
      check("rolling forward cannot resurrect the deleted artifact", !(await hostIds(host)).includes("shape:art"));
    } finally { await host.harness.lifecycle.dispose(); }
  }
}

async function overlap(current: Build, future: Future) {
  for (const futureFirst of [true, false]) {
    let a = createFakePluginHost({ pluginId: "canvas" });
    let b = createFakePluginHost({ pluginId: "canvas" });
    const db = new Database(a.bb.storage.database().name);
    try {
      await current.host(a.bb);
      const n = await panel(a, "n", current);
      n.peer.doc.putPage({ id: "page:p", name: "P" }); n.peer.doc.commit();
      n.peer.putShape(note("shape:n-1")); await n.pump();
      await future.host(withDb(b, db));
      await futureWrite(b, future, artifact("shape:f-1"));
      n.peer.putShape(note("shape:n-2")); await n.pump();
      await futureWrite(b, future, artifact("shape:f-2"));
      if (futureFirst) { b = await unload(b); a = await unload(a); }
      else { a = await unload(a); b = await unload(b); }
      const kept = persisted(db);
      const expected = [artifact("shape:f-1"), artifact("shape:f-2"), note("shape:n-1"), note("shape:n-2")];
      check("N and future fixture overlap preserves all props", same(kept, expected), { futureFirst, ids: kept.map((s) => s.id) });
      a = await a.harness.lifecycle.reload(current.host);
      const reader = await panel(a, "reader", current);
      check("fresh N panel preserves overlapped artifacts", same(reader.peer.doc.getShape("shape:f-2"), artifact("shape:f-2")));
    } finally { await a.harness.lifecycle.dispose(); await b.harness.lifecycle.dispose(); db.close(); }
  }
}

// The child writes new-format DATA together with the stamp using its own
// SQLite connection/process. Each call finishes at the exact barrier; no
// sleeps, racing timeouts or merely sequential before-call stamps.
function claim(future: Future, file: string): string {
  const script = "const m = await import(process.argv[1]); console.log(m.claimNewerFormat(process.argv[2]));";
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, pathToFileURL(future.file).href, file], { encoding: "utf8", timeout: 15_000 });
  if (child.error || child.status !== 0) throw child.error ?? new Error(child.stderr);
  return child.stdout.trim();
}
async function barrier(current: Build, future: Future) {
  for (const boundary of ["startup", "frame", "close"] as const) {
    let host = createFakePluginHost({ pluginId: "canvas" });
    const db = host.bb.storage.database();
    let armed = boundary === "startup";
    let childResult: string | undefined;
    const hooked = new Proxy(db, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, { get(stmt, method) {
          if (method === "get") return (...args: unknown[]) => {
            const result = stmt.get(...args);
            if (armed && sql.includes("SELECT version FROM canvas_format")) {
              armed = false;
              childResult = claim(future, db.name);
            }
            return result;
          };
          const value = Reflect.get(stmt, method);
          return typeof value === "function" ? value.bind(stmt) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    try {
      await current.host(withDb(host, hooked));
      if (boundary === "frame") {
        const n = await panel(host, "n", current);
        armed = true;
        n.peer.putShape(note("shape:before-fence")); await n.pump();
      }
      if (boundary === "close") { armed = true; host = await unload(host); }
      check("format barrier prevents a concurrent newer stamp", childResult === "blocked", { boundary, childResult });
      check("future writer commits after N releases its lock", claim(future, db.name) === "committed");
      const before = rows(host.bb.storage.database());
      if (boundary === "close") host = await host.harness.lifecycle.reload(current.host);
      const rpc = host.harness.behavior.callRpc;
      const frame = await outcome(rpc("canvas_frame", { clientId: "late", schemaVersion: CANVAS_SCHEMA_VERSION, data: "" }));
      check("live or restarted N reports format refusal", frame.includes("storage format 2; this build reads up to 1"), frame);
      const join = await outcome(rpc("canvas_join", { clientId: "late", schemaVersion: CANVAS_SCHEMA_VERSION }));
      check("join reports the same refusal", join === frame);
      check("status exposes refusal", (await host.harness.behavior.runCli(["status"])).stdout.includes("refused:"));
      host = await unload(host);
      check("format refusal leaves every row unchanged", rows(host.bb.storage.database()) === before, boundary);
    } finally { await host.harness.lifecycle.dispose(); }
  }
}

async function main() {
  const { values } = parseArgs({ options: { previous: { type: "string" }, current: { type: "string" }, future: { type: "string" } } });
  if (!values.previous || !values.current || !values.future) throw new Error("usage: --previous <plugins/canvas> --current <plugins/canvas> --future <built test fixture.mjs>");
  const prior = JSON.parse(readFileSync(path.resolve(values.previous, "../../compat-provenance.json"), "utf8")) as Record<string, string>;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: values.current, encoding: "utf8" }).trim();
  const currentProvenance = path.resolve(values.current, "../../compat-provenance.json");
  const currentSource = existsSync(currentProvenance)
    ? JSON.parse(readFileSync(currentProvenance, "utf8")) as Record<string, string>
    : { baseCommit: git("rev-parse", "HEAD"), trackedDiffSha256: sha(git("diff", "--binary", "HEAD")) };
  const identities = {
    previous: { ...prior, serverSha256: sha(readFileSync(path.resolve(values.previous, "dist/server.js"))), appSha256: sha(readFileSync(path.resolve(values.previous, "dist/app.js"))), lockSha256: sha(readFileSync(path.resolve(values.previous, "package-lock.json"))) },
    current: { ...currentSource, serverSha256: sha(readFileSync(path.resolve(values.current, "dist/server.js"))), appSha256: sha(readFileSync(path.resolve(values.current, "dist/app.js"))) },
    future: { kind: "test fixture, not a release", serverSha256: sha(readFileSync(values.future)) },
  };
  console.log("IDENTITIES", JSON.stringify(identities));
  check("immutable build identities recorded", /^[a-f0-9]{40}$/.test(prior.commit ?? "") && Boolean(prior.ref));
  const previous = await loadBuild(values.previous, false);
  const current = await loadBuild(values.current, true);
  const module = await import(pathToFileURL(path.resolve(values.future)).href);
  const future: Future = { host: module.default, Peer: current.Peer, versioned: true,
    artifactFrame: module.artifactFrame, fixtureIdentity: module.fixtureIdentity, file: path.resolve(values.future) };
  check("future build explicitly identifies itself as a fixture", future.fixtureIdentity === "representative N+1 writer; not a release");
  await scenario("tagged N-1 -> N and old protocol panel", () => upgrade(previous, current));
  await scenario("future fixture -> N -> N-1 (snapshot and log rollback)", () => rollback(previous, current, future));
  await scenario("N / future fixture overlap, both disposal orders", () => overlap(current, future));
  await scenario("separate-process check/use interleavings and newer-format refusal", () => barrier(current, future));
  console.log("LIMITATIONS: prior is a tagged-source rebuild with recorded dependency reuse, not an original distributed plugin artifact. Future is a representative fixture, not released N+1. Panels are source sync peers; actual BB loader/browser old-panel behavior and the actual N/N+1 matrix remain release gates. Rows/BLOBs are compared, not entire SQLite file bytes.");
  console.log(failures === 0 ? "all checks passed" : `${failures} checks FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
await main();
