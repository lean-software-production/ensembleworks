// Run: npx vitest run tests/tree-repair.test.ts
//
// W11's gate. W10 refuses writes that are illegal ON THEIR OWN; this suite is
// about the damage that two writes, each legal when it was made, produce when
// a CRDT merges them. No preflight anywhere can prevent that, so the only
// question is what happens afterwards.
//
// THE RULE THIS WHOLE SUITE IS BUILT AROUND: REPAIR NEVER SILENTLY DROPS A
// HUMAN EDIT. Every repair test therefore asserts the same two things, through
// `keptEverything`:
//
//   1. the tree is no longer broken, and
//   2. NOT ONE SHAPE AND NOT ONE BINDING LEFT THE DOCUMENT.
//
// The second is the load-bearing one. Repair QUARANTINES a losing edge — it
// takes the arrow out of the tree by moving `meta.tree` into
// `meta.treeQuarantine`, and leaves the arrow, its two bindings and its
// geometry exactly where the human drew them. The relationship comes back by
// putting one meta key back (`restoreQuarantinedEdge`), which is why the
// restore tests sit in here rather than in a follow-up.
//
// THE PEERS ARE REAL. Two `LoroCanvasDoc`s forked from one snapshot, each
// writing through W10's real writer, merged into a third — because the whole
// subject of this node is what Loro's merge produces, and a hand-built
// "conflicted" document would only prove that the repairer agrees with my
// guess about it.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { LoroCanvasDoc, dumpModel, loadModel } from "@ensembleworks/canvas-doc";
import { Frame, encode } from "@ensembleworks/canvas-sync";
import { makeDocument, type Binding, type CanvasDocument, type Shape } from "@ensembleworks/canvas-model";
import {
  BLOCKED_TERMINAL,
  BLOCKER_TERMINAL,
  TREE_KEY,
  MAX_QUARANTINE_DETAIL,
  TREE_QUARANTINE_KEY,
  buildTreeEdge,
  buildTreeNode,
  edgeBindingId,
  quarantineTreeShape,
  readTreeQuarantine,
} from "../canvas/tree/encoding.js";
import { checkTreeInvariants, readTree, type TreeProblem } from "../canvas/tree/model.js";
import { treeWriterForDoc } from "../canvas/tree/doc-source.js";
import { REPARENT_REASON, type TreeWriteTarget } from "../canvas/tree/writes.js";
import {
  REPAIRABLE_KINDS,
  applyTreeRepair,
  listQuarantinedEdges,
  repairAllTrees,
  restoreQuarantinedEdge,
  treeRepairPlan,
  type TreeRepairTarget,
} from "../canvas/tree/repair.js";
import { CanvasRoomHost } from "../canvas/room.js";
import { CANVAS_MIGRATIONS, CanvasStore } from "../canvas/store.js";
import { EXAMPLE, TREE, docOf, type Spec } from "./lib/tree-fixture.js";

// ---------------------------------------------------------------------------
// Rigs
// ---------------------------------------------------------------------------

/** A seeded id stream, so each peer mints ids a test can name. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Every problem a tree has, structural and graph — "is this tree broken". */
const problemsOf = (doc: CanvasDocument, treeId = TREE): readonly TreeProblem[] => {
  const tree = readTree(doc, treeId);
  return [...tree.problems, ...checkTreeInvariants(tree)];
};

const kinds = (problems: readonly TreeProblem[]): string[] =>
  [...new Set(problems.map((problem) => problem.kind))].sort();

/**
 * A repair target over a live Loro document, plus the census this suite checks
 * against. `putShape` is the ONLY mutator repair is given — there is no
 * `deleteShape` and no `deleteBinding` on `TreeRepairTarget`, which is the
 * no-silent-drop rule expressed in the type rather than only in a test.
 */
function targetFor(doc: LoroCanvasDoc): TreeRepairTarget {
  return {
    document: () => dumpModel(doc),
    getShape: (id) => doc.getShape(id),
    putShape: (shape) => doc.putShape(shape),
    commit: () => doc.commit(),
  };
}

/** Shape ids and binding ids, sorted — the census "nothing was dropped" reads. */
function census(doc: CanvasDocument): { shapes: string[]; bindings: string[] } {
  return {
    shapes: doc.shapes.map((shape) => shape.id).sort(),
    bindings: (doc.bindings as readonly Binding[]).map((binding) => binding.id).sort(),
  };
}

/**
 * The assertion every repair test makes: the tree is whole again AND the
 * document still holds every shape and every binding it held before.
 */
function keptEverything(before: CanvasDocument, after: CanvasDocument): void {
  expect(census(after)).toEqual(census(before));
}

/**
 * The edges REPAIR took out, ignoring the ones a reparent parked. Both are
 * quarantines by design — a move takes its old edge out of the tree the same
 * way repair does, rather than tombstoning an arrow a human drew (C2 finding
 * 1) — and only the reason tells them apart.
 */
