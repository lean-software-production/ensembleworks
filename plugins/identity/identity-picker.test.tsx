// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { WhoAmI } from "./server.js";

const app = await loadPluginApp(() => import("./app.js"));
const settings = app.settingsSections.find((section) => section.id === "people")!;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const picker = { enabled: true, status: "ready", people: [
  { person: "matt", displayName: "Matt", github: "matt" },
] };
function mount(whoami: WhoAmI) {
  renderSlot(settings, {}, { rpc: {
    identity_roster: () => ({ me: null, meViaFallback: false, people: [], seenCaveat: "", unavailable: null }),
    identity_whoami: () => whoami,
  } });
}

describe("accessible browser picker", () => {
  it("shows a labelled choice and an explicit attribution disclaimer", async () => {
    mount({ email: null, person: null, provenance: "unknown", selection: null, picker });
    expect(await screen.findByRole("combobox", { name: "Your name" })).toBeTruthy();
    expect(screen.getByText(/does not verify who you are/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this name" }).hasAttribute("disabled")).toBe(true);
  });
  it("offers Switch and Forget for a selected person without calling them verified", async () => {
    mount({ email: null, person: { person: "matt", displayName: "Matt", github: "matt" },
      provenance: "self-selected", selection: { status: "valid" }, picker });
    expect(await screen.findByRole("button", { name: "Switch" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Forget" })).toBeTruthy();
    expect(screen.getByText(/attribution only/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    expect(screen.getByRole("combobox", { name: "Your name" })).toBeTruthy();
  });
  it("asks for reselection when a directory entry has gone", async () => {
    mount({ email: null, person: null, provenance: "unknown", selection: { status: "stale" }, picker });
    expect(await screen.findByText(/no longer in the directory/)).toBeTruthy();
  });
  it("sends the page origin explicitly for native WebViews that rewrite Origin", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", request);
    mount({ email: null, person: null, provenance: "unknown", selection: null, picker });
    fireEvent.change(await screen.findByRole("combobox", { name: "Your name" }), { target: { value: "matt" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this name" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      "content-type": "application/json",
      "x-identity-browser-origin": window.location.origin,
    });
  });
});
