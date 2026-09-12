// Run: npx vitest run tests/tree-inspector.test.ts
//
// W18's second half: the INSPECTOR's decisions, as values rather than as JSX.
// This project has no jsdom, so a rule written inside a component is a rule no
// test can drive (canvas/agent-arms.ts's header states it; gestures.ts and
// discuss.ts are the same split).
//
// The claim that matters most here is NOT "the fields render". It is WHAT
// HAPPENS WHEN THE DOCUMENT MOVES UNDER AN OPEN EDITOR. This is a multiplayer
// canvas: an agent or another human can rewrite a context note while someone
// is typing into it, and a context note is up to 8000 characters of a human's
// thinking. The posture this whole run has taken — visible refusal over silent
// loss — decides every case below:
//
//   * a CLEAN editor follows the document (nothing to lose);
//   * a DIRTY editor never has its draft replaced: the incoming value is held
//     beside it and named, and the human chooses;
//   * a selection change while dirty does not throw the draft away either —
//     the new subject waits.
import { describe, expect, it } from "vitest";
import { buildTreeNode, markTreePage, MAX_CONTEXT_LENGTH } from "../canvas/tree/encoding.js";
import { makeDocument, type CanvasDocument, type Shape } from "@ensembleworks/canvas-model";
import { treeGestureTargetFor } from "../canvas/tree/gestures.js";
import {
  NO_CONTEXT_EDITOR,
  approachedArmFor,
  conflictNoticeFor,
  contextSubmission,
  inspectorSubjectFor,
  isDirty,
  nextContextEditor,
  saveArmFor,
  stateArmsFor,
  subjectFor,
  type ContextEditor,
} from "../canvas/tree/inspector.js";

const TREE_ID = "page:inspected";

const node = (id: string, over: Partial<Parameters<typeof buildTreeNode>[0]> = {}): Shape =>
  buildTreeNode({ id, treeId: TREE_ID, parentId: TREE_ID, index: "a1", x: 0, y: 0, ...over });

function docOf(shapes: readonly Shape[]): CanvasDocument {
  return makeDocument({
    pages: [markTreePage({ id: TREE_ID, name: "Tree" })],
    shapes: [...shapes],
    bindings: [],
  });
}

function viewOf(doc: CanvasDocument, selection: readonly string[], text: (id: string) => string = () => "") {
  const target = treeGestureTargetFor({
    selection: new Set(selection),
    shapeOf: (id) => doc.byId.get(id),
  });
  return inspectorSubjectFor({ target, shapeOf: (id) => doc.byId.get(id), textOf: text });
}

describe("what the inspector is looking at", () => {
  it("reads the same three fields the agent writes, off the selected node", () => {
    const doc = docOf([node("shape:a", { state: "wip", approached: true, context: "# Goal\nShip it" })]);
    const subject = viewOf(doc, ["shape:a"], (id) => (id === "shape:a" ? "Ship the loop" : ""));
    expect(subject).toEqual({
      nodeId: "shape:a",
      treeId: TREE_ID,
      title: "Ship the loop",
      state: "wip",
      approached: true,
      context: "# Goal\nShip it",
    });
  });

  it("takes the title from the channel a human types into, like every other reader", () => {
    const doc = docOf([node("shape:a")]);
    expect(viewOf(doc, ["shape:a"], () => "typed by a human")?.title).toBe("typed by a human");
  });

  it("has nothing to inspect with nothing selected, or with two shapes selected", () => {
    const doc = docOf([node("shape:a"), node("shape:b")]);
    expect(viewOf(doc, [])).toBeNull();
    expect(viewOf(doc, ["shape:a", "shape:b"])).toBeNull();
  });

  it("has nothing to inspect for a shape that is not a node of a tree", () => {
    const loose = { ...node("shape:loose"), meta: {} } as Shape;
    expect(viewOf(docOf([loose]), ["shape:loose"])).toBeNull();
  });

  it("reads a node that is NOT selected, for a draft held open on it", () => {
    const doc = docOf([node("shape:a", { context: "held" }), node("shape:b")]);
    expect(subjectFor("shape:a", (id) => doc.byId.get(id), () => "")?.context).toBe("held");
    expect(subjectFor("shape:gone", (id) => doc.byId.get(id), () => "")).toBeNull();
  });
});

describe("the arms", () => {
  const subject = {
    nodeId: "shape:a",
    treeId: TREE_ID,
    title: "t",
    state: "wip" as const,
    approached: false,
    context: "",
  };

  it("offers all three states and marks the one the node is in", () => {
    const arms = stateArmsFor(subject);
    expect(arms.map((arm) => arm.state)).toEqual(["todo", "wip", "done"]);
    expect(arms.filter((arm) => arm.selected).map((arm) => arm.state)).toEqual(["wip"]);
  });

  it("offers approached as a toggle that says which way it is about to go", () => {
    const off = approachedArmFor(subject);
    const on = approachedArmFor({ ...subject, approached: true });
    expect(off.pressed).toBe(false);
    expect(on.pressed).toBe(true);
    expect(off.label).not.toBe(on.label);
  });
});

