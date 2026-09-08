// Run: npx vitest run   (or `npm test`)
//
// The audio half of "where are my teammates and how do I talk to them", driven
// through the real plugin factory: the roster the sidebar count reads, and the
// LiveKit token the Join button mints.
//
// No LiveKit server is involved and none is needed — a token is a signed
// assertion, so everything worth checking about it (which room, which
// participant, signed with which secret) is checkable offline. Whether audio
// actually flows is a live-server question, validated on ew-lsp-001.
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { TokenVerifier } from "livekit-server-sdk";
import { LIVEKIT_ROOM } from "../canvas/av.js";
import plugin from "../server.js";

const API_KEY = "APIfakekey";
const API_SECRET = "a-fake-secret-long-enough-to-sign-with";

const hosts: FakePluginHost[] = [];

/** A fake host with whatever LiveKit settings the case needs. Secrets are
 * pre-seeded exactly the way a real `bb plugin config canvas set` would leave
 * them, so the handler's own `settings.get()` is what runs. */
function makeHost(settings: Record<string, string> = {}) {
  const host = createFakePluginHost({ pluginId: "canvas", settings });
  hosts.push(host);
  return host;
}

const configured = {
  livekitUrl: "wss://livekit.example.test",
  livekitApiKey: API_KEY,
  livekitApiSecret: API_SECRET,
};

