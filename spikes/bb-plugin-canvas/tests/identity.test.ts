// Run: npx vitest run   (or `npm test`)
//
// T3: Cloudflare Access identity on presence. Covers all three legs — the
// header -> identity route, the name's trip up on `canvas_join` and back out
// as a room broadcast, and the render-time join of that broadcast onto cursors.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CanvasRoomHost } from "../canvas/room.js";
import { CANVAS_MIGRATIONS, CanvasStore } from "../canvas/store.js";
import { CANVAS_CHANNEL } from "../canvas/wire.js";
import {
  CF_ACCESS_EMAIL_HEADER,
  IDENTITY_ROUTE_PATH,
  MAX_NAME_LENGTH,
  adaptPresence,
  colorForName,
  fetchIdentity,
  resolveIdentity,
} from "../canvas/identity.js";
import {
  envelopeBytesFor,
  identitiesFrom,
  isResyncFor,
  serverHelloEpoch,
} from "../transport.js";
import plugin from "../server.js";

/** A room host wired to an in-memory database, with its publishes captured. */
function standaloneRoom() {
  const db = new Database(":memory:");
  for (const statement of CANVAS_MIGRATIONS) db.exec(statement);
  const published: unknown[] = [];
  const host = new CanvasRoomHost({
    store: new CanvasStore(db),
    publish: (message) => published.push(message),
  });
  /** Every identity map broadcast so far, in order. */
  const broadcasts = () =>
    published
      .map((message) => identitiesFrom(message))
      .filter((map): map is Record<string, string> => map !== null);
  return { db, host, published, broadcasts };
}

describe("resolveIdentity", () => {
  it("names the human behind a Cloudflare Access header", () => {
    expect(resolveIdentity("alice@example.com", "svc")).toEqual({
      email: "alice@example.com",
      name: "alice",
    });
    // Whitespace happens to headers in transit; it must not become the label.
    expect(resolveIdentity("  bob@example.com  ", "svc")).toEqual({
      email: "bob@example.com",
      name: "bob",
    });
  });

  it("falls back to a machine-honest local name with no header", () => {
    // Explicitly `local:` prefixed: this is NOT an authenticated person, and
    // the cursor label should not pretend otherwise.
    expect(resolveIdentity(undefined, "mrdavidlaing")).toEqual({
      email: null,
      name: "local:mrdavidlaing",
    });
    expect(resolveIdentity(null, "mrdavidlaing").name).toBe(
      "local:mrdavidlaing",
    );
    expect(resolveIdentity("   ", "mrdavidlaing").name).toBe(
      "local:mrdavidlaing",
    );
  });

  it("never produces an empty or oversized name", () => {
    // A pathological address with no local part still needs a label.
    expect(resolveIdentity("@example.com", "svc").name).toBe("@example.com");
    expect(resolveIdentity(undefined, "").name).toBe("local:unknown");
    // The join schema caps names; clamping here is what keeps a long address
    // from being rejected at the wire instead of merely shortened.
    const long = `${"a".repeat(200)}@example.com`;
    expect(resolveIdentity(long, "svc").name).toHaveLength(MAX_NAME_LENGTH);
  });
});

