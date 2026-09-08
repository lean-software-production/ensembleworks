// Run: npx vitest run   (or `npm test`)
//
// Drives the real thing end to end: a real SyncClientPeer talking to the real
// plugin backend through createFakePluginHost's rpc + realtime, with nothing
// between them but the transport adapters this plugin owns.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { PresenceStore, SyncClientPeer } from "@ensembleworks/canvas-sync";
import type { Presence } from "@ensembleworks/canvas-sync";
import { screenToWorld, type Camera } from "@ensembleworks/canvas-editor";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CanvasRoomHost } from "../canvas/room.js";
import { CANVAS_MIGRATIONS, CanvasStore } from "../canvas/store.js";
import { CANVAS_CHANNEL } from "../canvas/wire.js";
import { createPresencePublisher } from "../canvas/presence-publisher.js";
import {
  createBbTransport,
  envelopeBytesFor,
  isResyncFor,
  newPeerId,
  serverHelloEpoch,
  type BbTransport,
} from "../transport.js";
import plugin from "../server.js";

/** A minimal valid note shape, parented at a page the caller seeds. */
function shape(id: string) {
  return {
    id,
    kind: "note",
    parentId: "page:p",
    props: {},
    index: "a1",
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
  } as never;
}

/**
 * Couples one client transport to a fake host: drains new realtime signals
 * addressed to this client into `transport.deliver`, and keeps going while the
 * exchange produces more traffic (a handshake is several round trips).
 */
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

interface Connected {
  peer: SyncClientPeer;
  transport: BbTransport;
  pump: () => Promise<void>;
}

/** join + a real SyncClientPeer wired through createBbTransport. */
async function connect(host: FakePluginHost, id: string): Promise<Connected> {
  const transport = createBbTransport({
    clientId: id,
    sendFrame: async (payload) => {
      await host.harness.behavior.callRpc("canvas_frame", payload);
    },
    onError: (error) => {
      throw error;
    },
  });
  await host.harness.behavior.callRpc("canvas_join", { clientId: id });
  const peer = new SyncClientPeer({ peerId: newPeerId(), transport });
  const pump = makePump(host, transport, id);
  await pump();
  await peer.ready();
  return { peer, transport, pump };
}

interface DebugState {
  room: string;
  shapeIds: string[];
  clientIds: string[];
  identities: Record<string, string>;
  pendingUpdates: number;
  snapshotBytes: number;
}

async function debug(host: FakePluginHost): Promise<DebugState> {
  return (await host.harness.behavior.callRpc(
    "canvas_debug",
    null,
  )) as DebugState;
}

/** A room host wired to an in-memory database, with its publishes captured. */
function standaloneRoom() {
  const db = new Database(":memory:");
  // bb.storage.migrate is the host's job; apply the same statements by hand.
  for (const statement of CANVAS_MIGRATIONS) db.exec(statement);
  const store = new CanvasStore(db);
  const published: unknown[] = [];
  const host = new CanvasRoomHost({
    store,
    publish: (message) => published.push(message),
  });
  return { db, store, host, published };
}

