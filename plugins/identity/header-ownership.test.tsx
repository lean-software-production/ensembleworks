// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { headerChip, ownershipRowStatus } from "./ownership-labels.js";
import { readableInk, resolvePersonColor } from "./person-colors.js";
import type { MachineList, ThreadOwnership } from "./server.js";

const starter = { person: "erin", displayName: "Erin Example", github: "erin" };
const ownership: ThreadOwnership = {
  threadId: "thread-1", starter, via: "browser", inheritedFrom: null,
  host: { kind: "team", hostId: "host-1", hostName: "shared-machine", conflict: null },
};
const machines: MachineList = {
  me: { person: "alex", displayName: "Alex", github: "alex" }, meViaFallback: false,
  roster: ["erin", "alex"], colors: { erin: "#ffffff" }, machines: [],
  sharedMachineUser: "ensembleworks-agent", enforcement: "audit", unavailable: null,
};
const app = await loadPluginApp(() => import("./app.js"));
const registration = app.threadHeaderActions.find((slot) => slot.id === "thread-ownership")!;
function mount(view = ownership, list = machines) {
  return renderSlot(registration, { threadId: view.threadId, projectId: "project-1", isCompactViewport: true }, {
    rpc: {
      identity_thread_ownership: () => ({ threads: [view] }),
      identity_machines: () => list,
    },
  });
}
afterEach(cleanup);

describe("thread ownership interaction contract", () => {
  it("offers a compact, named trigger with full desktop hover text", async () => {
    mount();
    const trigger = await screen.findByRole("button", { name: `${ownershipRowStatus(ownership).label}. Show ownership details` });
    expect(trigger.textContent).toBe("EE");
    expect(trigger.style.width).toBe("44px");
    expect(trigger.style.height).toBe("44px");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.title).toContain("runs as ensembleworks-agent on shared-machine (team machine)");
    expect(trigger.title).toContain("would be refused");
  });

  it.each([
    ["chosen", machines],
    ["dealt", { ...machines, colors: {} }],
  ] as const)("uses the %s People color and adaptive ink", async (_name, list) => {
    mount(ownership, list);
    const trigger = await screen.findByRole("button");
    const badge = trigger.querySelector("span")!;
    const color = resolvePersonColor("erin", list.roster, list.colors).color;
    const expected = document.createElement("span");
    expected.style.background = color;
    expected.style.color = readableInk(color);
    expect(badge.style.background).toBe(expected.style.background);
    expect(badge.style.color).toBe(expected.style.color);
  });

  it.each([
    { ...ownership, starter: null, via: "unknown" as const, host: null },
    { ...ownership, starter: null, via: "plugin" as const },
    { ...ownership, via: "agent" as const, host: { kind: "unclaimed" as const, hostId: "h", hostName: "unclaimed-box", conflict: null } },
    { ...ownership, host: { kind: "person" as const, hostId: "h", hostName: "renamed-box", person: machines.me!, conflict: { pinnedName: "old-alex", pinnedPerson: "alex", currentName: "renamed-box" } } },
  ])("preserves existing labels and details for $via / $host.kind", async (view) => {
    mount(view);
    const trigger = await screen.findByRole("button", { name: `${ownershipRowStatus(view).label}. Show ownership details` });
    expect(trigger.textContent).toBe(ownershipRowStatus(view).badge);
    expect(trigger.title).toBe(headerChip(view, { ...machines, sharedUser: machines.sharedMachineUser }).text);
  });
});