const repairQuarantines = (doc: CanvasDocument, treeId = TREE): string[] =>
  listQuarantinedEdges(doc, treeId)
    .filter((entry) => entry.quarantine.reason !== REPARENT_REASON)
    .map((entry) => entry.edgeId);

/** Two peers forked from one snapshot of `spec`, and the merge of their work. */
function twoPeers(spec: Spec = EXAMPLE): {
  a: LoroCanvasDoc;
  b: LoroCanvasDoc;
  merge(order?: "ab" | "ba"): LoroCanvasDoc;
} {
  const base = LoroCanvasDoc.create({ peerId: 1n });
  loadModel(base, docOf(spec));
  base.commit();
  const snapshot = base.exportSnapshot();
  const a = LoroCanvasDoc.fromSnapshot(snapshot, { peerId: 2n });
  const b = LoroCanvasDoc.fromSnapshot(snapshot, { peerId: 3n });
  return {
    a,
    b,
    merge(order = "ab") {
      const merged = LoroCanvasDoc.fromSnapshot(snapshot, { peerId: 9n });
      const updates = order === "ab" ? [a, b] : [b, a];
      for (const peer of updates) merged.import(peer.exportUpdate());
      merged.commit();
      return merged;
    },
  };
}

/** A document loaded straight into Loro, for the single-peer damage shapes. */
function liveDoc(doc: CanvasDocument): LoroCanvasDoc {
  const live = LoroCanvasDoc.create({ peerId: 7n });
  loadModel(live, doc);
  live.commit();
  return live;
}

// ---------------------------------------------------------------------------
// The adversarial case the plan names
// ---------------------------------------------------------------------------

describe("two peers reparent each other's node", () => {
  /**
   * Peer A moves `ui` under `schema`; peer B moves `schema` under `ui`. Each
   * is a legal reparent against the state its own peer could see — W10's
   * cycle check passes on both — and the merge says each blocks the other.
   */
  function conflicted(): { merged: LoroCanvasDoc; aEdge: string; bEdge: string } {
    const peers = twoPeers();
    const wa = treeWriterForDoc(peers.a, {
      commit: () => peers.a.commit(),
      random: seededRandom(11),
    });
    const wb = treeWriterForDoc(peers.b, {
      commit: () => peers.b.commit(),
      random: seededRandom(97),
    });
    const moveA = wa.reparent({ nodeId: "shape:ui", newParentId: "shape:schema" });
    const moveB = wb.reparent({ nodeId: "shape:schema", newParentId: "shape:ui" });
    if (!moveA.ok) return expect.unreachable(`peer A was refused: ${moveA.detail}`);
    if (!moveB.ok) return expect.unreachable(`peer B was refused: ${moveB.detail}`);
    return {
      merged: peers.merge(),
      aEdge: moveA.value.edgeId as string,
      bEdge: moveB.value.edgeId as string,
    };
  }

  it("each write is legal on its own peer", () => {
    const { aEdge, bEdge } = conflicted();
    // Different ids, or the merge would be an upsert rather than a conflict
    // and this suite would be testing nothing.
    expect(aEdge).not.toEqual(bEdge);
  });

  it("the MERGED document contains a cycle neither write could have made", () => {
    const { merged } = conflicted();
    const problems = problemsOf(dumpModel(merged));
    expect(kinds(problems)).toContain("cycle");
    const cycle = problems.find((problem) => problem.kind === "cycle") as TreeProblem;
    expect([...cycle.subjects].sort()).toEqual(["shape:schema", "shape:ui"]);
  });

  it("repair breaks the cycle by quarantining exactly one edge, and drops nothing", () => {
    const { merged, aEdge, bEdge } = conflicted();
    const before = dumpModel(merged);
    const report = applyTreeRepair(targetFor(merged), TREE);
    const after = dumpModel(merged);

    expect(report.applied.map((op) => op.edgeId)).toEqual([[aEdge, bEdge].sort()[0]]);
    expect(report.applied[0]?.reason).toBe("cycle");
    expect(problemsOf(after)).toEqual([]);
    keptEverything(before, after);
  });

  it("the quarantined arrow is still on the canvas, still bound, and says why", () => {
    const { merged } = conflicted();
    const report = applyTreeRepair(targetFor(merged), TREE);
    const edgeId = report.applied[0]?.edgeId as string;
    const after = dumpModel(merged);

    const arrow = after.byId.get(edgeId) as Shape;
    expect(arrow).toBeDefined();
    expect(arrow.meta[TREE_KEY]).toBeUndefined();
    const bindings = (after.bindings as readonly Binding[]).filter(
      (binding) => binding.fromId === edgeId,
    );
    expect(bindings.map((binding) => binding.id).sort()).toEqual(
      [edgeBindingId(edgeId, BLOCKER_TERMINAL), edgeBindingId(edgeId, BLOCKED_TERMINAL)].sort(),
    );

    const quarantine = readTreeQuarantine(arrow);
    if (quarantine.status !== "ok") return expect.unreachable("the arrow carries no quarantine");
    expect(quarantine.value.tree).toBe(TREE);
    expect(quarantine.value.reason).toBe("cycle");
    expect(quarantine.value.detail).toContain("shape:schema");
  });

  it("the report names the edge and how to get the relationship back", () => {
    const { merged } = conflicted();
    const report = applyTreeRepair(targetFor(merged), TREE);
    const text = report.lines.join("\n");
    expect(text).toContain(report.applied[0]?.edgeId as string);
    expect(text).toContain("restore");
  });

  it("both merge orders reach the SAME repaired state", () => {
    const peers = twoPeers();
    const wa = treeWriterForDoc(peers.a, { commit: () => peers.a.commit(), random: seededRandom(11) });
    const wb = treeWriterForDoc(peers.b, { commit: () => peers.b.commit(), random: seededRandom(97) });
    wa.reparent({ nodeId: "shape:ui", newParentId: "shape:schema" });
    wb.reparent({ nodeId: "shape:schema", newParentId: "shape:ui" });

    const ab = treeRepairPlan(dumpModel(peers.merge("ab")), TREE);
    const ba = treeRepairPlan(dumpModel(peers.merge("ba")), TREE);
    expect(ab.ops).toEqual(ba.ops);
  });
});

