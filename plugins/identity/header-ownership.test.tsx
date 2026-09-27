// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { headerChip, ownershipRowStatus } from "./ownership-labels.js";
import { readableInk, resolvePersonColor } from "./person-colors.js";
import type { MachineList, ThreadOwnership, WhoAmI } from "./server.js";
import { stubPopoverDom } from "./popover-test-dom.js";

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
  whoami: WhoAmI = { email: "alex@example.test", person: list.me, provenance: "upstream-header", selection: null,
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

describe("the header popover's footer", () => {
  const off = { enabled: false, status: "off", people: [] };
  const alex = machines.me!;
  beforeEach(stubPopoverDom);
  afterEach(() => vi.unstubAllGlobals());
  /** Opens Thread details and returns the footer: the one div whose whole text is the line. */
  async function footer(whoami: WhoAmI, line: string) {
    mount(ownership, machines, presentPeople, whoami);
    fireEvent.click(await screen.findByRole("button", { name: /Show thread details/ }));
    const dialog = await screen.findByRole("dialog", { name: "Thread details" });
    const found = within(dialog).getAllByText((_, el) => el?.tagName === "DIV" && el.textContent === line);
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  it("names where the name comes from, in one short sentence", async () => {
    await footer({ email: "alex@example.test", person: alex, provenance: "upstream-header", selection: null, picker: off },
      "You are Alex, from your Access email.");
    cleanup();
    await footer({ email: "who@example.test", person: null, provenance: "upstream-header", selection: null, picker: off },
      "Your Access email, who@example.test, is not in Identity's directory.");
    cleanup();
    await footer({ email: null, person: null, provenance: "unknown", selection: { status: "expired" }, picker: off },
      "You are anonymous here.");
  });

  it("does not call a fallback email outside the directory an Access email", async () => {
    await footer({ email: "desk@example.test", person: null, provenance: "configured-fallback", selection: null, picker: off },
      "The fallback email, desk@example.test, is not in Identity's directory.");
  });

  it("explains attribution only on click for a browser name or the fallback email", async () => {
    const chosen = await footer({ email: null, person: alex, provenance: "self-selected", selection: { status: "valid" },
      picker: off }, "You are shown as Alex, chosen in this browser — attribution only.");
    fireEvent.click(within(chosen).getByRole("button", { name: "attribution only" }));
    expect(await screen.findByRole("dialog", { name: "Attribution only" })).toBeTruthy();
    cleanup();
    await footer({ email: "desk@example.test", person: alex, provenance: "configured-fallback", selection: null, picker: off },
      "You are shown as Alex from the fallback email — attribution only.");
  });
});
