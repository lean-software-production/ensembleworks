// Run: npx vitest run tests/tree-inspector-wiring.test.ts
//
// THE .tsx SEAMS OF W18. No jsdom here, so nothing can mount the panel and
// type into it; the strongest honest statement left is that each component
// ASKS the tested module for its decisions and attaches them to the right
// element — read out of parsed, comment-stripped source (tests/lib/source.ts
// explains why the comments must go first).
//
// Deliberately SHORT, and each guard was checked by breaking the line it
// guards (the mutation table in w18-node-inspector.md).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { callsTo, jsxAttributes, stripComments } from "./lib/source.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const INSPECTOR = stripComments(read("../canvas/panel/tree-inspector.tsx"));
const MARKS = stripComments(read("../canvas/panel/tree-state-layer.tsx"));
const SYNC = stripComments(read("../canvas/panel/tree-inspector-sync.tsx"));
const VIEW = stripComments(read("../canvas/panel/session-view.tsx"));

describe("the marks are drawn from the tested module, over the live canvas", () => {
  it("asks nodeStateMarks for every mark, and decides nothing itself", () => {
    expect(callsTo(MARKS, "nodeStateMarks")).toHaveLength(1);
    // The state -> words/ink mapping is node-view.ts's; a second one here
    // would be a second answer to "what does done look like".
    expect(MARKS).not.toContain("readTreeNode");
    expect(MARKS).not.toContain('"done"');
  });

  it("never takes a gesture from the canvas underneath", () => {
    expect(MARKS).toContain('pointerEvents: "none"');
  });

  it("stops where the canvas does, so a chip cannot paint over the inspector", () => {
    // `screenBoxFor` keeps a node whose box merely intersects the viewport, so
    // a chip near the right edge is placed beyond this layer's own box.
    expect(MARKS).toContain('overflow: "hidden"');
  });

  it("is mounted with the live snapshot and the page it must not draw across", () => {
    // Both are what make a mark track pan, zoom, drag and remote edits without
    // subscribing to anything (node-view.ts) — and what stops another page's
    // nodes being marked over this one.
    const mount = VIEW.slice(VIEW.indexOf("<TreeStateLayer"));
    const attrs = mount.slice(0, mount.indexOf("/>"));
    expect(attrs).toContain("doc={snapshot}");
    expect(attrs).toContain("currentPageId={editorState.currentPageId}");
    expect(attrs).toContain("camera={editorState.camera}");
  });
});

describe("the inspector asks the tested module for its rules", () => {
  it("takes the chrome's own target rather than reading the selection twice", () => {
    expect(callsTo(INSPECTOR, "inspectorSubjectFor")).toHaveLength(1);
    expect(callsTo(INSPECTOR, "treeGestureTargetFor")).toHaveLength(1);
  });

  it("feeds the document's answer through the editor rule as ONE event", () => {
    const [subject] = callsTo(INSPECTOR, "dispatch");
    expect(subject.text).toContain('type: "subject"');
    // The selection moving and a peer rewriting the note are the same event;
    // telling them apart is nextContextEditor's job (tree-inspector.test.ts).
    expect(INSPECTOR).not.toContain('type: "selection"');
  });

  it("states what the save expects, so the engine can refuse a stale one", () => {
    const [save] = callsTo(INSPECTOR, "onWriteContext");
    expect(save.text).toContain("editor.base");
  });

  it("adopts a save ONLY when the server said it landed", () => {
    expect(INSPECTOR).toContain('if (landed) dispatch({ type: "saved"');
  });

  it("gets the save button's enablement from saveArmFor, not from a local rule", () => {
    const button = jsxAttributes(INSPECTOR, "data-tree-inspector-save");
    expect(button.disabled).toContain("save.enabled");
  });
});

describe("every edit goes over rpc into the write engine", () => {
  it("names the three server methods and mutates no local document", () => {
    expect(SYNC).toContain("canvas_tree_set_state");
    expect(SYNC).toContain("canvas_tree_set_approached");
    expect(SYNC).toContain("canvas_tree_write_context");
    expect(SYNC).not.toContain("putShape");
    expect(INSPECTOR).not.toContain("putShape");
  });

  it("carries `expected` on the note write — the compare-and-set the panel owes", () => {
    const [context] = callsTo(SYNC, "run").filter((call) => call.text.includes("write_context"));
    expect(context).toBeDefined();
    expect(context.text).toContain("expected");
  });

  it("reports a refusal as false rather than throwing it away", () => {
    expect(SYNC).toContain("return false");
    expect(SYNC).toContain("return true");
  });
});
