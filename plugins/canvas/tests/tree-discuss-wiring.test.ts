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
    expect(call.text).toContain("discussDestination");
  });

  it("hangs the call on the button that carries it", () => {
    const button = jsxAttributes(LAYER, "data-tree-discuss");
    expect(button.onClick).toContain("onDiscuss(target.treeId, target.shapeId)");
    expect(button.disabled).toBe("!discussArm.enabled");
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
