// Run: npx vitest run tests/tree-inspector-writes.test.ts
//
// W18's write half, against a REAL `LoroCanvasDoc` for W10's own reason: the
// risk is what the document stores and reads back, and a hand-rolled fake
// would agree with whatever the implementation happened to do.
//
// Two things are new here and nothing else is:
//
//  1. `setApproached`. `meta.approached` was writable by nothing at all — the
//     encoding has carried the field since W0, the read spine reports it, and
//     no operation ever set it. A human control that could not go through the
//     write seam would have had to mutate the local document, which is the one
//     thing W4 refused to do.
//  2. `writeContext` gains an OPTIONAL `expected`. A context note is up to
//     8000 characters of a human's thinking, and this is a multiplayer canvas:
//     the panel sends what it believed was there, and the engine REFUSES —
//     `stale-write` — rather than overwriting a note that changed underneath.
//     Agents keep calling it without `expected`, exactly as before.
import { describe, expect, it } from "vitest";
import { LoroCanvasDoc, dumpModel, loadModel } from "@ensembleworks/canvas-doc";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import { readTreeNode } from "../canvas/tree/encoding.js";
import { readTree, checkTreeInvariants } from "../canvas/tree/model.js";
import { treeWriterForDoc } from "../canvas/tree/doc-source.js";
import type { TreeWriter } from "../canvas/tree/write-seam.js";
import { EXAMPLE, TREE, docOf } from "./lib/tree-fixture.js";

const GOAL = "shape:goal";

function rig(): { doc: LoroCanvasDoc; writer: TreeWriter; document: () => CanvasDocument } {
  const doc = LoroCanvasDoc.create({ peerId: 9n });
  loadModel(doc, docOf(EXAMPLE));
  doc.commit();
  return { doc, writer: treeWriterForDoc(doc), document: () => dumpModel(doc) };
}

const metaOf = (document: CanvasDocument, id = GOAL) => {
  const read = readTreeNode(document.byId.get(id)!);
  if (read.status !== "ok") throw new Error(`unreadable node ${id}`);
  return read.value;
};

const cleanTree = (document: CanvasDocument) => {
  const tree = readTree(document, TREE);
  return [...tree.problems, ...checkTreeInvariants(tree)];
};

describe("setApproached", () => {
  it("records that we looked at a node and nothing came up", () => {
    const { writer, document } = rig();
    const result = writer.setApproached({ nodeId: GOAL, approached: true });
    expect(result.ok).toBe(true);
    expect(metaOf(document()).approached).toBe(true);
    expect(cleanTree(document())).toEqual([]);
  });

  it("takes it back off again", () => {
    const { writer, document } = rig();
    writer.setApproached({ nodeId: GOAL, approached: true });
    writer.setApproached({ nodeId: GOAL, approached: false });
    expect(metaOf(document()).approached).toBe(false);
  });

  it("says what it did, and says when it did nothing", () => {
    const { writer } = rig();
    const first = writer.setApproached({ nodeId: GOAL, approached: true });
    const again = writer.setApproached({ nodeId: GOAL, approached: true });
    expect(first.ok && first.value.changed.join(" ")).toContain(GOAL);
    expect(again.ok && again.value.changed.join(" ").toLowerCase()).toContain("already");
  });

  it("leaves the node's state and context alone — it is a separate axis", () => {
    const { writer, document } = rig();
    writer.writeContext({ nodeId: GOAL, context: "the note" });
    writer.setApproached({ nodeId: GOAL, approached: true });
    const meta = metaOf(document());
    expect(meta.state).toBe("todo");
    expect(meta.context).toBe("the note");
  });

  it("refuses a shape that is not a node of a tree, naming it", () => {
    const { writer, document } = rig();
    const before = JSON.stringify(document().shapes.map((shape) => shape.meta));
    const result = writer.setApproached({ nodeId: "shape:nope", approached: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("no-such-node");
    expect(result.ok === false && result.detail).toContain("shape:nope");
    expect(JSON.stringify(document().shapes.map((shape) => shape.meta))).toBe(before);
  });
});

describe("writeContext, when someone else got there first", () => {
  it("writes when the note is what the caller believed it was", () => {
    const { writer, document } = rig();
    writer.writeContext({ nodeId: GOAL, context: "first" });
    const result = writer.writeContext({ nodeId: GOAL, context: "second", expected: "first" });
    expect(result.ok).toBe(true);
    expect(metaOf(document()).context).toBe("second");
  });

  it("REFUSES rather than overwriting a note that changed underneath", () => {
    const { writer, document } = rig();
    writer.writeContext({ nodeId: GOAL, context: "an agent's note" });
    const result = writer.writeContext({
      nodeId: GOAL,
      context: "mine, typed against an empty note",
      expected: "",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("stale-write");
    // The refusal must be actionable: it names the node and how much writing
    // it would have destroyed.
    expect(result.ok === false && result.detail).toContain(GOAL);
    expect(metaOf(document()).context).toBe("an agent's note");
  });

  it("still lets an agent write without stating an expectation at all", () => {
    const { writer, document } = rig();
    writer.writeContext({ nodeId: GOAL, context: "an agent's note" });
    const result = writer.writeContext({ nodeId: GOAL, context: "a later note" });
    expect(result.ok).toBe(true);
    expect(metaOf(document()).context).toBe("a later note");
  });

  it("treats an empty expectation as a real one — not as 'no expectation'", () => {
    const { writer } = rig();
    writer.writeContext({ nodeId: GOAL, context: "somebody wrote this" });
    const result = writer.writeContext({ nodeId: GOAL, context: "mine", expected: "" });
    expect(result.ok).toBe(false);
  });
});
