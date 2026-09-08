// Run: npx vitest run tests/agent-menu.test.ts
//
// THE AGENT AFFORDANCE'S OPEN/CLOSED STATE. One affordance, two arms, and the
// attach arm opens a SECOND surface — so "open" is three states, not a boolean,
// and every transition between them is a decision. Written here rather than as
// `useState` branches in agents-ui.tsx because this project has no jsdom: a
// rule in a .tsx is a rule no test can drive.
//
// Modelled on canvas/pages/page-menu.ts's `nextPageMenuOpen`, which is the same
// shape of decision for the page popover.
import { describe, expect, it } from "vitest";
import { nextAgentMenu, type AgentMenuState } from "../canvas/agent-menu.js";

describe("nextAgentMenu", () => {
  const all: AgentMenuState[] = ["closed", "arms", "picker"];

  it("toggles the arms open and shut from the button", () => {
    expect(nextAgentMenu("closed", { type: "button-click" })).toBe("arms");
    expect(nextAgentMenu("arms", { type: "button-click" })).toBe("closed");
  });

  it("closes outright when the button is pressed from the picker", () => {
    // Not back to the arms: the button is the affordance's toggle, and a
    // second press of "the thing that opened this" means shut, at any depth.
    expect(nextAgentMenu("picker", { type: "button-click" })).toBe("closed");
  });

  it("opens the picker on the attach arm", () => {
    expect(nextAgentMenu("arms", { type: "arm", id: "attach" })).toBe("picker");
  });

  it("closes on the launch arm, which acts immediately", () => {
    expect(nextAgentMenu("arms", { type: "arm", id: "launch" })).toBe("closed");
  });

  it("closes on Escape from every open state", () => {
    expect(nextAgentMenu("arms", { type: "escape" })).toBe("closed");
    // One Escape, not two: a picker that only stepped back to the arms would
    // make dismissing the whole thing a two-key gesture nobody expects.
    expect(nextAgentMenu("picker", { type: "escape" })).toBe("closed");
  });

  it("closes on a pointerdown outside the widget, and stays put inside it", () => {
    for (const state of all) {
      expect(nextAgentMenu(state, { type: "pointerdown", insideWidget: false })).toBe("closed");
      expect(nextAgentMenu(state, { type: "pointerdown", insideWidget: true })).toBe(state);
    }
  });

  it("closes once an attach has been made", () => {
    // The action is done; leaving the list hanging over the shape it just
    // bound is the one outcome nobody wants.
    expect(nextAgentMenu("picker", { type: "attached" })).toBe("closed");
  });

  it("closes when the selection moves to a different shape", () => {
    // THE ANCHOR WENT. Every surface here is positioned against the selected
    // shape's screen box, so a menu left open over a shape that is no longer
    // the target is a menu whose buttons act on something the user is not
    // looking at.
    for (const state of all) {
      expect(nextAgentMenu(state, { type: "target-changed" })).toBe("closed");
    }
  });

  it("never opens anything from the closed state except the button", () => {
    for (const event of [
      { type: "escape" } as const,
      { type: "attached" } as const,
      { type: "arm", id: "attach" } as const,
      { type: "arm", id: "launch" } as const,
    ]) {
      expect(nextAgentMenu("closed", event)).toBe("closed");
    }
  });
});
