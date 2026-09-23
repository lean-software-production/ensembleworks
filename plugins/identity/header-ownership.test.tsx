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
const presentPeople = [
  { person: "alex", displayName: "Alex", github: "alex", typing: false },
  { person: "sam", displayName: "Sam", github: "sam", typing: true },
];
function mount(view = ownership, list = machines, people = presentPeople,
  whoami = { email: "alex@example.test", person: list.me, provenance: "upstream-header", selection: null,
    picker: { enabled: true, status: "ready", people: [starter, list.me!] } }) {
  return renderSlot(registration, { threadId: view.threadId, projectId: "project-1", isCompactViewport: true }, {
    rpc: {
      identity_thread_ownership: () => ({ threads: [view] }),
      identity_machines: () => list,
      identity_whoami: () => whoami,
      presence_thread: () => ({ viewers: people.length, typing: people.filter((entry) => entry.typing).length, people }),
    },
  });
}
afterEach(cleanup);

describe("thread ownership interaction contract", () => {
  it("registers one combined ownership and presence header action", () => {
    expect(app.threadHeaderActions.map((slot) => slot.id)).not.toContain("thread-presence");
    expect(app.threadHeaderActions.filter((slot) => slot.id === "thread-ownership")).toHaveLength(1);
  });

  it("offers a compact, named trigger with full desktop hover text", async () => {
    mount();
    const trigger = await screen.findByRole("button", {
      name: `${ownershipRowStatus(ownership).label}. Alex and Sam here; Sam is typing. Show thread details`,
    });
    expect(trigger.querySelector('[data-identity-bubble="owner"]')?.textContent).toBe("EE");
    expect(trigger.querySelectorAll('[data-identity-bubble="viewer"]')).toHaveLength(2);
    expect(trigger.style.minWidth).toBe("44px");
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
    const badge = trigger.querySelector('[data-identity-bubble="owner"]') as HTMLSpanElement;
    const color = resolvePersonColor("erin", list.roster, list.colors).color;
    const expected = document.createElement("span");
    expected.style.background = color;
    expected.style.color = readableInk(color);
    expect(badge.style.background).toBe(expected.style.background);
    expect(badge.style.color).toBe(expected.style.color);
  });

  it("keeps a viewing owner in the top bubble instead of duplicating them", async () => {
    mount(ownership, machines, [
      { ...starter, typing: true },
      { person: "alex", displayName: "Alex", github: "alex", typing: false },
    ]);
    const trigger = await screen.findByRole("button", { name: /Erin Example and Alex here; Erin Example is typing/ });
    expect(trigger.querySelector('[data-identity-bubble="owner"]')?.textContent).toBe("EE");
    expect(trigger.querySelectorAll('[data-identity-bubble="viewer"]')).toHaveLength(1);
    expect(trigger.querySelector('[data-identity-bubble="viewer"]')?.textContent).toBe("A");
    expect((trigger.querySelector('[data-identity-bubble="owner"]') as HTMLSpanElement).style.border)
      .toContain("var(--warning");
  });

  it.each([
    { ...ownership, starter: null, via: "unknown" as const, host: null },
    { ...ownership, starter: null, via: "plugin" as const },
    { ...ownership, via: "agent" as const, host: { kind: "unclaimed" as const, hostId: "h", hostName: "unclaimed-box", conflict: null } },
    { ...ownership, host: { kind: "person" as const, hostId: "h", hostName: "renamed-box", person: machines.me!, conflict: { pinnedName: "old-alex", pinnedPerson: "alex", currentName: "renamed-box" } } },
  ])("preserves existing labels and details for $via / $host.kind", async (view) => {
    mount(view);
    const trigger = await screen.findByRole("button", { name: new RegExp(`^${ownershipRowStatus(view).label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`) });
    expect(trigger.querySelector('[data-identity-bubble="owner"]')?.textContent).toBe(ownershipRowStatus(view).badge);
    expect(trigger.title).toBe(headerChip(view, { ...machines, sharedUser: machines.sharedMachineUser }).text);
  });
});
