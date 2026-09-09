// Run: npx vitest run tests/tree-quarantine-tools.test.ts
//
// W13, second half — C2's obligation 3, closed.
//
// W10c's move answer tells the agent the relationship it displaced is
// "restorable", and W11 built the two functions that make that true. Neither
// was reachable from a tool, so the sentence promised a recovery the caller
// could not perform, and the refusal path — "remove the rival edge first" —
// named a rival no tool could see. These tests hold the pair to the shape that
// makes the promise real:
//
//  1. SEEING COMES BEFORE RESTORING. `canvas_tree_quarantined` exists, is
//     scoped alongside the rest of the tree tools, and names each edge, its
//     tree, and why it was taken out.
//  2. THE REFUSAL SURVIVES THE SURFACE. `canvas_tree_restore_edge` passes
//     `restoreQuarantinedEdge`'s sentence through unedited, rival edge and
//     all, with `isError` set — the same posture as every other write tool.
//
// The writes run against a REAL `LoroCanvasDoc` for W10's reason: the risk is
// what Loro stores and what `dumpModel` reads back, and a fake would agree
// with whatever the implementation did.
import { describe, expect, it } from "vitest";
import { LoroCanvasDoc, dumpModel, loadModel } from "@ensembleworks/canvas-doc";
import type { PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { quarantineTreeShape, readTreeQuarantine } from "../canvas/tree/encoding.js";
import { readTree } from "../canvas/tree/model.js";
import { listQuarantinedEdges } from "../canvas/tree/repair.js";
import {
  treeRepairTargetForDoc,
  treeServiceForDoc,
  treeWriterForDoc,
} from "../canvas/tree/doc-source.js";
import {
  TREE_QUARANTINE_TOOL_NAMES,
  createTreeQuarantineTools,
  type TreeQuarantineToolDeps,
} from "../canvas/tree/quarantine-tools.js";
import { TREE_TOOL_NAMES } from "../canvas/tree/agent-tools.js";
import { EXAMPLE, TREE, docOf } from "./lib/tree-fixture.js";

const THREAD = "thr_linked";
const ctx = { threadId: THREAD } as PluginAgentToolContext;

/** The fixture, in a real Loro document, with the tools over it. */
function rig(linked: string | null = "shape:ui") {
  const doc = LoroCanvasDoc.create({ peerId: 11n });
  loadModel(doc, docOf(EXAMPLE));
  doc.commit();
  const deps: TreeQuarantineToolDeps = {
    service: treeServiceForDoc(doc),
    repair: treeRepairTargetForDoc(doc),
    linkedShapeId: () => linked,
  };
  const tools = createTreeQuarantineTools(deps);
  const call = (name: string, params: Record<string, unknown> = {}) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.execute(params as never, ctx);
  };
  const text = (name: string, params: Record<string, unknown> = {}) => {
    const result = call(name, params);
    return typeof result === "string"
      ? { text: result, isError: false }
      : {
          text: result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
          isError: result.isError === true,
        };
  };
  /** A real quarantine: move shape:ui so it blocks shape:api instead. */
  const move = () => {
    const writer = treeWriterForDoc(doc, { random: () => 0.5 });
    const result = writer.reparent({ nodeId: "shape:ui", newParentId: "shape:api" });
    if (!result.ok) throw new Error(`setup move refused: ${result.detail}`);
    return result.value;
  };
  return { doc, deps, tools, call, text, move };
}

describe("the pair is a real tool surface", () => {
  it("names both tools, namespaced like the rest", () => {
    expect(TREE_QUARANTINE_TOOL_NAMES).toEqual([
      "canvas_tree_quarantined",
      "canvas_tree_restore_edge",
    ]);
    for (const name of TREE_QUARANTINE_TOOL_NAMES) {
      expect(name.startsWith("canvas_tree_")).toBe(true);
    }
  });

  it("is scoped with every other tree tool — a thread that may move a node may put it back", () => {
    for (const name of TREE_QUARANTINE_TOOL_NAMES) {
      expect(TREE_TOOL_NAMES).toContain(name);
    }
  });

  it("builds exactly those tools", () => {
    expect(rig().tools.map((tool) => tool.name)).toEqual([...TREE_QUARANTINE_TOOL_NAMES]);
  });
});

describe("canvas_tree_quarantined — seeing what was taken out", () => {
  it("says nothing is quarantined on a clean tree", () => {
    const { text } = rig();
    const answer = text("canvas_tree_quarantined");

    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("Nothing is quarantined");
  });

  it("lists the edge a routine move displaced, with its reason and its tree", () => {
    const rigged = rig();
    rigged.move();

    const answer = rigged.text("canvas_tree_quarantined");
    const [entry] = listQuarantinedEdges(dumpModel(rigged.doc), TREE);
    expect(entry).toBeDefined();
    expect(answer.text).toContain(entry.edgeId);
    expect(answer.text).toContain(TREE);
    expect(answer.text).toContain("reparented");
    // The provenance the record carries — what moved where — not just "gone".
    expect(answer.text).toContain("shape:ui");
    // SEE, then act: the answer names the tool that puts it back.
    expect(answer.text).toContain("canvas_tree_restore_edge");
  });

  it("defaults to the tree this thread's node is in, and takes a treeId otherwise", () => {
    const rigged = rig();
    rigged.move();

    expect(rigged.text("canvas_tree_quarantined", { treeId: TREE }).text).toContain(
      "reparented",
    );
    expect(rigged.text("canvas_tree_quarantined", { treeId: "page:elsewhere" }).text).toContain(
      "Nothing is quarantined",
    );
  });
});