describe("the identity route", () => {
  it("reports the Cloudflare Access email and its local part", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);

    const response = await host.harness.behavior.fetchHttp(
      "GET",
      IDENTITY_ROUTE_PATH,
      { headers: { [CF_ACCESS_EMAIL_HEADER]: "alice@example.com" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      email: "alice@example.com",
      name: "alice",
    });

    await host.harness.lifecycle.dispose();
  });

  it("answers with a local identity when there is no Access edge", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);

    const body = (await (
      await host.harness.behavior.fetchHttp("GET", IDENTITY_ROUTE_PATH)
    ).json()) as { email: string | null; name: string };
    expect(body.email).toBeNull();
    expect(body.name).toMatch(/^local:.+/);

    await host.harness.lifecycle.dispose();
  });

  it("is what fetchIdentity reads, and it degrades rather than throwing", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);

    // The real panel fetches an absolute same-origin path; here the fake host
    // routes by the registered path, so the injected fetch bridges the two.
    const viaFetch = await fetchIdentity((() =>
      host.harness.behavior.fetchHttp("GET", IDENTITY_ROUTE_PATH, {
        headers: { [CF_ACCESS_EMAIL_HEADER]: "carol@example.com" },
      })) as unknown as typeof fetch);
    expect(viaFetch).toEqual({ email: "carol@example.com", name: "carol" });

    // A canvas that cannot name you must still open.
    const broken = await fetchIdentity((async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    expect(broken).toEqual({ email: null, name: "local:anonymous" });

    const garbage = await fetchIdentity((async () =>
      Response.json({ name: "" })) as unknown as typeof fetch);
    expect(garbage.name).toBe("local:anonymous");

    await host.harness.lifecycle.dispose();
  });
});

describe("the room's identity map", () => {
  it("broadcasts on join, and prunes on leave and sweep", () => {
    const { db, host, broadcasts } = standaloneRoom();

    host.join("client-a", 1_000, "alice");
    expect(broadcasts().at(-1)).toEqual({ "client-a": "alice" });

    // A newcomer's OWN join is what tells it everyone else's names — there is
    // no separate query, and the broadcast is unaddressed for exactly that
    // reason.
    host.join("client-b", 1_000, "bob");
    expect(broadcasts().at(-1)).toEqual({
      "client-a": "alice",
      "client-b": "bob",
    });
    expect(host.identities).toEqual({
      "client-a": "alice",
      "client-b": "bob",
    });

    host.leave("client-b");
    expect(broadcasts().at(-1)).toEqual({ "client-a": "alice" });

    // A name can never outlive its client: the sweep removes the entry and the
    // name goes with it.
    expect(host.sweep(1_000 + 10 * 60 * 1000)).toBe(1);
    expect(broadcasts().at(-1)).toEqual({});

    host.close();
    db.close();
  });

  it("re-joining renames, and a nameless auto-join has no label", () => {
    const { db, host, broadcasts } = standaloneRoom();

    host.join("client-a", 1_000, "alice");
    // A resync re-joins with whatever name the panel now holds.
    host.join("client-a", 2_000, "alice@work");
    expect(host.identities).toEqual({ "client-a": "alice@work" });

    // frame() from an unknown client auto-joins it; that path carries no name,
    // so the client stays unlabelled until its resync re-joins with one.
    host.frame("stranger", new Uint8Array([3, 0]), 3_000);
    expect(host.clientIds).toContain("stranger");
    expect(broadcasts().at(-1)).toEqual({ "client-a": "alice@work" });

    host.close();
    db.close();
  });

  it("carries a panel's name from canvas_join to every client", async () => {
    const host = createFakePluginHost({ pluginId: "canvas" });
    await plugin(host.bb);

    await host.harness.behavior.callRpc("canvas_join", {
      clientId: "tab-1",
      name: "local:mrdavidlaing",
    });
    await host.harness.behavior.callRpc("canvas_join", {
      clientId: "tab-2",
      name: "local:mrdavidlaing",
    });

    // What a panel actually consumes: the last identity map published on the
    // shared channel.
    const maps = host.harness.inspection.realtimeSignals
      .filter((signal) => signal.channel === CANVAS_CHANNEL)
      .map((signal) => identitiesFrom(signal.payload))
      .filter((map): map is Record<string, string> => map !== null);
    expect(maps.at(-1)).toEqual({
      "tab-1": "local:mrdavidlaing",
      "tab-2": "local:mrdavidlaing",
    });

    const state = (await host.harness.behavior.callRpc("canvas_debug", null)) as {
      identities: Record<string, string>;
    };
    expect(state.identities).toEqual({
      "tab-1": "local:mrdavidlaing",
      "tab-2": "local:mrdavidlaing",
    });

    await host.harness.lifecycle.dispose();
  });
});