describe("the room over bb rpc + realtime", () => {
  it("relays writes between clients and honors join/leave/auto-join", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);

    const a = await connect(host, "client-a");
    expect((await debug(host)).clientIds).toEqual(["client-a"]);

    // A client write reaches the server doc.
    a.peer.doc.putPage({ id: "page:p", name: "P" });
    a.peer.putShape(shape("shape:from-a"));
    await a.pump();
    expect((await debug(host)).shapeIds).toContain("shape:from-a");

    // ... and back out again to a late joiner, via the sync handshake.
    const b = await connect(host, "client-b");
    expect(b.peer.doc.listShapes().map((s) => s.id)).toEqual(["shape:from-a"]);

    // ... and b's own write relays back to a through the server peer.
    b.peer.doc.putShape(shape("shape:from-b"));
    b.peer.doc.commit();
    await b.pump();
    await a.pump();
    expect(
      a.peer.doc
        .listShapes()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["shape:from-a", "shape:from-b"]);

    // canvas_leave drops the transport.
    await host.harness.behavior.callRpc("canvas_leave", {
      clientId: "client-b",
    });
    expect((await debug(host)).clientIds).toEqual(["client-a"]);

    await host.harness.lifecycle.dispose();
  });

  it("auto-joins an unknown clientId and tells it to re-handshake", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);

    const orphan = createBbTransport({
      clientId: "client-c",
      sendFrame: async (payload) => {
        await host.harness.behavior.callRpc("canvas_frame", payload);
      },
    });
    const orphanPeer = new SyncClientPeer({
      peerId: newPeerId(),
      transport: orphan,
    });
    await orphan.flush();

    expect((await debug(host)).clientIds).toContain("client-c");
    // Auto-join restores the downstream channel but cannot repair the client's
    // doc — only a fresh handshake does, so the room asks for one.
    const resyncs = host.harness.inspection.realtimeSignals.filter(
      (signal) =>
        signal.channel === CANVAS_CHANNEL &&
        isResyncFor("client-c", signal.payload),
    );
    expect(resyncs).toHaveLength(1);

    orphanPeer.close();
    await host.harness.lifecycle.dispose();
  });

  it("keeps a silent-but-pinging client, and reports an unknown one", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);

    await host.harness.behavior.callRpc("canvas_join", {
      clientId: "watcher",
    });
    expect(
      await host.harness.behavior.callRpc("canvas_ping", {
        clientId: "watcher",
      }),
    ).toEqual({ connected: true });

    // The answer a panel acts on: this room has no transport for you, so
    // re-handshake rather than assume the ping repaired anything.
    expect(
      await host.harness.behavior.callRpc("canvas_ping", {
        clientId: "never-joined",
      }),
    ).toEqual({ connected: false });
    expect((await debug(host)).clientIds).toEqual(["watcher"]);

    await host.harness.lifecycle.dispose();
  });
});

describe("persistence", () => {
  it("survives a plugin reload and keeps accepting writes", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);

    const a = await connect(host, "client-a");
    a.peer.doc.putPage({ id: "page:p", name: "P" });
    a.peer.putShape(shape("shape:durable-1"));
    a.peer.putShape(shape("shape:durable-2"));
    await a.pump();
    expect((await debug(host)).shapeIds).toHaveLength(2);

    // reload() re-runs the factory against the SAME database (and only then
    // disposes the old load), so this exercises the real restore path.
    const reloaded = await host.harness.lifecycle.reload(plugin);
    const restored = await debug(reloaded);
    expect(restored.shapeIds.sort()).toEqual([
      "shape:durable-1",
      "shape:durable-2",
    ]);
    expect(restored.clientIds).toHaveLength(0);
    expect(restored.snapshotBytes).toBeGreaterThan(0);

    // A client that never re-joined keeps working: its next frame auto-joins
    // the NEW room host, and its write lands in the restored doc.
    const revived = await connect(reloaded, "client-a");
    revived.peer.doc.putShape(shape("shape:after-reload"));
    revived.peer.doc.commit();
    await revived.pump();
    expect((await debug(reloaded)).shapeIds).toContain("shape:after-reload");

    await reloaded.harness.lifecycle.dispose();
  });

  it("restores from the update log with no snapshot, then compacts on close", () => {
    const db = new Database(":memory:");
    for (const statement of CANVAS_MIGRATIONS) db.exec(statement);
    const store = new CanvasStore(db);

    // Two updates, logged the way onUpdatePayload logs them, with no snapshot.
    const writer = LoroCanvasDoc.create({ peerId: 42n });
    writer.putPage({ id: "page:p", name: "P" });
    writer.putShape(shape("shape:logged-1"));
    writer.commit();
    store.appendUpdate("main", writer.exportUpdate());
    const afterFirst = writer.versionBytes();
    writer.putShape(shape("shape:logged-2"));
    writer.commit();
    store.appendUpdate("main", writer.exportUpdate(afterFirst));

    expect(store.loadSnapshot("main")).toBeNull();
    expect(store.updateCount("main")).toBe(2);

    const host = new CanvasRoomHost({ store, publish: () => {} });
    expect(
      host.peer.doc
        .listShapes()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["shape:logged-1", "shape:logged-2"]);

    host.close();
    expect(store.loadSnapshot("main")).not.toBeNull();
    expect(store.updateCount("main")).toBe(0);
    db.close();
  });
});

