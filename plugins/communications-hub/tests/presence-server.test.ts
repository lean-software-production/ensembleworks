import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import type { PresenceView } from "../src/presence/view";
import { PresenceService } from "../src/presence/service";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];

/** Zoom's REST API, reduced to what creating a room touches. */
function stubZoomApi(): void {
  let meeting = 88800011122;
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://zoom.us/oauth/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "token", expires_in: 3_600 }) } as Response;
    }
    if (url.includes("/meetings")) {
      const id = (meeting += 1);
      const topic = (JSON.parse(String(init?.body ?? "{}")) as { topic?: string }).topic ?? "Room";
      return {
        ok: true,
        status: 200,
        json: async () => ({ id, join_url: `https://zoom.us/j/${id}`, topic }),
      } as Response;
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch);
}

async function setup(settings: Record<string, string | boolean> = {}) {
  const host = createFakePluginHost({
    sdk: { threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) } },
    settings: {
      zoomClientId: "client-id",
      zoomClientSecret: "client-secret",
      zoomWebhookSecret: "webhook-secret",
      zoomAccountId: "account",
      zoomApiClientId: "api-client",
      zoomApiClientSecret: "api-secret",
      zoomHostUser: "host@example.com",
      ...settings,
    },
  });
  hosts.push(host);
  await plugin(host.bb);
  return host;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
  vi.restoreAllMocks();
});

describe("presence over the plugin's rpc surface", () => {
  it("explains an empty strip rather than inventing a room", async () => {
    const host = await setup({ zoomClientId: "", zoomClientSecret: "", zoomWebhookSecret: "" });
    const view = await host.harness.behavior.callRpc("presence.get") as PresenceView;
    expect(view).toMatchObject({ rooms: [], room: null, reason: "zoom-unconfigured" });
  });

  it("shows a created room with no stream as exactly that", async () => {
    stubZoomApi();
    const host = await setup();
    const room = await host.harness.behavior.callRpc("rooms.create", { name: "Team room" }) as { id: string };

    const view = await host.harness.behavior.callRpc("presence.get") as PresenceView;
    expect(view.selectedRoomId).toBe(room.id);
    expect(view.room).toMatchObject({
      roomName: "Team room",
      availability: "unavailable",
      completeness: "unknown",
      participants: [],
      joinable: true,
      status: "No active stream — BB cannot tell who is here",
    });
  });

  it("keeps one row for many rooms, and remembers which one a human chose", async () => {
    stubZoomApi();
    const host = await setup();
    const first = await host.harness.behavior.callRpc("rooms.create", { name: "Team room" }) as { id: string };
    const second = await host.harness.behavior.callRpc("rooms.create", { name: "Design review" }) as { id: string };

    const selected = await host.harness.behavior.callRpc("presence.select", { roomId: second.id }) as PresenceView;
    expect(selected.rooms).toHaveLength(2);
    expect(selected.room?.roomId).toBe(second.id);

    // Selection is BB storage, not the checkout, so it survives a plugin reload.
    const replacement = await host.harness.lifecycle.reload(plugin);
    hosts.push(replacement);
    const afterReload = await replacement.harness.behavior.callRpc("presence.get") as PresenceView;
    expect(afterReload.room?.roomId).toBe(second.id);
    expect(afterReload.room?.roomId).not.toBe(first.id);
  });

  it("refuses a selection that points at no room", async () => {
    const host = await setup();
    await expect(host.harness.behavior.callRpc("presence.select", { roomId: "room-nope" })).rejects.toThrow();
  });

  it("falls back to a room that still exists when the chosen one is archived", async () => {
    stubZoomApi();
    const host = await setup();
    const first = await host.harness.behavior.callRpc("rooms.create", { name: "Team room" }) as { id: string };
    const second = await host.harness.behavior.callRpc("rooms.create", { name: "Design review" }) as { id: string };
    await host.harness.behavior.callRpc("presence.select", { roomId: second.id });

    await host.harness.behavior.callRpc("rooms.archive", { roomId: second.id });
    const view = await host.harness.behavior.callRpc("presence.get") as PresenceView;
    expect(view.rooms.map((room) => room.id)).toEqual([first.id]);
    expect(view.room?.roomId).toBe(first.id);
  });

  it("answers a portrait request for somebody it is not holding with nothing", async () => {
    const host = await setup();
    expect(await host.harness.behavior.callRpc("presence.portrait", { participantId: "whoever:1" })).toBeNull();
  });

  it("serves presence only over the authenticated rpc surface", async () => {
    const host = await setup();
    const registrations = host.harness.inspection.registrations;

    expect(registrations.rpcMethods).toEqual(
      expect.arrayContaining(["presence.get", "presence.select", "presence.portrait"]),
    );
    // The plugin's only unauthenticated route is the signature-verified Zoom
    // webhook. Nothing about presence — least of all an image — is reachable
    // without a local BB origin.
    const open = registrations.httpRoutes.filter((route) => route.auth === "none");
    expect(open.map((route) => route.path)).toEqual(["/zoom/webhook"]);
    expect(registrations.httpRoutes.some((route) => route.path.includes("presence"))).toBe(false);
  });

  it("drops a room's presence when the CLI archives it, exactly as the panel does", async () => {
    stubZoomApi();
    const forget = vi.spyOn(PresenceService.prototype, "forgetRoom");
    const host = await setup();
    const room = await host.harness.behavior.callRpc("rooms.create", { name: "Team room" }) as { id: string };

    const archived = await host.harness.behavior.runCli(["archive-room", room.id]);
    expect(archived.exitCode).toBe(0);
    // A room nobody can join must not keep a roster or a face in memory until
    // the socket happens to notice, whichever surface archived it.
    expect(forget).toHaveBeenCalledWith(room.id);
  });

  it("drops a room's presence when the CLI deletes it at Zoom", async () => {
    stubZoomApi();
    const forget = vi.spyOn(PresenceService.prototype, "forgetRoom");
    const host = await setup();
    const room = await host.harness.behavior.callRpc("rooms.create", { name: "Team room" }) as { id: string };

    const deleted = await host.harness.behavior.runCli(["delete-room", room.id]);
    expect(deleted.exitCode).toBe(0);
    expect(forget).toHaveBeenCalledWith(room.id);
  });

  it("is readable from the CLI, for a human debugging the strip", async () => {
    stubZoomApi();
    const host = await setup();
    const room = await host.harness.behavior.callRpc("rooms.create", { name: "Team room" }) as { id: string };

    const listed = await host.harness.behavior.runCli(["presence"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).room.roomId).toBe(room.id);

    const cleared = await host.harness.behavior.runCli(["presence-select", "-"]);
    expect(cleared.exitCode).toBe(0);
    expect((await host.harness.behavior.runCli(["presence-select", "nope"])).exitCode).toBe(1);
  });
});
