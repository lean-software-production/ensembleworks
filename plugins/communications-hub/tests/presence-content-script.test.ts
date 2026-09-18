// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, mountPluginContentScripts } from "@get-bb/plugin-sdk/testing/app";
import type { PresenceView } from "../src/presence/view.js";

const NOW = 1_800_000_000_000;

const view: PresenceView = {
  rooms: [{ id: "room-1", name: "Team room" }],
  selectedRoomId: "room-1",
  room: {
    roomId: "room-1",
    roomName: "Team room",
    joinUrl: "https://zoom.us/j/12345",
    joinable: true,
    conversationId: "conversation-1",
    conversationTitle: "Team room sitting",
    availability: "live",
    completeness: "partial",
    participants: [
      {
        id: "conversation-1:1",
        label: "Ada",
        initials: "AD",
        speaking: true,
        speakingMsRemaining: 3_000,
        camera: "unknown",
        portraitAt: null,
      },
    ],
    knownCount: 1,
    portraits: false,
    updatedAt: NOW,
    status: "1 person seen here · list may be incomplete",
  },
  reason: "ok",
  generatedAt: NOW,
};

function sidebar(): void {
  document.body.innerHTML = `
    <div data-sidebar="sidebar">
      <div data-sidebar="content">threads</div>
      <div data-sidebar="footer"><button type="button">Settings</button></div>
    </div>`;
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  vi.restoreAllMocks();
});

describe("presence as a registered content script", () => {
  it("is registered once, mounts above the footer, and is removed by its disposer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: view }),
    } as unknown as Response);
    sidebar();

    const app = await loadPluginApp(() => import("../app"));
    // A content script, not a slot: the row has to outlive route changes, and
    // every other registration bb offers is scoped to a page or a panel.
    expect(app.contentScripts.map((script) => script.id)).toEqual(["zoom-presence-row"]);

    const mounted = await mountPluginContentScripts(app, { pluginId: "communications-hub" });
    await flush();
    expect(mounted.inspection.mountedIds).toEqual(["zoom-presence-row"]);
    expect(document.querySelectorAll("#ewzp-row-root")).toHaveLength(1);
    expect(document.querySelector('[data-sidebar="footer"]')!.previousElementSibling!.id)
      .toBe("ewzp-row-root");
    expect(document.querySelector("#ewzp-row-root .ewzp-row")!.getAttribute("aria-label"))
      .toContain("Team room");

    await mounted.lifecycle.dispose();
    expect(document.querySelector("#ewzp-row-root")).toBeNull();
    expect(document.querySelector("#ewzp-popover")).toBeNull();
    expect(document.querySelector("#ewzp-styles")).toBeNull();
  });

  it("survives a plugin frontend that cannot reach its own rpc", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    sidebar();

    const app = await loadPluginApp(() => import("../app"));
    const mounted = await mountPluginContentScripts(app, { pluginId: "communications-hub" });
    await flush();

    // No data, no row — and no exception that would take the app shell with it.
    expect(document.querySelector("#ewzp-row-root")).toBeNull();
    await mounted.lifecycle.dispose();
  });
});