describe("the idle sweep", () => {
  it("closes clients silent past the window", () => {
    const { db, host } = standaloneRoom();

    host.join("fresh", 1_000);
    host.join("stale", 1_000);
    host.frame("fresh", new Uint8Array([3, 0]), 200_000); // a SyncRequest keeps it alive

    expect(host.sweep(200_000)).toBe(1);
    expect(host.clientIds).toEqual(["fresh"]);
    // The swept transport was closed, so the server peer dropped it too.
    expect(host.peer.clientCount).toBe(1);

    host.close();
    db.close();
  });

  it("spares a client that only pings — a watched tab sends nothing else", () => {
    const { db, host } = standaloneRoom();

    host.join("watcher", 1_000);
    // 90s in: inside the 2-minute window, but the panel has sent no frame —
    // exactly the tab that used to be evicted and silently desync.
    expect(host.touch("watcher", 91_000)).toBe(true);

    expect(host.sweep(150_000)).toBe(0);
    expect(host.clientIds).toEqual(["watcher"]);

    // Stop pinging and it goes, as it should.
    expect(host.sweep(220_000)).toBe(1);
    expect(host.touch("watcher", 220_000)).toBe(false);

    host.close();
    db.close();
  });
});

describe("BbTransport", () => {
  it("honors the canvas-sync Transport contract", async () => {
    const sent: string[] = [];
    const transport = createBbTransport({
      clientId: "t",
      sendFrame: async (payload) => {
        sent.push(payload.data);
      },
    });
    let closes = 0;
    let received: Uint8Array | null = null;
    transport.onClose(() => {
      closes += 1;
    });
    transport.onMessage((bytes) => {
      received = bytes;
    });

    transport.send(new Uint8Array([1, 2, 3]));
    await transport.flush();
    expect(sent).toHaveLength(1);

    transport.deliver(new Uint8Array([9]));
    expect(received).toEqual(new Uint8Array([9]));

    transport.close();
    transport.close();
    expect(closes).toBe(1);

    transport.send(new Uint8Array([4]));
    await transport.flush();
    expect(sent).toHaveLength(1);
    transport.deliver(new Uint8Array([5]));
    expect(received).toEqual(new Uint8Array([9]));
  });

  it("serializes outbound frames in send order", async () => {
    // The SyncRequest handshake and every Update depend on ordering, and each
    // send is an independent async rpc call.
    const order: number[] = [];
    const ordered = createBbTransport({
      clientId: "t",
      sendFrame: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        order.push(payload.data.length);
      },
    });
    for (let i = 1; i <= 6; i += 1) ordered.send(new Uint8Array(i * 3));
    await ordered.flush();
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });
});

