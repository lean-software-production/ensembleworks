// Run: npx vitest run tests/tree-discuss-wiring.test.ts
//
// THE .tsx SEAMS OF W8. There is no jsdom here, so nothing can mount the panel
// and press the control; the strongest honest statement left is that the
// component ASKS canvas/tree/discuss.ts for each decision and attaches it to
// the right element — read out of parsed, comment-stripped source
// (tests/lib/source.ts explains why the comments must go first).
//
// Deliberately SHORT. The behaviour lives in tests/tree-discuss.test.ts, which
// can actually drive it; these three guards cover only the browser half that
// has no such lane, and each was checked by breaking the line it guards.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { callsTo, jsxAttributes, stripComments } from "./lib/source.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const LAYER = stripComments(read("../canvas/panel/tree-gesture-layer.tsx"));
const SESSION = stripComments(read("../canvas/panel/session.tsx"));
const HOOK = stripComments(read("../canvas/panel/tree-discuss.tsx"));

describe("the discuss control asks the tested module for its rule", () => {
  it("gets its label and enablement from discussArmFor, over the live target", () => {
    const [call] = callsTo(LAYER, "discussArmFor");
    expect(call).toBeDefined();
    expect(call.text).toContain("target");
    expect(call.text).toContain("discussRoute");
  });

  it("hangs the call on the button that carries it", () => {
    const button = jsxAttributes(LAYER, "data-tree-discuss");
    expect(button.onClick).toContain("onDiscuss(target.treeId, target.shapeId)");
    expect(button.disabled).toBe("!discussArm.enabled");
  });

  it("renders the enabled control's warning, not only its refusal (W17)", () => {
    // `hint` is what an ENABLED press costs — leaving the canvas. A title that
    // only ever showed `reason` would drop it silently.
    const button = jsxAttributes(LAYER, "data-tree-discuss");
    expect(button.title).toContain("discussArm.hint");
    expect(button.title).toContain("discussArm.reason");
  });
});

describe("the reference is read from the document the panel already holds", () => {
  it("passes the live snapshot into the reference, not a stale copy or an rpc", () => {
    // W9's card must go over rpc — it renders inside a chat message, with no
    // document in reach. The PANEL has one, so a round trip here would make a
    // synchronous gesture asynchronous for facts already on screen.
    const [mount] = callsTo(SESSION, "discuss.discuss");
    expect(mount).toBeDefined();
    expect(mount.text).toContain("snapshot");
  });

  it("writes through updateText, never setText — a draft in progress survives", () => {
    expect(callsTo(HOOK, "composer.updateText")).toHaveLength(1);
    expect(HOOK).not.toContain("setText");
  });
});

describe("W17 — the press has somewhere to go from the canvas route", () => {
  // The bug this guards is not a wrong mapping, it is an UNREACHABLE one: the
  // canvas is a nav panel, whose composer scope is the case W8 refused, so the
  // control was greyed on the only surface it ships on. The rule itself is
  // tested in tests/tree-discuss-reach.test.ts; these two lines are the seam
  // where the hook must actually take the fallback rather than give up.
  it("navigates to the compose surface, seeded and focused, when there is no composer", () => {
    const [call] = callsTo(HOOK, "navigate.toCompose");
    expect(call).toBeDefined();
    expect(call.text).toContain("initialPrompt: reference.text");
    expect(call.text).toContain("focusPrompt: true");
  });

  it("asks the tested module which route this scope takes, never the raw scope", () => {
    expect(callsTo(HOOK, "discussRouteFor").length).toBeGreaterThan(0);
    // The refusal branch is gone from the panel too: there is no scope from
    // which pressing the control does nothing.
    expect(HOOK).not.toContain("composerDestination");
  });
});