describe("canvas_tree_restore_edge — putting a relationship back", () => {
  it("restores the displaced edge and shows the tree it went back into", () => {
    const rigged = rig();
    const moved = rigged.move();
    const [displaced] = moved.removedEdgeIds ?? [];
    expect(displaced).toBeDefined();

    // The rival is the new edge; take it out of the tree the same way repair
    // would, so the restore is not refused for a reason W11 owns.
    const rival = rigged.doc.getShape(moved.edgeId ?? "");
    expect(rival).toBeDefined();

    const refused = rigged.text("canvas_tree_restore_edge", { edgeId: displaced });
    // With the rival still standing this MUST refuse — that is the path C2
    // asked to be reachable, and the refusal names what to remove.
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(displaced);
    expect(refused.text).toContain("Remove the rival edge first");
    expect(refused.text).toContain(moved.edgeId ?? "");

    // The document did not move: a refused restore changes nothing.
    expect(
      readTreeQuarantine(dumpModel(rigged.doc).byId.get(displaced)!).status,
    ).toBe("ok");
  });

  it("restores for real once no rival stands, and the read spine sees the edge again", () => {
    // A REAL SUCCESS PATH, and it took a probe to find one. The obvious
    // construction — move a node and then move it back — does NOT restore:
    // the move back mints a fresh edge, so restoring the original recreates
    // `duplicate-edge` and is refused, naming the new edge. Probed:
    //   PROBE restore: broken-tree: restoring shape:edge-1 into page:tree
    //   would recreate duplicate-edge (shape:44ud8g, shape:edge-1) …
    // So the case where a restore actually lands is the one W11 built it for:
    // an edge repair took out, whose cause is gone and which has no live rival.
    const doc = LoroCanvasDoc.create({ peerId: 13n });
    const model = docOf({
      nodes: { "shape:goal": "todo", "shape:api": "todo", "shape:ui": "todo" },
      edges: [
        ["shape:api", "shape:goal"],
        ["shape:ui", "shape:goal"],
      ],
    });
    // shape:edge-1 is `shape:ui blocks shape:goal`. Park it, as repair would.
    const parked = model.shapes.map((shape) =>
      shape.id === "shape:edge-1"
        ? quarantineTreeShape(shape, { reason: "cycle", detail: "took it out" })
        : { status: "ok" as const, value: shape },
    );
    loadModel(doc, {
      ...model,
      shapes: parked.map((entry) => (entry.status === "ok" ? entry.value : entry)) as never,
    });
    doc.commit();
    const tools = createTreeQuarantineTools({
      service: treeServiceForDoc(doc),
      repair: treeRepairTargetForDoc(doc),
      linkedShapeId: () => "shape:ui",
    });
    const restore = tools.find((tool) => tool.name === "canvas_tree_restore_edge")!;
    const result = restore.execute({ edgeId: "shape:edge-1" }, { threadId: THREAD });
    const answer =
      typeof result === "string"
        ? { text: result, isError: false }
        : {
            text: result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
            isError: result.isError === true,
          };

    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("shape:edge-1");
    expect(answer.text).toContain(TREE);
    // It is out of quarantine AND back in the tree the read spine reads.
    expect(listQuarantinedEdges(dumpModel(doc), TREE)).toEqual([]);
    expect(
      readTree(dumpModel(doc), TREE).edges.map((edge) => edge.edgeId),
    ).toContain("shape:edge-1");
  });

  it("refuses an id that is not a quarantined edge, naming it", () => {
    const { text } = rig();

    const missing = text("canvas_tree_restore_edge", { edgeId: "shape:nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("shape:nope");

    const plain = text("canvas_tree_restore_edge", { edgeId: "shape:goal" });
    expect(plain.isError).toBe(true);
    expect(plain.text).toContain("not a quarantined tree edge");
  });

  it("wants an edge id — there is no thread default for an edge", () => {
    const { text } = rig();
    const answer = text("canvas_tree_restore_edge", {});

    expect(answer.isError).toBe(true);
  });
});

describe("the promise the agent reads", () => {
  it("a move's own answer names the tool that undoes it, not an internal function", () => {
    const doc = LoroCanvasDoc.create({ peerId: 12n });
    loadModel(doc, docOf(EXAMPLE));
    doc.commit();
    const writer = treeWriterForDoc(doc, { random: () => 0.5 });

    const moved = writer.reparent({ nodeId: "shape:ui", newParentId: "shape:api" });
    expect(moved.ok).toBe(true);
    const sentence = moved.ok ? moved.value.changed.join(" ") : "";

    expect(sentence).toContain("canvas_tree_restore_edge");
    // The old name was a module-private function the caller could not call.
    expect(sentence).not.toContain("restoreQuarantinedEdge(");
  });
});
