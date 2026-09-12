// Run: npx vitest run tests/tree-gesture-wiring.test.ts
//
// THE .tsx SEAMS OF W4'S GESTURES. There is no jsdom in this project, so
// nothing here can mount the panel and press a button; the strongest honest
// statement left is that the component ASKS the tested module for each
// decision and ATTACHES it to the right element — read out of PARSED,
// comment-stripped source, for the walk-throughs tests/source-guard.test.ts
// records (a guard satisfied by a doc comment; a real call replaced by a
// string; a perfect handler disconnected from its element).
//
// The behaviour itself is covered where it can be: canvas/tree/gestures.ts by
// tests/tree-gestures.test.ts, and the whole write path — including the node
// arriving back on the human's own peer — by tests/tree-gesture-rpc.test.ts,
// through the real plugin factory. These guards exist only for the browser
// half, which has no such lane.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { callsTo, jsxAttributes, stripComments } from "./lib/source.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const LAYER = read("../canvas/panel/tree-gesture-layer.tsx");
const VIEW = read("../canvas/panel/session-view.tsx");
const SYNC = read("../canvas/panel/tree-gesture-sync.tsx");
const PANEL = read("../canvas/panel/connection.tsx");

describe("the gesture layer is mounted over the canvas, on the page it filters by", () => {
  // Keyed by an ATTRIBUTE name (that is what `jsxAttributes` matches on), and
  // `onAddGoal` is carried by exactly one element in this file.
  const mount = jsxAttributes(stripComments(VIEW), "onAddGoal");

  it("gets the live selection and the CURRENT page, not just a document", () => {
    // A dropped `currentPageId` is the bug the agent badges had
    // (agents-view.ts's note): chrome anchored to a shape on a page nobody is
    // looking at, at world coordinates that mean nothing on the one on screen.
    expect(mount.selection).toBe("editorState.selection");
    expect(mount.currentPageId).toBe("editorState.currentPageId");
    expect(mount.doc).toBe("snapshot");
    expect(mount.camera).toBe("editorState.camera");
  });

  it("is wired to the two gesture calls, not to something that merely exists", () => {
    expect(mount.onAddGoal).toBe("onAddGoal");
    expect(mount.onAddBlocker).toBe("onAddBlocker");
    expect(mount.pending).toBe("treeGesturePending");
  });

  it("sits OUTSIDE <Viewport>, as a later sibling", () => {
    // Inside it, the layer would be under canvas-react's own input surface and
    // every press on a control would also be a canvas gesture. Later-sibling
    // is what puts it on top, per Viewport's stacking contract — the same
    // place AgentLayer sits.
    const code = stripComments(VIEW);
    expect(code.indexOf("</Viewport>")).toBeLessThan(code.indexOf("<TreeGestureLayer"));
    expect(code.indexOf("<AgentLayer")).toBeLessThan(code.indexOf("<TreeGestureLayer"));
  });
});

describe("the layer asks the tested module for every decision", () => {
  const code = stripComments(LAYER);

  it("picks its target with treeGestureTargetFor, over the live selection", () => {
    const [call] = callsTo(code, "treeGestureTargetFor");
    expect(call).toBeDefined();
    expect(call.text).toContain("selection");
    expect(call.text).toContain("doc.byId.get(shapeId)");
  });

  it("gets the arm's label and enablement from blockerArmFor", () => {
    expect(callsTo(code, "blockerArmFor")).toHaveLength(1);
    // Enablement is the ARM's answer, not a second rule written here.
    expect(code).toContain("arm.enabled");
  });

  it("judges the typed title with treeTitleSubmission before sending it", () => {
    expect(callsTo(code, "treeTitleSubmission").length).toBeGreaterThan(0);
  });

  it("moves the composer only through nextTreeComposer", () => {
    expect(callsTo(code, "nextTreeComposer")).toHaveLength(1);
    // Every transition goes through the dispatcher, so none of them is a
    // `setComposer("closed")` written inline where no test can drive it.
    expect(code.split("setComposer(").length - 1).toBe(1);
  });

  it("is pointer-events none as a layer, so the canvas keeps every gesture", () => {
    expect(code).toContain('pointerEvents: "none"');
    expect(code).toContain('pointerEvents: "auto"');
  });
});

describe("the gestures call the rpc methods the contract declares", () => {
  const code = stripComments(SYNC);

  it("names canvas_tree_add_goal and canvas_tree_add_blocker", () => {
    // A typo in either string is invisible until a human presses the button:
    // there is no compile-time link from this call site to the contract.
    expect(code).toContain('"canvas_tree_add_goal"');
    expect(code).toContain('"canvas_tree_add_blocker"');
  });

  it("reports a write that landed WITH problems rather than swallowing it", () => {
    expect(code).toContain("answer.problems.length > 0");
    expect(code).toContain("toast.warning");
  });

  it("shows the engine's own refusal sentence on a rejection", () => {
    expect(code).toContain("toast.error");
    expect(code).toContain("cause.message");
  });
});

describe("the panel hands the hook's own calls down", () => {
  const mount = jsxAttributes(stripComments(PANEL), "onAddGoal");

  it("passes the tree gesture hook, not the agent one", () => {
    expect(mount.onAddGoal).toBe("treeGestures.addGoal");
    expect(mount.onAddBlocker).toBe("treeGestures.addBlocker");
    expect(mount.treeGesturePending).toBe("treeGestures.pending");
  });
});
