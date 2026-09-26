// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Explain, SettingsNavContext } from "./components/Explain.js";
import type { SettingsTab } from "./settings-admin.js";
import { stubPopoverDom } from "./popover-test-dom.js";

beforeEach(stubPopoverDom);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function withNav(current: SettingsTab, go: (tab: SettingsTab) => void, node: React.ReactNode) {
  return <SettingsNavContext.Provider value={{ current, go }}>{node}</SettingsNavContext.Provider>;
}

describe("Explain", () => {
  it("is a button named by its text that opens a dialog named by the entry", async () => {
    render(<p>Counts for <Explain term="attribution-only">Attribution only</Explain></p>);
    const trigger = screen.getByRole("button", { name: "Attribution only" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Attribution only" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.textContent).toContain("records who started a thread.");
    expect(dialog.textContent).toContain("Only an Access email in the directory counts for the person rules;");
  });

  it("outside settings, says where to look instead of linking", async () => {
    render(<Explain term="guardrail">guardrail</Explain>);
    fireEvent.click(screen.getByRole("button", { name: "guardrail" }));
    const dialog = await screen.findByRole("dialog", { name: "The guardrail" });
    expect(dialog.textContent).toContain("More: Identity settings › People & machines › Rules");
    expect(within(dialog).queryByRole("button")).toBeNull();
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("inside settings, jumps to the entry's tab and closes", async () => {
    const go = vi.fn();
    render(withNav("people", go, <Explain term="attribution-only">Attribution only</Explain>));
    fireEvent.click(screen.getByRole("button", { name: "Attribution only" }));
    const dialog = await screen.findByRole("dialog", { name: "Attribution only" });
    fireEvent.click(within(dialog).getByRole("button", { name: "More in This browser" }));
    expect(go).toHaveBeenCalledWith("browser");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers no More when you are already on that tab", async () => {
    render(withNav("browser", vi.fn(), <Explain term="attribution-only">Attribution only</Explain>));
    fireEvent.click(screen.getByRole("button", { name: "Attribution only" }));
    const dialog = await screen.findByRole("dialog", { name: "Attribution only" });
    expect(within(dialog).queryByRole("button")).toBeNull();
    expect(dialog.textContent).not.toContain("More");
  });

  it("closes on Escape and hands focus back to the term", async () => {
    render(<Explain term="seen">Seen</Explain>);
    const trigger = screen.getByRole("button", { name: "Seen" });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Seen" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
