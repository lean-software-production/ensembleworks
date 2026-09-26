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
function mount(whoami: WhoAmI, prepare = () => ({ ok: true as const, url: "/commit-selection" })) {
  renderSlot(settings, {}, { rpc: {
    identity_roster: () => ({ me: null, meViaFallback: false, people: [], seenCaveat: "", unavailable: null }),
    identity_whoami: () => whoami,
    identity_prepare_selection: prepare,
  } });
  // The picker lives on the settings section's This browser tab.
  void screen.findByRole("tab", { name: "This browser" }).then((tab) => fireEvent.click(tab));
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
  it("uses an RPC-minted GET capability so native WebView Origin rewriting cannot block selection", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", request);
    mount({ email: null, person: null, provenance: "unknown", selection: null, picker });
    fireEvent.change(await screen.findByRole("combobox", { name: "Your name" }), { target: { value: "matt" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this name" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith("/commit-selection", {
      method: "GET", credentials: "same-origin", cache: "no-store",
    });
  });
});