describe("a context note, typed", () => {
  it("refuses a note over the encoding's cap before it is sent", () => {
    expect(contextSubmission("fine").ok).toBe(true);
    // Clearing a note is a legal edit, not an empty-title refusal.
    expect(contextSubmission("").ok).toBe(true);
    const over = contextSubmission("x".repeat(MAX_CONTEXT_LENGTH + 1));
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.why).toContain(String(MAX_CONTEXT_LENGTH));
  });

  it("will not send a note that is the same as the one already there", () => {
    const editor = nextContextEditor(NO_CONTEXT_EDITOR, {
      type: "subject",
      nodeId: "shape:a",
      context: "same",
    });
    expect(saveArmFor(editor).enabled).toBe(false);
    const typed = nextContextEditor(editor, { type: "typed", draft: "different" });
    expect(saveArmFor(typed).enabled).toBe(true);
  });
});

describe("when the document moves under an open editor", () => {
  const opened = (context = "theirs before"): ContextEditor =>
    nextContextEditor(NO_CONTEXT_EDITOR, { type: "subject", nodeId: "shape:a", context });

  it("follows the document while nothing has been typed", () => {
    const after = nextContextEditor(opened(), {
      type: "subject",
      nodeId: "shape:a",
      context: "an agent wrote this",
    });
    expect(after.draft).toBe("an agent wrote this");
    expect(after.base).toBe("an agent wrote this");
    expect(conflictNoticeFor(after)).toBeNull();
  });

  it("NEVER replaces a draft someone is typing — it holds the other value and says so", () => {
    const typing = nextContextEditor(opened(), { type: "typed", draft: "mine, half written" });
    const collided = nextContextEditor(typing, {
      type: "subject",
      nodeId: "shape:a",
      context: "an agent wrote this",
    });
    expect(collided.draft).toBe("mine, half written");
    expect(collided.theirs).toBe("an agent wrote this");
    expect(conflictNoticeFor(collided)).not.toBeNull();
  });

  it("lets the human take theirs, which discards the draft only because they asked", () => {
    const collided = nextContextEditor(
      nextContextEditor(opened(), { type: "typed", draft: "mine" }),
      { type: "subject", nodeId: "shape:a", context: "theirs" },
    );
    const took = nextContextEditor(collided, { type: "take-theirs" });
    expect(took.draft).toBe("theirs");
    expect(took.base).toBe("theirs");
    expect(isDirty(took)).toBe(false);
    expect(conflictNoticeFor(took)).toBeNull();
  });

  it("lets the human keep theirs overwritten — and rebases what the save expects", () => {
    const collided = nextContextEditor(
      nextContextEditor(opened(), { type: "typed", draft: "mine" }),
      { type: "subject", nodeId: "shape:a", context: "theirs" },
    );
    const kept = nextContextEditor(collided, { type: "keep-mine" });
    expect(kept.draft).toBe("mine");
    // The save must state what it is overwriting, or the server refuses it
    // again for the value the human has now seen and accepted.
    expect(kept.base).toBe("theirs");
    expect(conflictNoticeFor(kept)).toBeNull();
    expect(saveArmFor(kept).enabled).toBe(true);
  });

  it("holds a draft when the selection moves, and follows once it is resolved", () => {
    const typing = nextContextEditor(opened(), { type: "typed", draft: "mine" });
    const moved = nextContextEditor(typing, {
      type: "subject",
      nodeId: "shape:b",
      context: "b's note",
    });
    expect(moved.nodeId).toBe("shape:a");
    expect(moved.draft).toBe("mine");
    expect(moved.waiting?.nodeId).toBe("shape:b");

    const saved = nextContextEditor(moved, { type: "saved", context: "mine" });
    expect(saved.nodeId).toBe("shape:b");
    expect(saved.draft).toBe("b's note");
    expect(saved.waiting).toBeNull();
  });

  it("discards on the human's say-so, and then follows the selection too", () => {
    const typing = nextContextEditor(opened(), { type: "typed", draft: "mine" });
    const moved = nextContextEditor(typing, { type: "subject", nodeId: "shape:b", context: "b's note" });
    const discarded = nextContextEditor(moved, { type: "discarded" });
    expect(discarded.nodeId).toBe("shape:b");
    expect(discarded.draft).toBe("b's note");
  });

  it("closes cleanly when the selection goes away with nothing typed", () => {
    const after = nextContextEditor(opened(), { type: "subject", nodeId: null, context: "" });
    expect(after.nodeId).toBeNull();
    expect(after.draft).toBe("");
  });
});