describe("realtime payload decoders", () => {
  it("envelopeBytesFor only accepts envelopes addressed to this client", () => {
    expect(envelopeBytesFor("me", { to: "me", data: "AQID" })).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(envelopeBytesFor("me", { to: "you", data: "AQID" })).toBeNull();
    expect(envelopeBytesFor("me", null)).toBeNull();
    expect(envelopeBytesFor("me", { to: "me" })).toBeNull();
  });

  it("isResyncFor only accepts a resync push addressed to this client", () => {
    expect(isResyncFor("me", { to: "me", resync: true })).toBe(true);
    expect(isResyncFor("me", { to: "you", resync: true })).toBe(false);
    expect(isResyncFor("me", { to: "me" })).toBe(false);
    expect(isResyncFor("me", null)).toBe(false);
  });

  // Three decoders run against every publish on the one shared channel, so at
  // most one may match any payload: a false positive would silently swallow
  // frames, or resync on every one of them.
  it("never lets two decoders match one payload", () => {
    const hello = { hello: 1717171717 };
    const envelope = { to: "me", data: "AQID" };
    const resync = { to: "me", resync: true } as const;

    expect(serverHelloEpoch(hello)).toBe(1717171717);
    expect(envelopeBytesFor("me", hello)).toBeNull();
    expect(isResyncFor("me", hello)).toBe(false);

    expect(serverHelloEpoch(envelope)).toBeNull();
    expect(isResyncFor("me", envelope)).toBe(false);

    expect(serverHelloEpoch(resync)).toBeNull();
    expect(envelopeBytesFor("me", resync)).toBeNull();

    expect(serverHelloEpoch({ hello: "soon" })).toBeNull();
    expect(serverHelloEpoch(null)).toBeNull();
  });
});

describe("the server hello", () => {
  // A plugin reload throws away every server-side transport while browser tabs
  // keep their peers alive. `canvas-gc`'s first tick publishes the hello that
  // tells an IDLE tab to re-join.
  it("is published exactly once per plugin load", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);
    const service = host.harness.behavior.runService("canvas-gc");
    await Promise.resolve();

    const hellos = host.harness.inspection.realtimeSignals.filter(
      (signal) =>
        signal.channel === CANVAS_CHANNEL &&
        serverHelloEpoch(signal.payload) !== null,
    );
    expect(hellos).toHaveLength(1);

    service.controller.abort();
    await service.done;
    await host.harness.lifecycle.dispose();
  });
});