describe("identitiesFrom", () => {
  it("accepts an identity broadcast and drops malformed entries", () => {
    expect(identitiesFrom({ identities: { a: "alice" } })).toEqual({
      a: "alice",
    });
    expect(identitiesFrom({ identities: {} })).toEqual({});
    // One bad entry must cost that peer its label, not everyone theirs.
    expect(identitiesFrom({ identities: { a: "alice", b: 7, c: "" } })).toEqual({
      a: "alice",
    });
    expect(identitiesFrom({ identities: ["alice"] })).toBeNull();
    expect(identitiesFrom({ identities: null })).toBeNull();
    expect(identitiesFrom(null)).toBeNull();
    expect(identitiesFrom({})).toBeNull();
  });

  // FOUR decoders now run against every publish on the one shared channel, and
  // at most one may match any payload: a false positive would swallow frames,
  // resync on every publish, or wipe every cursor label.
  it("never matches a payload another decoder claims", () => {
    const identities = { identities: { a: "alice" } };
    expect(serverHelloEpoch(identities)).toBeNull();
    expect(isResyncFor("a", identities)).toBe(false);
    expect(envelopeBytesFor("a", identities)).toBeNull();

    expect(identitiesFrom({ hello: 1717171717 })).toBeNull();
    expect(identitiesFrom({ to: "me", data: "AQID" })).toBeNull();
    expect(identitiesFrom({ to: "me", resync: true })).toBeNull();
  });
});

describe("cursor labels", () => {
  it("labels each cursor with its peer's name", () => {
    const labelled = adaptPresence(
      {
        "tab-1": { cursor: { x: 10, y: 20 } },
        "tab-2": { cursor: null },
      },
      { "tab-1": "alice", "tab-2": "bob" },
    );
    expect(labelled["tab-1"]).toEqual({
      cursor: { x: 10, y: 20 },
      name: "alice",
      color: colorForName("alice"),
      // D-4: `page` is carried too, and a peer that published none is UNKNOWN
      // (null), never "elsewhere". The whole-object assertion is what makes a
      // dropped field visible here — see tests/page-presence.test.ts for the
      // rest of the loop.
      page: null,
    });
    expect(labelled["tab-2"]!.name).toBe("bob");
  });

  it("falls back to a short id for a peer whose name has not arrived", () => {
    // A join broadcast can race a client's realtime subscription. A stub label
    // beats no cursor at all, and the next broadcast repairs it.
    const labelled = adaptPresence(
      { abcdef0123456789: { cursor: { x: 0, y: 0 } } },
      {},
    );
    expect(labelled["abcdef0123456789"]!.name).toBe("abcdef");
  });

  it("gives one human one color, in every tab", () => {
    // Two tabs, two clientIds, one person: the color is a function of the NAME,
    // so both cursors read as the same human.
    const labelled = adaptPresence(
      {
        "tab-1": { cursor: { x: 0, y: 0 } },
        "tab-2": { cursor: { x: 1, y: 1 } },
      },
      { "tab-1": "local:mrdavidlaing", "tab-2": "local:mrdavidlaing" },
    );
    expect(labelled["tab-1"]!.color).toBe(labelled["tab-2"]!.color);
    expect(labelled["tab-1"]!.color).toBe(colorForName("local:mrdavidlaing"));
  });

  it("colorForName is pure, in range, and spreads names apart", () => {
    expect(colorForName("alice")).toBe(colorForName("alice"));
    for (const name of ["alice", "bob", "local:mrdavidlaing", ""]) {
      const match = /^hsl\((\d+) 65% 45%\)$/.exec(colorForName(name));
      expect(match, `${name} -> ${colorForName(name)}`).not.toBeNull();
      expect(Number(match![1])).toBeLessThan(360);
    }
    // Not a guarantee of the hash, an observation about these names: distinct
    // people should not be quietly indistinguishable.
    expect(new Set(["alice", "bob", "carol"].map(colorForName)).size).toBe(3);
  });
});