// ---------------------------------------------------------------------------
// Determinism — the plan is a function of CONTENT, never of order
// ---------------------------------------------------------------------------

describe("the plan is deterministic", () => {
  /** The same document with its shapes and bindings listed backwards. Two
   * peers holding identical converged state genuinely iterate in different
   * orders (model.ts's header makes the same argument for the reader). */
  const reversed = (doc: CanvasDocument): CanvasDocument =>
    makeDocument({
      pages: [...doc.pages].reverse(),
      shapes: [...doc.shapes].reverse(),
      bindings: [...(doc.bindings as readonly Binding[])].reverse(),
    });

  const CYCLIC: Spec = {
    nodes: { "shape:a": "todo", "shape:b": "todo", "shape:c": "todo", "shape:goal": "todo" },
    edges: [
      ["shape:a", "shape:goal"],
      ["shape:b", "shape:a"],
      ["shape:c", "shape:b"],
      ["shape:a", "shape:c"],
    ],
  };

  it("input order does not change the plan", () => {
    const doc = docOf(CYCLIC);
    expect(treeRepairPlan(reversed(doc), TREE).ops).toEqual(treeRepairPlan(doc, TREE).ops);
  });

  it("planning twice over the same document gives the same plan", () => {
    const doc = docOf(CYCLIC);
    expect(treeRepairPlan(doc, TREE).ops).toEqual(treeRepairPlan(doc, TREE).ops);
  });

  it("a healthy tree plans nothing and is never written to", () => {
    const live = liveDoc(docOf(EXAMPLE));
    const before = dumpModel(live);
    let commits = 0;
    const target: TreeRepairTarget = {
      ...targetFor(live),
      putShape: () => expect.unreachable("repair wrote to a healthy tree"),
      commit: () => {
        commits += 1;
      },
    };
    const report = applyTreeRepair(target, TREE);
    expect(report.applied).toEqual([]);
    expect(commits).toBe(0);
    keptEverything(before, dumpModel(live));
  });

  it("repair converges in one call — a second pass has nothing to do", () => {
    const live = liveDoc(docOf(CYCLIC));
    expect(applyTreeRepair(targetFor(live), TREE).applied.length).toBeGreaterThan(0);
    const second = applyTreeRepair(targetFor(live), TREE);
    expect(second.applied).toEqual([]);
    expect(second.remaining).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The other damage two legal edits produce
// ---------------------------------------------------------------------------

describe("duplicate edges", () => {
  /** Both peers discover the same blocker and say so. Neither write is
   * illegal; the merge asserts one relationship twice. */
  function duplicated(): { merged: LoroCanvasDoc; edges: string[] } {
    const peers = twoPeers({
      nodes: { "shape:goal": "todo", "shape:api": "todo" },
      edges: [],
    });
    const wa = treeWriterForDoc(peers.a, { commit: () => peers.a.commit(), random: seededRandom(3) });
    const wb = treeWriterForDoc(peers.b, { commit: () => peers.b.commit(), random: seededRandom(29) });
    const ra = wa.reparent({ nodeId: "shape:api", newParentId: "shape:goal" });
    const rb = wb.reparent({ nodeId: "shape:api", newParentId: "shape:goal" });
    if (!ra.ok || !rb.ok) return expect.unreachable("a peer was refused a legal reparent");
    return {
      merged: peers.merge(),
      edges: [ra.value.edgeId as string, rb.value.edgeId as string].sort(),
    };
  }

  it("the merge holds the relationship twice", () => {
    expect(kinds(problemsOf(dumpModel(duplicated().merged)))).toContain("duplicate-edge");
  });

  it("repair keeps the smallest edge id and quarantines the rest", () => {
    const { merged, edges } = duplicated();
    const before = dumpModel(merged);
    const report = applyTreeRepair(targetFor(merged), TREE);
    expect(report.applied.map((op) => op.edgeId)).toEqual(edges.slice(1));
    expect(report.applied[0]?.reason).toBe("duplicate-edge");
    const after = dumpModel(merged);
    expect(problemsOf(after)).toEqual([]);
    // THE RELATIONSHIP SURVIVES — this is not a lost edit, it is a redundant
    // row collapsed, and the surviving edge still says what both peers said.
    expect(readTree(after, TREE).edges.map((edge) => edge.edgeId)).toEqual([edges[0]]);
    keptEverything(before, after);
  });
});

describe("a node left blocking two things", () => {
  /** Two peers move the same node to two different parents. */
  function forked(): { merged: LoroCanvasDoc; edges: string[] } {
    const peers = twoPeers();
    const wa = treeWriterForDoc(peers.a, { commit: () => peers.a.commit(), random: seededRandom(41) });
    const wb = treeWriterForDoc(peers.b, { commit: () => peers.b.commit(), random: seededRandom(83) });
    const ra = wa.reparent({ nodeId: "shape:schema", newParentId: "shape:goal" });
    const rb = wb.reparent({ nodeId: "shape:schema", newParentId: "shape:ui" });
    if (!ra.ok || !rb.ok) return expect.unreachable("a peer was refused a legal reparent");
    return {
      merged: peers.merge(),
      edges: [ra.value.edgeId as string, rb.value.edgeId as string].sort(),
    };
  }

  it("the merge leaves the node blocking both parents", () => {
    expect(kinds(problemsOf(dumpModel(forked().merged)))).toContain("multiple-parents");
  });

  it("repair keeps one parent deterministically and quarantines the other edge", () => {
    const { merged, edges } = forked();
    const before = dumpModel(merged);
    const report = applyTreeRepair(targetFor(merged), TREE);
    expect(report.applied.map((op) => op.edgeId)).toEqual(edges.slice(1));
    expect(report.applied[0]?.reason).toBe("multiple-parents");
    const after = dumpModel(merged);
    expect(problemsOf(after)).toEqual([]);
    keptEverything(before, after);
  });
});

describe("orphaned and half-bound edges", () => {
  it("quarantines an edge naming a node that is not in the tree", () => {
    const doc = docOf(EXAMPLE);
    // The concurrent shape: one peer takes a node out of the tree while
    // another draws an edge to it. What is left names an id the tree has not
    // got — W1 calls it dangling and keeps it out of the graph.
    const live = liveDoc(
      makeDocument({
        pages: doc.pages,
        shapes: doc.shapes.filter((shape) => shape.id !== "shape:schema"),
        bindings: doc.bindings as readonly Binding[],
      }),
    );
    const before = dumpModel(live);
    expect(kinds(problemsOf(before))).toContain("dangling-edge");
    const report = applyTreeRepair(targetFor(live), TREE);
    expect(report.applied[0]?.reason).toBe("dangling-edge");
    const after = dumpModel(live);
    expect(problemsOf(after)).toEqual([]);
    keptEverything(before, after);
  });

  it("quarantines an arrow that lost one of its two bindings", () => {
    const doc = docOf(EXAMPLE);
    const gone = edgeBindingId("shape:edge-0", BLOCKED_TERMINAL);
    const live = liveDoc(
      makeDocument({
        pages: doc.pages,
        shapes: doc.shapes,
        bindings: (doc.bindings as readonly Binding[]).filter((binding) => binding.id !== gone),
      }),
    );
    const before = dumpModel(live);
    expect(kinds(problemsOf(before))).toContain("invalid-edge");
    const report = applyTreeRepair(targetFor(live), TREE);
    expect(report.applied.map((op) => op.edgeId)).toEqual(["shape:edge-0"]);
    expect(report.applied[0]?.reason).toBe("invalid-edge");
    expect(problemsOf(dumpModel(live))).toEqual([]);
    keptEverything(before, dumpModel(live));
  });

  it("quarantines an arrow whose terminal is bound twice", () => {
    const doc = docOf(EXAMPLE);
    const extra = {
      id: "binding:shape:edge-0-start-rival",
      fromId: "shape:edge-0",
      toId: "shape:ui",
      props: { terminal: BLOCKER_TERMINAL, anchor: { nx: 0.5, ny: 0.5 } },
      meta: {},
    } as Binding;
    const live = liveDoc(
      makeDocument({
        pages: doc.pages,
        shapes: doc.shapes,
        bindings: [...(doc.bindings as readonly Binding[]), extra],
      }),
    );
    const before = dumpModel(live);
    const report = applyTreeRepair(targetFor(live), TREE);
    expect(report.applied.map((op) => op.edgeId)).toEqual(["shape:edge-0"]);
    // BOTH binding rows survive. Deleting the "extra" one would be exactly the
    // silent drop this node exists to refuse: nothing in the document says
    // which of the two a human meant.
    keptEverything(before, dumpModel(live));
    expect(problemsOf(dumpModel(live))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What repair REFUSES to touch
// ---------------------------------------------------------------------------

describe("damage repair will not touch", () => {
  const brokenNode = (): CanvasDocument => {
    const doc = docOf(EXAMPLE);
    const bad = {
      ...(doc.byId.get("shape:ui") as Shape),
      meta: { ...(doc.byId.get("shape:ui") as Shape).meta, state: "banana" },
    } as Shape;
    return makeDocument({
      pages: doc.pages,
      shapes: doc.shapes.map((shape) => (shape.id === "shape:ui" ? bad : shape)),
      bindings: doc.bindings as readonly Binding[],
    });
  };

  it("leaves a malformed NODE alone and reports it — a node is a human's writing", () => {
    const live = liveDoc(brokenNode());
    const before = dumpModel(live);
    const report = applyTreeRepair(targetFor(live), TREE);
    expect(report.applied).toEqual([]);
    expect(report.unrepaired.map((entry) => entry.problem.kind)).toContain("invalid-node");
    expect(report.unrepaired[0]?.why).toBeTruthy();
    keptEverything(before, dumpModel(live));
  });

  it("leaves the malformed node's OWN edges alone — the node is broken, not gone", () => {
    // `shape:ui` still sits on the page; it just does not read. The edges
    // naming it therefore dangle, and quarantining them would take away a
    // relationship because of a defect somewhere else — fixing the node makes
    // them good again on their own.
    const report = applyTreeRepair(targetFor(liveDoc(brokenNode())), TREE);
    expect(report.applied).toEqual([]);
    const dangling = report.unrepaired.filter((entry) => entry.problem.kind === "dangling-edge");
    expect(dangling.length).toBeGreaterThan(0);
    expect(dangling[0]?.why).toContain("still on the page");
  });

  it("bounds the explanation it stamps on the shape, and says it did", () => {
    // The stored reason rides every sync delta to every connected client, so
    // it is capped for the same reason `meta.context` is. The full sentence
    // lives in the report an operator reads.
    const doc = docOf(EXAMPLE);
    const stamped = quarantineTreeShape(doc.byId.get("shape:edge-0") as Shape, {
      reason: "cycle",
      detail: "x".repeat(MAX_QUARANTINE_DETAIL * 3),
    });
    if (stamped.status !== "ok") return expect.unreachable("a tree-marked edge refused quarantine");
    const record = readTreeQuarantine(stamped.value);
    if (record.status !== "ok") return expect.unreachable("the record did not read back");
    expect(record.value.detail.length).toBe(MAX_QUARANTINE_DETAIL);
    expect(record.value.detail.endsWith("…")).toBe(true);
  });

  it("names every kind it can repair, and nothing else", () => {
    expect([...REPAIRABLE_KINDS].sort()).toEqual([
      "cycle",
      "dangling-edge",
      "duplicate-edge",
      "invalid-edge",
      "multiple-parents",
    ]);
  });
});

// ---------------------------------------------------------------------------
// A repair that did not land is not a repair
// ---------------------------------------------------------------------------

describe("what the document refused", () => {
  const CYCLE: Spec = {
    nodes: { "shape:a": "todo", "shape:b": "todo" },
    edges: [
      ["shape:a", "shape:b"],
      ["shape:b", "shape:a"],
    ],
  };

  it("reports a quarantine the document did not take as REJECTED, never as applied", () => {
    // `putShape` rejects an invalid shape as a SILENT no-op, so a repairer
    // that trusted its own call would report a cycle fixed and leave it there.
    const live = liveDoc(docOf(CYCLE));
    const report = applyTreeRepair({ ...targetFor(live), putShape: () => {} }, TREE);
    expect(report.applied).toEqual([]);
    expect(report.rejected.length).toBe(1);
    expect(report.rejected[0]?.why).toContain("did not accept");
    // And the report still says the tree is broken, rather than claiming a
    // repair that is not in the document.
    expect(kinds(report.remaining)).toContain("cycle");
  });

  it("commits nothing when every planned edge went before it could be written", () => {
    const live = liveDoc(docOf(CYCLE));
    let commits = 0;
    const report = applyTreeRepair(
      {
        ...targetFor(live),
        getShape: () => undefined,
        putShape: () => expect.unreachable("wrote a shape it could not read"),
        commit: () => {
          commits += 1;
        },
      },
      TREE,
    );
    expect(report.applied).toEqual([]);
    expect(report.rejected[0]?.why).toContain("was gone");
    expect(commits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Getting the relationship back
// ---------------------------------------------------------------------------

describe("restoring a quarantined edge", () => {
  /** A tree with one duplicate edge, repaired — so exactly one edge is
   * quarantined and putting it back is legal again once the survivor goes. */
  function repaired(): { live: LoroCanvasDoc; quarantined: string; kept: string } {
    const doc = docOf({
      nodes: { "shape:goal": "todo", "shape:api": "todo" },
      edges: [
        ["shape:api", "shape:goal"],
        ["shape:api", "shape:goal"],
      ],
    });
    const live = liveDoc(doc);
    const report = applyTreeRepair(targetFor(live), TREE);
    return {
      live,
      quarantined: report.applied[0]?.edgeId as string,
      kept: readTree(dumpModel(live), TREE).edges[0]?.edgeId as string,
    };
  }

  it("lists quarantined edges ascending, whatever order the document holds them in", () => {
    // The listing is the recovery surface: two peers reading "what was taken
    // out" must read the same list in the same order, and `doc.shapes` order
    // is not a promise anyone made.
    const doc = docOf({
      nodes: { "shape:goal": "todo", "shape:api": "todo" },
      edges: [
        ["shape:api", "shape:goal"],
        ["shape:api", "shape:goal"],
        ["shape:api", "shape:goal"],
      ],
    });
    const live = liveDoc(doc);
    const report = applyTreeRepair(targetFor(live), TREE);
    expect(report.applied.length).toBe(2);
    const after = dumpModel(live);
    const reorder = (shapes: readonly Shape[]): CanvasDocument =>
      makeDocument({
        pages: after.pages,
        shapes,
        bindings: after.bindings as readonly Binding[],
      });
    // BOTH orders, because which one `dumpModel` happens to produce is a Loro
    // traversal detail and asserting on only one would pass either way.
    for (const shapes of [after.shapes, [...after.shapes].reverse()]) {
      expect(listQuarantinedEdges(reorder(shapes), TREE).map((entry) => entry.edgeId)).toEqual([
        "shape:edge-1",
        "shape:edge-2",
      ]);
    }
  });

  it("lists what it quarantined, with the reason", () => {
    const { live, quarantined } = repaired();
    const listed = listQuarantinedEdges(dumpModel(live), TREE);
    expect(listed.map((entry) => entry.edgeId)).toEqual([quarantined]);
    expect(listed[0]?.quarantine.reason).toBe("duplicate-edge");
  });

  it("refuses a restore that would immediately re-break the tree, naming why", () => {
    const { live, quarantined } = repaired();
    const before = dumpModel(live);
    const result = restoreQuarantinedEdge(targetFor(live), quarantined);
    if (result.ok) return expect.unreachable("restoring a duplicate was accepted");
    expect(result.detail).toContain("duplicate-edge");
    keptEverything(before, dumpModel(live));
    // Refused means UNCHANGED: still quarantined, not half-restored.
    expect(listQuarantinedEdges(dumpModel(live), TREE).map((e) => e.edgeId)).toEqual([quarantined]);
  });

  it("names the RIVAL EDGE a human would have to remove, not just the nodes", () => {
    // A cycle's `subjects` are its NODES, so the refusal that came out of the
    // first version named three notes and told the human to "remove the rival
    // edge" — which edge, it did not say. The duplicate case hid this: there
    // the subjects happen to BE edge ids.
    const live = liveDoc(
      docOf({
        nodes: { "shape:a": "todo", "shape:b": "todo", "shape:c": "todo" },
        edges: [
          ["shape:a", "shape:b"],
          ["shape:b", "shape:c"],
          ["shape:c", "shape:a"],
        ],
      }),
    );
    const report = applyTreeRepair(targetFor(live), TREE);
    const quarantined = report.applied[0]?.edgeId as string;
    const rivals = readTree(dumpModel(live), TREE)
      .edges.map((edge) => edge.edgeId)
      .filter((id) => id !== quarantined);
    expect(rivals.length).toBeGreaterThan(0);

    const result = restoreQuarantinedEdge(targetFor(live), quarantined);
    if (result.ok) return expect.unreachable("restoring into a live cycle was accepted");
    expect(result.detail).toContain("cycle");
    for (const rival of rivals) expect(result.detail).toContain(rival);
  });

  it("restores the edge once the reason is gone", () => {
    const { live, quarantined, kept } = repaired();
    // A human deletes the surviving duplicate; the quarantined one is now the
    // only claim to the relationship, and it goes straight back.
    live.deleteBinding(edgeBindingId(kept, BLOCKER_TERMINAL));
    live.deleteBinding(edgeBindingId(kept, BLOCKED_TERMINAL));
    live.deleteShape(kept);
    live.commit();

    const result = restoreQuarantinedEdge(targetFor(live), quarantined);
    if (!result.ok) return expect.unreachable(`restore was refused: ${result.detail}`);
    const after = dumpModel(live);
    const arrow = after.byId.get(quarantined) as Shape;
    expect(arrow.meta[TREE_KEY]).toBe(TREE);
    expect(arrow.meta[TREE_QUARANTINE_KEY]).toBeUndefined();
    expect(readTree(after, TREE).edges.map((edge) => edge.edgeId)).toEqual([quarantined]);
    expect(problemsOf(after)).toEqual([]);
  });

  it("refuses a shape that is not a quarantined edge, naming it", () => {
    const { live } = repaired();
    const missing = restoreQuarantinedEdge(targetFor(live), "shape:nope");
    if (missing.ok) return expect.unreachable("restored a shape that does not exist");
    expect(missing.detail).toContain("shape:nope");
    const plain = restoreQuarantinedEdge(targetFor(live), "shape:goal");
    if (plain.ok) return expect.unreachable("restored a shape that was never quarantined");
    expect(plain.detail).toContain("shape:goal");
  });
});

// ---------------------------------------------------------------------------
// Every tree in the document
// ---------------------------------------------------------------------------

describe("repairAllTrees", () => {
  /** `docOf` names its edges `shape:edge-<i>`, so two fixture documents in one
   * canvas would collide on id — and `makeDocument` would silently keep one.
   * Rename every id of the first tree before merging them. */
  const prefixed = (doc: CanvasDocument, prefix: string): CanvasDocument => {
    // Renamed INSIDE the `shape:` / `binding:` namespace, not in front of it —
    // canvas-model validates the prefix, and `putShape` would refuse the
    // repaired arrow, which is a silent no-op that reads as "repair did
    // nothing" (exactly how this helper's first version failed).
    const rename = (id: string): string =>
      id.startsWith("shape:") ? `shape:${prefix}${id.slice("shape:".length)}` : id;
    return makeDocument({
      pages: doc.pages,
      // `meta.nodeId` travels with the id: W0 rejects a node whose legibility
      // field disagrees with its own shape id.
      shapes: doc.shapes.map(
        (shape) =>
          ({
            ...shape,
            id: rename(shape.id),
            meta:
              typeof shape.meta.nodeId === "string"
                ? { ...shape.meta, nodeId: rename(shape.meta.nodeId) }
                : shape.meta,
          }) as Shape,
      ),
      bindings: (doc.bindings as readonly Binding[]).map(
        (binding) =>
          ({
            ...binding,
            id: `${prefix}${binding.id}`,
            fromId: rename(binding.fromId),
            toId: rename(binding.toId),
          }) as Binding,
      ),
    });
  };

  it("repairs each tree page independently and reports one entry per tree", () => {
    const first = prefixed(
      docOf({
        nodes: { "shape:a": "todo", "shape:b": "todo" },
        edges: [
          ["shape:a", "shape:b"],
          ["shape:b", "shape:a"],
        ],
        treeId: "page:one",
      }),
      "one-",
    );
    const second = docOf(EXAMPLE);
    const live = liveDoc(
      makeDocument({
        pages: [...first.pages, ...second.pages],
        shapes: [...first.shapes, ...second.shapes],
        bindings: [
          ...(first.bindings as readonly Binding[]),
          ...(second.bindings as readonly Binding[]),
        ],
      }),
    );
    const before = dumpModel(live);
    const reports = repairAllTrees(targetFor(live));
    expect(reports.map((report) => report.treeId)).toEqual(["page:one", TREE]);
    expect(reports[0]?.applied.length).toBe(1);
    expect(reports[1]?.applied).toEqual([]);
    keptEverything(before, dumpModel(live));
    expect(problemsOf(dumpModel(live), "page:one")).toEqual([]);
    // The listing is PER TREE. Two trees on one canvas each have their own
    // recovery list, and a human restoring an edge in one must not be shown
    // the other's.
    const all = listQuarantinedEdges(dumpModel(live));
    expect(all.length).toBe(1);
    expect(listQuarantinedEdges(dumpModel(live), "page:one")).toEqual(all);
    expect(listQuarantinedEdges(dumpModel(live), TREE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The room: repair runs on the merge, and is as durable as the merge
// ---------------------------------------------------------------------------

describe("the room reconciles what a frame merged", () => {
  function room(): { host: CanvasRoomHost; store: CanvasStore } {
    const db = new Database(":memory:");
    const store = new CanvasStore(db);
    for (const statement of CANVAS_MIGRATIONS) db.exec(statement);
    return { host: new CanvasRoomHost({ store, publish: () => {}, room: "main" }), store };
  }

  it("repairs a cycle a client's frame delivered, and logs the repair delta", () => {
    const { host, store } = room();
    loadModel(host.peer.doc, docOf(EXAMPLE));
    host.commitLocalWrite();

    // A client forked from the room, made a legal move, and sent its delta;
    // the room had already taken the opposite move from someone else.
    const client = LoroCanvasDoc.fromSnapshot(host.peer.doc.exportSnapshot(), { peerId: 4n });
    const clientWriter = treeWriterForDoc(client, {
      commit: () => client.commit(),
      random: seededRandom(11),
    });
    const roomWriter = treeWriterForDoc(host.peer.doc, {
      commit: () => host.commitLocalWrite(),
      random: seededRandom(97),
    });
    clientWriter.reparent({ nodeId: "shape:ui", newParentId: "shape:schema" });
    roomWriter.reparent({ nodeId: "shape:schema", newParentId: "shape:ui" });

    host.frame("c1", encode(Frame.Update, client.exportUpdate()), 1_000);

    expect(problemsOf(dumpModel(host.peer.doc))).toEqual([]);
    // Durable: a reload replays the log and comes back repaired, rather than
    // re-deriving the repair from a document nobody wrote down.
    const reloaded = new CanvasRoomHost({ store, publish: () => {}, room: "main" });
    expect(problemsOf(dumpModel(reloaded.peer.doc))).toEqual([]);
    expect(repairQuarantines(dumpModel(reloaded.peer.doc)).length).toBe(1);
  });

  it("repairs a merge whose repair delta never reached the log — the crash window", () => {
    // A repair delta can still be lost: `commitLocalWrite` now persists before
    // it lets anything out (C2 finding 2), but a crash mid-append leaves
    // clients holding nothing and the server holding a merge with no repair
    // beside it. This is
    // that log — the merge, and no repair — and the room must come back
    // repaired rather than serving a cyclic tree to the next reader. Repair
    // being a pure function of content is what makes that work: the restart
    // recomputes the same plan and reaches the same state the lost delta
    // described. See the W11 artifact's note on the asymmetry.
    const { host, store } = room();
    host.close();
    const peers = twoPeers();
    treeWriterForDoc(peers.a, { commit: () => peers.a.commit(), random: seededRandom(11) }).reparent(
      { nodeId: "shape:ui", newParentId: "shape:schema" },
    );
    treeWriterForDoc(peers.b, { commit: () => peers.b.commit(), random: seededRandom(97) }).reparent(
      { nodeId: "shape:schema", newParentId: "shape:ui" },
    );
    const merged = peers.merge();
    expect(kinds(problemsOf(dumpModel(merged)))).toContain("cycle");
    store.appendUpdate("main", merged.exportUpdate());

    const restarted = new CanvasRoomHost({ store, publish: () => {}, room: "main" });
    expect(problemsOf(dumpModel(restarted.peer.doc))).toEqual([]);
    expect(repairQuarantines(dumpModel(restarted.peer.doc)).length).toBe(1);
  });

  it("does not run a repair pass for a frame that changed nothing", () => {
    const { host } = room();
    loadModel(host.peer.doc, docOf(EXAMPLE));
    host.commitLocalWrite();
    // A frame that DOES apply something, so the gate is shown to let real work
    // through before it is shown to hold anything back.
    const client = LoroCanvasDoc.fromSnapshot(host.peer.doc.exportSnapshot(), { peerId: 5n });
    treeWriterForDoc(client, { commit: () => client.commit(), random: seededRandom(2) }).setState({
      nodeId: "shape:ui",
      state: "done",
    });
    const real = encode(Frame.Update, client.exportUpdate());
    const before = host.repairPasses;
    host.frame("c1", real, 1_000);
    expect(host.repairPasses).toBe(before + 1);
    // The SAME bytes again: the import applies nothing, so there is nothing to
    // reconcile and a full document read would be pure cost on the hot path
    // every pointer move rides.
    host.frame("c1", real, 1_100);
    expect(host.repairPasses).toBe(before + 1);
    // And a presence frame, which never touches the document at all.
    host.frame("c1", encode(Frame.Presence, new Uint8Array([1, 2, 3])), 1_200);
    expect(host.repairPasses).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

describe("the repair target", () => {
  it("is a strict subset of the write target — no delete of any kind", () => {
    // A compile-time fact made a runtime one: the object below is a whole
    // TreeRepairTarget, and it is built from a TreeWriteTarget's read/put
    // half only. If a delete ever appears on TreeRepairTarget this stops
    // type-checking, which is the point.
    const write: TreeWriteTarget = {
      document: () => docOf(EXAMPLE),
      getShape: () => undefined,
      putShape: () => {},
      updateProps: () => {},
      text: () => "",
      setText: () => {},
      putBinding: () => {},
    putPage: () => {},
      commit: () => {},
      random: () => 0.5,
    };
    const repair: TreeRepairTarget = write;
    expect(Object.keys(repair as object)).toContain("putShape");
  });
});
