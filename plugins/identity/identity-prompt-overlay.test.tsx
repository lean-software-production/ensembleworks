// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { WhoAmI } from "./server.js";

const app = await loadPluginApp(() => import("./app.js"));
const overlay = app.appOverlays.find((slot) => slot.id === "identity-prompt")!;
const picker = { enabled: true, status: "ready" as const, people: [
  { person: "matt", displayName: "Matt", github: "matt" },
] };

function mount(whoami: WhoAmI) {
  return renderSlot(overlay, {}, { rpc: { identity_whoami: () => whoami } });
}

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe("global identity prompt", () => {
  it("opens for an unidentified browser without needing route props", async () => {
    mount({ email: null, person: null, provenance: "unknown", selection: null, picker });
    expect(await screen.findByRole("dialog", { name: "Choose your identity" })).toBeTruthy();
    expect(await screen.findByRole("combobox", { name: "Your name" })).toBeTruthy();
  });

  it("stays dismissed for the app session and does not prompt an upstream identity", async () => {
    const anonymous = { email: null, person: null, provenance: "unknown" as const, selection: null, picker };
    const first = mount(anonymous);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    first.unmount();
    mount(anonymous);
    expect(screen.queryByRole("dialog", { name: "Choose your identity" })).toBeNull();

    cleanup();
    sessionStorage.clear();
    mount({ email: "matt@example.test", person: picker.people[0]!, provenance: "upstream-header", selection: null, picker });
    expect(screen.queryByRole("dialog", { name: "Choose your identity" })).toBeNull();
  });
});