afterEach(async () => {
  // Releases the room host's database handle; a leaked one keeps the process
  // alive after the suite.
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

/** The JWT's payload, decoded WITHOUT the SDK: the point of the assertion is
 * that a LiveKit server (which only ever sees these bytes) would read the room
 * we think it will, so decoding it with the same library that wrote it would
 * be assuming what we want to prove. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  expect(payload).toBeTypeOf("string");
  return JSON.parse(
    Buffer.from(payload!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    ),
  ) as Record<string, unknown>;
}

describe("canvas_av_token", () => {
  it("mints a decodable join token for room bb-spike, named after the caller", async () => {
    const host = makeHost(configured);
    await plugin(host.bb);
    // The identity comes from the ROOM's clientId -> name map, so this client
    // has to actually be in the room under a name.
    await host.harness.behavior.callRpc("canvas_join", {
      clientId: "client-a",
      name: "alice",
    });

    const result = (await host.harness.behavior.callRpc("canvas_av_token", {
      clientId: "client-a",
    })) as { ok: true; url: string; token: string; room: string; identity: string };

    expect(result.ok).toBe(true);
    expect(result.room).toBe("bb-spike");
    expect(result.room).toBe(LIVEKIT_ROOM);
    expect(result.url).toBe("wss://livekit.example.test");
    expect(result.identity).toBe("alice");

    const claims = decodeJwtPayload(result.token);
    expect(claims.sub).toBe("alice");
    expect(claims.video).toMatchObject({
      room: "bb-spike",
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    // Signed with the configured secret — i.e. the secret setting is what the
    // handler reached for, not an env var or a default.
    await expect(
      new TokenVerifier(API_KEY, API_SECRET).verify(result.token),
    ).resolves.toBeTruthy();
  });

  it("never grants a room other than bb-spike, whatever the settings say", async () => {
    // The room name is a constant, not configuration: this asserts there is no
    // setting that could point the spike at the production EnsembleWorks room.
    const host = makeHost({ ...configured, project: "proj_anything" });
    await plugin(host.bb);

    const result = (await host.harness.behavior.callRpc("canvas_av_token", {})) as {
      ok: true;
      token: string;
    };
    expect(decodeJwtPayload(result.token).video).toMatchObject({
      room: "bb-spike",
    });
  });

  it("falls back to the server's own identity for a caller the room does not know", async () => {
    const host = makeHost(configured);
    await plugin(host.bb);

    const result = (await host.harness.behavior.callRpc("canvas_av_token", {
      clientId: "never-joined",
    })) as { ok: true; identity: string };

    // The `local:<user>` shape from identity.ts — honest about being a machine
    // account rather than borrowing somebody else's name.
    expect(result.identity).toMatch(/^local:/);
  });

  it("answers with a typed result, not a throw, when LiveKit is unconfigured", async () => {
    const host = makeHost();
    await plugin(host.bb);

    const result = (await host.harness.behavior.callRpc("canvas_av_token", {})) as {
      ok: false;
      error: string;
      detail: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_configured");
    // The detail is what a human reads to fix it, so it has to name the knobs.
    expect(result.detail).toContain("livekitUrl");
  });

  it("treats a half-configured LiveKit as unconfigured", async () => {
    // A URL with no credentials mints nothing; reporting it as configured would
    // send the Join button into a connect that can only fail.
    const host = makeHost({ livekitUrl: "wss://livekit.example.test" });
    await plugin(host.bb);

    const result = (await host.harness.behavior.callRpc("canvas_av_token", {})) as {
      ok: false;
    };
    expect(result.ok).toBe(false);
  });
});

describe("canvas_roster", () => {
  /** A member with no location — what a sync-room client looks like before it
   * has polled. Spelled out once, because every assertion below carries it.
   * `inRoom` is true because everyone built with this helper got here through
   * `canvas_join`. */
  const unlocated = (clientId: string, name: string) => ({
    clientId,
    name,
    path: null,
    title: null,
    seenMs: null,
    focused: null,
    inRoom: true,
  });

  it("lists everyone the room knows by name, and drops them when they leave", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const roster = async () =>
      (await host.harness.behavior.callRpc("canvas_roster", null)) as {
        members: Array<{ clientId: string; name: string }>;
      };

    expect((await roster()).members).toEqual([]);

    await host.harness.behavior.callRpc("canvas_join", {
      clientId: "client-a",
      name: "alice",
    });
    await host.harness.behavior.callRpc("canvas_join", {
      clientId: "client-b",
      name: "bob",
    });
    expect((await roster()).members).toEqual([
      unlocated("client-a", "alice"),
      unlocated("client-b", "bob"),
    ]);

    await host.harness.behavior.callRpc("canvas_leave", { clientId: "client-a" });
    expect((await roster()).members).toEqual([unlocated("client-b", "bob")]);
  });

  it("still accepts a null input, so the sidebar's count keeps working", async () => {
    // `CanvasOnlineCount` is a read-only consumer with no location to report,
    // and a bb window running an older bundle sends exactly this. Widening the
    // input must not have broken either.
    const host = makeHost();
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_join", {
      clientId: "client-a",
      name: "alice",
    });
    const result = (await host.harness.behavior.callRpc("canvas_roster", null)) as {
      members: unknown[];
    };
    expect(result.members).toHaveLength(1);
  });

  it("puts a tab that never joined the canvas into the roster", async () => {
    // THE WHOLE POINT OF THE FEATURE, and the thing the preflight proved was
    // impossible before it: a bb tab sitting on a thread has never called
    // canvas_join, so the room could not see it at all.
    const host = makeHost();
    await plugin(host.bb);
    const result = (await host.harness.behavior.callRpc("canvas_roster", {
      clientId: "tab-1",
      name: "alice",
      path: "/projects/p1/threads/t1",
      title: "Standup",
    })) as { members: Array<{ clientId: string; path: string | null; title: string | null }> };

    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({
      clientId: "tab-1",
      name: "alice",
      path: "/projects/p1/threads/t1",
      title: "Standup",
    });
  });

  it("carries a reporting tab's focus across the wire", async () => {
    // The one field the widening added this round, and the reason it exists:
    // two live windows of one person poll on drifting 2s timers, so recency
    // cannot say which one they are in. `.strict()` means an unaccepted field
    // is a rejected poll, so this pins the schema as much as the plumbing.
    const host = makeHost();
    await plugin(host.bb);
    const result = (await host.harness.behavior.callRpc("canvas_roster", {
      clientId: "tab-1",
      name: "alice",
      path: "/projects/p1/threads/t1",
      focused: true,
    })) as { members: Array<{ focused: boolean | null }> };

    expect(result.members[0]?.focused).toBe(true);
  });

  it("hands one tab's location to another tab's poll", async () => {
    const host = makeHost();
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_roster", {
      clientId: "tab-1",
      name: "alice",
      path: "/plugins/canvas/canvas",
    });
    const result = (await host.harness.behavior.callRpc("canvas_roster", {
      clientId: "tab-2",
      name: "bob",
      path: "/settings",
    })) as { members: Array<{ name: string; path: string | null }> };

    expect(
      result.members.map((member) => [member.name, member.path]).sort(),
    ).toEqual([
      ["alice", "/plugins/canvas/canvas"],
      ["bob", "/settings"],
    ]);
  });

  it("gives a canvas panel's own clientId the location its strip reported", async () => {
    // One tab is ONE address (canvas/tab-id.ts): the panel joins under it and
    // the strip reports under it, so a canvas tab is one member, not two.
    const host = makeHost();
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_join", {
      clientId: "tab-1",
      name: "alice",
    });
    const result = (await host.harness.behavior.callRpc("canvas_roster", {
      clientId: "tab-1",
      name: "alice",
      path: "/plugins/canvas/canvas",
    })) as { members: Array<{ clientId: string; path: string | null }> };

    expect(result.members).toHaveLength(1);
    expect(result.members[0]?.path).toBe("/plugins/canvas/canvas");
  });

  it("refuses a path that is not a rooted same-origin path", async () => {
    // The wire's half of the guard; canvas/dock/where.ts refuses the same
    // shapes again before rendering one, and neither half trusts the other.
    const host = makeHost();
    await plugin(host.bb);
    for (const path of ["//evil.example/x", "https://evil.example", "settings"]) {
      await expect(
        host.harness.behavior.callRpc("canvas_roster", {
          clientId: "tab-1",
          name: "alice",
          path,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects an unknown field rather than quietly ignoring it", async () => {
    const host = makeHost();
    await plugin(host.bb);
    await expect(
      host.harness.behavior.callRpc("canvas_roster", {
        clientId: "tab-1",
        name: "alice",
        path: "/settings",
        somethingElse: true,
      }),
    ).rejects.toThrow();
  });

  it("flags which members the sync room actually knows", async () => {
    // THE SIDEBAR BADGE'S DENOMINATOR. `CanvasOnlineCount` seeds from this
    // reply and then follows the room's identity broadcast; once the roster
    // also carried bb tabs that never opened the canvas, those two numbers
    // measured different sets and the badge flip-flopped between them. `inRoom`
    // is the server stating, per member, whether that clientId is in
    // `room.identities` — the exact set the broadcast counts.
    const host = makeHost();
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_join", {
      clientId: "panel-1",
      name: "alice",
    });
    await host.harness.behavior.callRpc("canvas_roster", {
      clientId: "tab-9",
      name: "bob",
      path: "/projects/p1/threads/t1",
    });
    const result = (await host.harness.behavior.callRpc("canvas_roster", null)) as {
      members: Array<{ clientId: string; inRoom: boolean }>;
    };

    expect(
      result.members.map((member) => [member.clientId, member.inRoom]).sort(),
    ).toEqual([
      ["panel-1", true],
      ["tab-9", false],
    ]);
    // And the count the badge would draw equals the room's own membership.
    expect(result.members.filter((member) => member.inRoom)).toHaveLength(1);
  });

  it("stops flagging a canvas client the moment it leaves the room", async () => {
    // A canvas tab that closes its panel but keeps the page open is still a
    // reporter — it must drop OUT of the count, exactly as the leave broadcast
    // drops it out of `identities`, or the badge over-reports forever.
    const host = makeHost();
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_join", {
      clientId: "tab-1",
      name: "alice",
    });
    await host.harness.behavior.callRpc("canvas_roster", {
      clientId: "tab-1",
      name: "alice",
      path: "/plugins/canvas/canvas",
    });
    const before = (await host.harness.behavior.callRpc("canvas_roster", null)) as {
      members: Array<{ inRoom: boolean }>;
    };
    expect(before.members.filter((member) => member.inRoom)).toHaveLength(1);

    await host.harness.behavior.callRpc("canvas_leave", { clientId: "tab-1" });
    const after = (await host.harness.behavior.callRpc("canvas_roster", null)) as {
      members: Array<{ clientId: string; inRoom: boolean }>;
    };
    // Still in the roster (the tab is open and reporting), no longer counted.
    expect(after.members).toHaveLength(1);
    expect(after.members[0]?.inRoom).toBe(false);
  });

  it("omits a client that joined without a name", async () => {
    // An auto-join (CanvasRoomHost.frame) carries no name, and an avatar with
    // no label is worse than no avatar.
    const host = makeHost();
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_join", { clientId: "anon" });

    const result = (await host.harness.behavior.callRpc("canvas_roster", null)) as {
      members: unknown[];
    };
    expect(result.members).toEqual([]);
  });
});
