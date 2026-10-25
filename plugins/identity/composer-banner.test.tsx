// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { MachineList, ThreadOwnership } from "./server.js";
import { stubPopoverDom } from "./popover-test-dom.js";

const alex = { person: "alex", displayName: "Alex Rivera", github: "alexr" };
const matt = { person: "matt", displayName: "Matt", github: "matt" };
const list: MachineList = {
  me: alex, meViaFallback: false, meProvenance: "upstream-header",
  roster: ["alex"], colors: {}, sharedMachineUser: "ensembleworks-agent", enforcement: "enforce", unavailable: null,
  machines: [
    { kind: "person", hostId: "h1", hostName: "ew-lab-002-alex", person: alex, conflict: null },
    { kind: "team", hostId: "h2", hostName: "ew-main", conflict: null },
  ],
};
const app = await loadPluginApp(() => import("./app.js"));

// Task 1's helper: the ResizeObserver stub plus the jsdom `:modal` shortcut Radix needs.
beforeEach(stubPopoverDom);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps routine identity details out of a recognised person's new-thread composer", async () => {
  const banner = app.composerCustomizations.find((entry) => entry.id === "ownership-banner")!.banners![0]!;
  await act(async () => {
    renderSlot(banner, {}, {
      rpc: { identity_machines: () => list },
      composer: { scope: { kind: "new-thread", projectId: "project-1" } },
    });
  });
  expect(screen.queryByText("Starting as Alex Rivera")).toBeNull();
});

it("keeps the unavailable notice after the explained note", async () => {
  const banner = app.composerCustomizations.find((entry) => entry.id === "ownership-banner")!.banners![0]!;
  renderSlot(banner, {}, {
    rpc: { identity_machines: () => ({ ...list, unavailable: "Machines are unavailable" }) },
    composer: { scope: { kind: "new-thread", projectId: "project-1" } },
  });
  const note = await screen.findByRole("button", { name: /refused at Send/ });
  expect(note.parentElement!.textContent).toBe("Yours: ew-lab-002-alex · Team: ew-main "
    + "Starting on someone else's machine is refused at Send. Machines are unavailable.");
  fireEvent.click(note);
  const dialog = await screen.findByRole("dialog", { name: "When the machine is checked" });
  expect(dialog.textContent).toContain("More: Identity settings › People & machines › Rules");
  expect(within(dialog).queryByRole("button")).toBeNull();
});

it("shows an unrecognised identity that needs attention", async () => {
  const banner = app.composerCustomizations.find((entry) => entry.id === "ownership-banner")!.banners![0]!;
  renderSlot(banner, {}, {
    rpc: { identity_machines: () => ({ ...list, me: null, meProvenance: "unknown" }) },
    composer: { scope: { kind: "new-thread", projectId: "project-1" } },
  });
  expect(await screen.findByText("Starting anonymously")).toBeTruthy();
});

it("on someone else's thread, explains the own-thread rule on click", async () => {
  const ownership: ThreadOwnership = { threadId: "t1", starter: matt, via: "browser", inheritedFrom: null, host: null };
  const banner = app.composerCustomizations.find((entry) => entry.id === "read-only-banner")!.banners![0]!;
  renderSlot(banner, {}, {
    rpc: { identity_machines: () => list, identity_thread_ownership: () => ({ threads: [ownership] }) },
    composer: { scope: { kind: "thread", threadId: "t1" } },
  });
  expect(await screen.findByText("Read-only: Matt's thread")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Own-thread rule" }));
  const dialog = await screen.findByRole("dialog", { name: "Own-thread rule" });
  expect(dialog.textContent).toContain("In the log: follow-up-by-non-starter.");
  expect(dialog.textContent).toContain("More: Identity settings › People & machines › Rules");
});

it.each(["off", "audit"] as const)("omits routine ownership cards when enforcement is %s", async (enforcement) => {
  const ownership: ThreadOwnership = { threadId: "t1", starter: matt, via: "browser", inheritedFrom: null, host: null };
  const banner = app.composerCustomizations.find((entry) => entry.id === "read-only-banner")!.banners![0]!;
  await act(async () => {
    renderSlot(banner, {}, {
      rpc: { identity_machines: () => ({ ...list, enforcement }), identity_thread_ownership: () => ({ threads: [ownership] }) },
      composer: { scope: { kind: "thread", threadId: "t1" } },
    });
  });
  expect(screen.queryByText(/Matt's thread/)).toBeNull();
});