describe("the presence publisher", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const camera: Camera = { x: 0, y: 0, z: 1 };

  function publisherRig() {
    const store = new PresenceStore("me");
    const publishes: Presence[] = [];
    vi.spyOn(store, "publish").mockImplementation((p: Presence) => {
      publishes.push(p);
    });
    let clock = 0;
    const publisher = createPresencePublisher(store, {
      intervalMs: 60,
      now: () => clock,
    });
    return {
      store,
      publishes,
      publisher,
      advance(ms: number) {
        clock += ms;
        vi.advanceTimersByTime(ms);
      },
    };
  }

  it("flushes the LAST throttled sample once the window closes", () => {
    vi.useFakeTimers();
    const rig = publisherRig();

    // Leading edge publishes immediately.
    rig.publisher.setCursorFromScreen({ x: 0, y: 0 }, camera);
    expect(rig.publishes).toHaveLength(1);

    // Two more samples inside the window, then the pointer stops. Without a
    // trailing flush the peer would keep rendering (10, 10) forever.
    rig.advance(10);
    rig.publisher.setCursorFromScreen({ x: 10, y: 10 }, camera);
    rig.advance(10);
    rig.publisher.setCursorFromScreen({ x: 20, y: 20 }, camera);
    expect(rig.publishes).toHaveLength(1);

    rig.advance(60);
    expect(rig.publishes).toHaveLength(2);
    expect(rig.publishes[1]!.cursor).toEqual(
      screenToWorld(camera, { x: 20, y: 20 }),
    );

    rig.publisher.dispose();
    rig.store.destroy();
  });

  it("does not publish after dispose", () => {
    vi.useFakeTimers();
    const rig = publisherRig();

    rig.publisher.setCursorFromScreen({ x: 0, y: 0 }, camera);
    rig.advance(10);
    rig.publisher.setCursorFromScreen({ x: 10, y: 10 }, camera);
    expect(rig.publishes).toHaveLength(1);

    rig.publisher.dispose();
    rig.advance(120);
    expect(rig.publishes).toHaveLength(1);

    // Including the page write, which otherwise bypasses the throttle: a
    // closed peer must never reach the wire by any path.
    rig.publisher.setPage("page:a");
    expect(rig.publishes).toHaveLength(1);

    rig.store.destroy();
  });

  // ---- the page this peer is looking at (design doc D-4) ------------------
  // The rest of D-4 — the pure decisions, the adapter and the panel wiring —
  // is tests/page-presence.test.ts. These live here because this is where the
  // publisher's clock rig is.

  it("says nothing about a page it has not been told", () => {
    vi.useFakeTimers();
    const rig = publisherRig();

    rig.publisher.setCursorFromScreen({ x: 0, y: 0 }, camera);
    // null is UNKNOWN, and unknown is what a reader must see rather than a
    // guessed or inherited page id.
    expect(rig.publishes[0]!.page).toBeNull();

    rig.publisher.dispose();
    rig.store.destroy();
  });

  it("publishes a page switch at once, bypassing the throttle", () => {
    vi.useFakeTimers();
    const rig = publisherRig();

    // WHY THE BYPASS. A switch is user-initiated and rare — bounded by human
    // click rate, not pointer-move rate — and until it lands, everyone on the
    // page just left still draws this cursor as if it were there. That is the
    // "wrong and looks right" report D-4 exists to kill, so it does not wait
    // out a throttle window (the same call clearCursor makes, for the same
    // reason: no later event is guaranteed to carry it).
    rig.publisher.setPage("page:a");
    expect(rig.publishes).toHaveLength(1);
    expect(rig.publishes[0]!.page).toBe("page:a");

    // Well inside the throttle window, and still immediate.
    rig.advance(5);
    rig.publisher.setPage("page:b");
    expect(rig.publishes).toHaveLength(2);
    expect(rig.publishes[1]!.page).toBe("page:b");

    rig.publisher.dispose();
    rig.store.destroy();
  });

  it("does not publish when the page did not actually change", () => {
    // WHAT THIS PROTECTS: the panel re-asserts the current page from an
    // effect, and an unconditional immediate publish there would be an
    // un-throttled write on every re-run — the exact thing the throttle
    // exists to prevent.
    vi.useFakeTimers();
    const rig = publisherRig();

    rig.publisher.setPage("page:a");
    expect(rig.publishes).toHaveLength(1);
    rig.publisher.setPage("page:a");
    rig.advance(200);
    expect(rig.publishes).toHaveLength(1);

    rig.publisher.dispose();
    rig.store.destroy();
  });

  it("keeps the page on every later publish", () => {
    vi.useFakeTimers();
    const rig = publisherRig();

    rig.publisher.setPage("page:a");
    rig.advance(100);
    rig.publisher.setCursorFromScreen({ x: 3, y: 4 }, camera);

    // One Presence object rewritten in place: a cursor write must not drop the
    // page, or peers would see this cursor flicker between "page:a" and
    // "unknown" at pointer-move rate.
    expect(rig.publishes).toHaveLength(2);
    expect(rig.publishes[1]!.page).toBe("page:a");
    expect(rig.publishes[1]!.cursor).toEqual(
      screenToWorld(camera, { x: 3, y: 4 }),
    );

    rig.publisher.dispose();
    rig.store.destroy();
  });

  it("carries the newest throttled cursor out with the switch, and cancels the tail", () => {
    vi.useFakeTimers();
    const rig = publisherRig();

    rig.publisher.setCursorFromScreen({ x: 0, y: 0 }, camera);
    expect(rig.publishes).toHaveLength(1);
    rig.advance(10);
    rig.publisher.setCursorFromScreen({ x: 20, y: 20 }, camera); // throttled out

    rig.publisher.setPage("page:a");
    expect(rig.publishes).toHaveLength(2);
    expect(rig.publishes[1]!.cursor).toEqual(
      screenToWorld(camera, { x: 20, y: 20 }),
    );

    // The pending trailing flush was cancelled rather than left to fire a
    // duplicate of the state just published.
    rig.advance(200);
    expect(rig.publishes).toHaveLength(2);

    rig.publisher.dispose();
    rig.store.destroy();
  });
});
