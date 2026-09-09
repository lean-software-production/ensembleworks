// Run: npx vitest run tests/tree-write-tools.test.ts
//
// W10's gate. The first node in this feature that MUTATES the canvas document,
// so these tests are aimed at the two ways a write path goes wrong:
//
//  1. A REFUSAL IS A FEATURE. A write that would create a cycle, orphan an
//     edge, duplicate a relationship or overflow the encoding's own caps is
//     REFUSED, naming the offending ids — never quietly adjusted into
//     something legal. Every refusal test therefore asserts two things: the
//     message names the subjects, and THE DOCUMENT DID NOT CHANGE.
//  2. A WRITE LEAVES A DOCUMENT THE READ SPINE READS BACK CLEANLY. After every
//     legal write the test re-reads the whole tree through W1's `readTree` +
//     `checkTreeInvariants` and asserts NO NEW PROBLEM appeared. A write that
//     produces a document W1 calls invalid is a bug here, not in W1.
//
// The writes run against a REAL `LoroCanvasDoc`, not a fake: the whole risk of
// this node is what Loro stores and what `dumpModel` reads back out of it (a
// meta write that survives, a binding row that does not), and a hand-rolled
// fake would agree with whatever the implementation happened to do.
//
// DIRECTION IS ASSERTED EXPLICITLY, at the binding level, in
// "the edge direction". W0 says an edge means "<blocker> BLOCKS <blocked>" with
// the blocker on the START terminal; inverting it is the classic failure with
// this model and it would still read as a tree — upside down.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { LoroCanvasDoc, dumpModel, loadModel } from "@ensembleworks/canvas-doc";
import { plainText, type CanvasDocument } from "@ensembleworks/canvas-model";
import type { PluginAgentToolContext } from "@get-bb/plugin-sdk";
import {
  BLOCKED_TERMINAL,
  BLOCKER_TERMINAL,
  MAX_CONTEXT_LENGTH,
  buildTreeEdge,
  buildTreeNode,
  edgeBindingId,
} from "../canvas/tree/encoding.js";
import { checkTreeInvariants, readTree, type TreeProblem } from "../canvas/tree/model.js";
import { createTreeService } from "../canvas/tree/service.js";
import { treeServiceForDoc, treeWriterForDoc } from "../canvas/tree/doc-source.js";
import {
  MAX_TITLE_LENGTH,
  createTreeWriter,
  type TreeWriteTarget,
  type TreeWriter,
} from "../canvas/tree/writes.js";
import {
  TREE_WRITE_TOOL_NAMES,
  createTreeWriteTools,
  type TreeWriteToolDeps,
} from "../canvas/tree/write-tools.js";
import {
  TREE_READ_TOOL_NAMES,
  TREE_TOOL_NAMES,
  registerTreeAgentTools,
  selectTreeTools,
  type TreeToolDeps,
} from "../canvas/tree/agent-tools.js";
import { CanvasRoomHost } from "../canvas/room.js";
import { CANVAS_MIGRATIONS, CanvasStore } from "../canvas/store.js";
import { EXAMPLE, TREE, docOf, withTitle, type Spec } from "./lib/tree-fixture.js";

const THREAD = "thr_linked";

// ---------------------------------------------------------------------------
// A live document, and the two things every test asks of it
// ---------------------------------------------------------------------------

/** The fixture spec, loaded into a REAL Loro document. */
function liveDoc(spec: Spec = EXAMPLE): LoroCanvasDoc {
  const doc = LoroCanvasDoc.create({ peerId: 7n });
  loadModel(doc, docOf(spec));
  doc.commit();
  return doc;
}

/** A seeded id stream, so a test can name the node a write is about to mint. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface Rig {
  readonly doc: LoroCanvasDoc;
  readonly writer: TreeWriter;
  /** Every problem W1 can see, structural and graph, for one tree. */
  problems(treeId?: string): readonly TreeProblem[];
  document(): CanvasDocument;
  /** A stable fingerprint of the whole document, for "nothing changed". */
  fingerprint(): string;
}

function rig(spec: Spec = EXAMPLE, seed = 1): Rig {
  const doc = liveDoc(spec);
  const writer = treeWriterForDoc(doc, { random: seededRandom(seed) });
  const document = (): CanvasDocument => dumpModel(doc);
  return {
    doc,
    writer,
    document,
    problems(treeId = TREE) {
      const tree = readTree(document(), treeId);
      return [...tree.problems, ...checkTreeInvariants(tree)];
    },
    fingerprint() {
      const model = document();
      return JSON.stringify({
        shapes: model.shapes
          .map((shape) => ({ id: shape.id, meta: shape.meta, props: shape.props }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
        bindings: model.bindings
          .map((binding) => ({ id: binding.id, fromId: binding.fromId, toId: binding.toId }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      });
    },
  };
}

/** The edges of a tree as `blocker>blocked` strings, sorted. */
function edgesOf(rigged: Rig, treeId = TREE): string[] {
  return readTree(rigged.document(), treeId)
    .edges.map((edge) => `${edge.blockerId}>${edge.blockedId}`)
    .sort();
}

const viewOf = (rigged: Rig, nodeId: string) => {
  const found = createTreeService({ document: rigged.document }).node(nodeId);
  if (!found.ok) return expect.unreachable(`no node ${nodeId}: ${found.detail}`);
  return found.value;
};

// ---------------------------------------------------------------------------
// addChild
// ---------------------------------------------------------------------------

describe("addChild", () => {
  it("creates a node that BLOCKS the parent, and the read spine reads it back", () => {
    const r = rig();
    const done = r.writer.addChild({ parentId: "shape:goal", title: "Write the write path" });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const child = viewOf(r, done.value.focusId === "shape:goal" ? done.value.createdId! : done.value.focusId);
    expect(child.title).toBe("Write the write path");
    expect(child.treeId).toBe(TREE);
    expect(viewOf(r, "shape:goal").childIds).toContain(child.id);
  });

  it("leaves the document with no new problem", () => {
    const r = rig();
    const before = r.problems().length;
    expect(r.writer.addChild({ parentId: "shape:api", title: "New blocker" }).ok).toBe(true);
    expect(r.problems()).toHaveLength(before);
  });

  it("defaults a fresh node to todo, un-approached, contextless and ready", () => {
    const r = rig();
    const done = r.writer.addChild({ parentId: "shape:goal", title: "Fresh" });
    if (!done.ok) return expect.unreachable(done.detail);
    const child = viewOf(r, done.value.createdId as string);
    expect(child.state).toBe("todo");
    expect(child.approached).toBe(false);
    expect(child.context).toBe("");
    // Nothing beneath it, so W1's one readiness rule says startable.
    expect(child.isReady).toBe(true);
  });

  it("mints a distinct node per call, so two children coexist", () => {
    const r = rig();
    const a = r.writer.addChild({ parentId: "shape:goal", title: "A" });
    const b = r.writer.addChild({ parentId: "shape:goal", title: "B" });
    if (!a.ok || !b.ok) return expect.unreachable("both writes should be accepted");
    expect(a.value.createdId).not.toBe(b.value.createdId);
    expect(viewOf(r, "shape:goal").childIds).toContain(a.value.createdId as string);
    expect(viewOf(r, "shape:goal").childIds).toContain(b.value.createdId as string);
  });

  // M12's regression: a minted id that hits an existing shape would UPSERT it.
  // Overwriting a human's node is the worst thing this module could do, so the
  // mint skips a taken id — and this test is what makes that observable, by
  // seeding the SAME stream the writer draws from and planting the first id.
  it("never mints an id a shape already holds, so no write can overwrite a node", () => {
    const r = rig(EXAMPLE, 11);
    const wouldMint = `shape:${Math.floor(seededRandom(11)() * 1e9).toString(36)}`;
    r.doc.putShape(
      withTitle(
        buildTreeNode({
          id: wouldMint,
          treeId: TREE,
          parentId: TREE,
          index: "y1",
          x: 0,
          y: 900,
        }),
        "A human wrote this",
      ) as never,
    );
    r.doc.commit();
    const done = r.writer.addChild({ parentId: "shape:goal", title: "Minted" });
    if (!done.ok) return expect.unreachable(done.detail);
    expect(done.value.createdId).not.toBe(wouldMint);
    expect(viewOf(r, wouldMint).title).toBe("A human wrote this");
  });

  // The z-order string canvas-model lets a shape carry is any non-empty
  // string, and A1's generator THROWS on one it cannot read. A node like that
  // must not turn an addChild into an exception — see nextIndex.
  it("still writes when a node on the page carries an unreadable z-order index", () => {
    const r = rig();
    r.doc.putShape(
      buildTreeNode({
        id: "shape:oddindex",
        treeId: TREE,
        parentId: TREE,
        index: "y1",
        x: 0,
        y: 900,
      }) as never,
    );
    r.doc.commit();
    expect(() => r.writer.addChild({ parentId: "shape:goal", title: "Beside it" })).not.toThrow();
    expect(r.writer.addChild({ parentId: "shape:goal", title: "And again" }).ok).toBe(true);
  });

  // A node may sit inside a frame, and the child of a framed node belongs in
  // the same frame: a child that landed on the bare page would look like a move
  // out of the frame that the agent never mentioned.
  it("puts the new node in the same container as its parent, frame and all", () => {
    const r = rig();
    r.doc.putShape({
      id: "shape:frame",
      kind: "frame",
      parentId: TREE,
      index: "a9",
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: { w: 900, h: 900 },
    } as never);
    r.doc.putShape(
      buildTreeNode({
        id: "shape:framed",
        treeId: TREE,
        parentId: "shape:frame",
        index: "b1",
        x: 10,
        y: 10,
      }) as never,
    );
    r.doc.reparent("shape:framed", "shape:frame");
    r.doc.commit();
    const done = r.writer.addChild({ parentId: "shape:framed", title: "Inside" });
    if (!done.ok) return expect.unreachable(done.detail);
    expect(r.doc.getShape(done.value.createdId as string)?.parentId).toBe("shape:frame");
    // …and the edge with it, so the arrow is not drawn in a different container
    // from the two notes it binds.
    expect(r.doc.getShape(done.value.edgeId as string)?.parentId).toBe("shape:frame");
  });

  it("carries an initial state and context when asked", () => {
    const r = rig();
    const done = r.writer.addChild({
      parentId: "shape:goal",
      title: "With context",
      state: "wip",
      context: "## Goal\nProve the write path.",
    });
    if (!done.ok) return expect.unreachable(done.detail);
    const child = viewOf(r, done.value.createdId as string);
    expect(child.state).toBe("wip");
    expect(child.context).toContain("Prove the write path.");
  });

  it("refuses an unknown parent, naming it, and writes nothing", () => {
    const r = rig();
    const before = r.fingerprint();
    const done = r.writer.addChild({ parentId: "shape:nope", title: "Orphan" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.detail).toContain("shape:nope");
    expect(r.fingerprint()).toBe(before);
  });

  it("refuses a parent that is not a tree node, and writes nothing", () => {
    const r = rig();
    // A plain note on the page, tree-marked by nobody.
    r.doc.putShape({
      id: "shape:plain",
      kind: "note",
      parentId: TREE,
      index: "z1",
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {},
    } as never);
    r.doc.commit();
    const before = r.fingerprint();
    const done = r.writer.addChild({ parentId: "shape:plain", title: "Nope" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.detail).toContain("shape:plain");
    expect(r.fingerprint()).toBe(before);
  });

  // M10's regression: with the `meta.tree` guard removed, this still refused —
  // but with "is not a node of undefined", a sentence that tells an agent
  // nothing and sends a human looking for a tree called undefined.
  it("says a non-tree shape is not part of a tree, not that a tree is undefined", () => {
    const r = rig();
    r.doc.putShape({
      id: "shape:plain2",
      kind: "note",
      parentId: TREE,
      index: "z2",
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {},
    } as never);
    r.doc.commit();
    const done = r.writer.rename({ nodeId: "shape:plain2", title: "x" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.reason).toBe("not-a-tree-node");
    expect(done.detail).toContain("shape:plain2 is not part of a tree");
    expect(done.detail).not.toContain("undefined");
  });

  it("refuses a context over the encoding's cap, naming the limit, and writes nothing", () => {
    const r = rig();
    const before = r.fingerprint();
    const done = r.writer.addChild({
      parentId: "shape:goal",
      title: "Too much",
      context: "x".repeat(MAX_CONTEXT_LENGTH + 1),
    });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.detail).toContain(String(MAX_CONTEXT_LENGTH));
    expect(r.fingerprint()).toBe(before);
  });

  it("refuses a title over the write cap, and writes nothing", () => {
    const r = rig();
    const before = r.fingerprint();
    const done = r.writer.addChild({
      parentId: "shape:goal",
      title: "t".repeat(MAX_TITLE_LENGTH + 1),
    });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.detail).toContain(String(MAX_TITLE_LENGTH));
    expect(r.fingerprint()).toBe(before);
  });

  it("refuses a blank title, because a nameless node is unreadable to everyone", () => {
    const r = rig();
    const before = r.fingerprint();
    expect(r.writer.addChild({ parentId: "shape:goal", title: "   " }).ok).toBe(false);
    expect(r.fingerprint()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The edge direction — W0's contract, at the binding level
// ---------------------------------------------------------------------------

describe("the edge direction", () => {
  it("binds the NEW node to the start terminal and the parent to the end", () => {
    const r = rig();
    const done = r.writer.addChild({ parentId: "shape:goal", title: "Blocker" });
    if (!done.ok) return expect.unreachable(done.detail);
    const childId = done.value.createdId as string;
    const edgeId = done.value.edgeId as string;
    const bindings = r.doc.listBindings();
    const start = bindings.find((b) => b.id === edgeBindingId(edgeId, BLOCKER_TERMINAL));
    const end = bindings.find((b) => b.id === edgeBindingId(edgeId, BLOCKED_TERMINAL));
    expect(start?.toId).toBe(childId);
    expect(end?.toId).toBe("shape:goal");
  });

  it("reads back as 'the child blocks the parent', not the other way round", () => {
    const r = rig();
    const done = r.writer.addChild({ parentId: "shape:goal", title: "Blocker" });
    if (!done.ok) return expect.unreachable(done.detail);
    const childId = done.value.createdId as string;
    expect(edgesOf(r)).toContain(`${childId}>shape:goal`);
    expect(edgesOf(r)).not.toContain(`shape:goal>${childId}`);
    // And the domain reading of it: the child is a blocker OF the goal.
    expect(viewOf(r, childId).parentIds).toEqual(["shape:goal"]);
    expect(viewOf(r, childId).isRoot).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

describe("rename", () => {
  it("changes the title the read spine reads, with no new problem", () => {
    const r = rig();
    const before = r.problems().length;
    expect(r.writer.rename({ nodeId: "shape:api", title: "Tree service (server)" }).ok).toBe(true);
    expect(viewOf(r, "shape:api").title).toBe("Tree service (server)");
    expect(r.problems()).toHaveLength(before);
  });

  it("touches nothing else about the node", () => {
    const r = rig();
    const was = viewOf(r, "shape:api");
    expect(r.writer.rename({ nodeId: "shape:api", title: "Renamed" }).ok).toBe(true);
    const now = viewOf(r, "shape:api");
    expect(now.state).toBe(was.state);
    expect(now.context).toBe(was.context);
    expect(now.childIds).toEqual(was.childIds);
    expect(now.parentIds).toEqual(was.parentIds);
  });

  it("refuses a blank title, and writes nothing", () => {
    const r = rig();
    const before = r.fingerprint();
    const done = r.writer.rename({ nodeId: "shape:api", title: "" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.detail).toContain("shape:api");
    expect(r.fingerprint()).toBe(before);
  });

  it("refuses an unknown node, naming it", () => {
    const r = rig();
    const done = r.writer.rename({ nodeId: "shape:ghost", title: "Anything" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.detail).toContain("shape:ghost");
  });
});

// ---------------------------------------------------------------------------
// reparent — the one write that can break a tree
// ---------------------------------------------------------------------------

describe("reparent", () => {
  it("moves a node under a new parent, replacing its old edge", () => {
    const r = rig();
    const done = r.writer.reparent({ nodeId: "shape:schema", newParentId: "shape:ui" });
    expect(done.ok).toBe(true);
    expect(edgesOf(r)).toContain("shape:schema>shape:ui");
    expect(edgesOf(r)).not.toContain("shape:schema>shape:api");
    expect(r.problems()).toEqual([]);
  });

  it("takes the moved node's own blockers with it", () => {
    const r = rig();
    // schema gains a blocker, then moves: the blocker must still be beneath it.
    const added = r.writer.addChild({ parentId: "shape:schema", title: "Deeper" });
    if (!added.ok) return expect.unreachable(added.detail);
    expect(r.writer.reparent({ nodeId: "shape:schema", newParentId: "shape:ui" }).ok).toBe(true);
    expect(viewOf(r, "shape:schema").childIds).toContain(added.value.createdId as string);
  });

  it("deletes the old edge's BINDING rows, not just its arrow", () => {
    const r = rig();
    const oldEdge = readTree(r.document(), TREE).edges.find(
      (edge) => edge.blockerId === "shape:schema",
    );
    expect(oldEdge).toBeDefined();
    expect(r.writer.reparent({ nodeId: "shape:schema", newParentId: "shape:ui" }).ok).toBe(true);
    const leftovers = r.doc
      .listBindings()
      .filter((binding) => binding.fromId === (oldEdge as { edgeId: string }).edgeId);
    expect(leftovers).toEqual([]);
    // And the arrow shape itself is gone, so nothing reads as a half-edge.
    expect(r.doc.getShape((oldEdge as { edgeId: string }).edgeId)).toBeUndefined();
  });

  it("REFUSES a cycle, naming both ends, and writes nothing", () => {
    const r = rig();
    const before = r.fingerprint();
    // goal is above schema; putting goal under schema closes the loop.
    const done = r.writer.reparent({ nodeId: "shape:goal", newParentId: "shape:schema" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.reason).toBe("would-cycle");
    expect(done.detail).toContain("shape:goal");
    expect(done.detail).toContain("shape:schema");
    expect(r.fingerprint()).toBe(before);
  });

  it("refuses to make a node its own parent", () => {
    const r = rig();
    const before = r.fingerprint();
    const done = r.writer.reparent({ nodeId: "shape:api", newParentId: "shape:api" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.detail).toContain("shape:api");
    expect(r.fingerprint()).toBe(before);
  });

  it("refuses a parent in a different tree, naming both trees", () => {
    const r = rig({
      ...EXAMPLE,
      extraPages: [{ id: "page:other", name: "Other" }],
    });
    // A node on the other page, in its own tree.
    const other = docOf({ nodes: { "shape:other": "todo" }, edges: [], treeId: "page:other" });
    for (const shape of other.shapes) r.doc.putShape(shape);
    r.doc.putPage({ id: "page:other", name: "Other", tree: { v: 1 } } as never);
    r.doc.commit();
    const before = r.fingerprint();
    const done = r.writer.reparent({ nodeId: "shape:api", newParentId: "shape:other" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.detail).toContain("page:other");
    expect(r.fingerprint()).toBe(before);
  });

  it("refuses a relationship that already exists, rather than duplicating the edge", () => {
    const r = rig();
    const before = r.fingerprint();
    const done = r.writer.reparent({ nodeId: "shape:schema", newParentId: "shape:api" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.reason).toBe("already-blocks");
    expect(r.fingerprint()).toBe(before);
    expect(r.problems().filter((p) => p.kind === "duplicate-edge")).toEqual([]);
  });

  it("replaces EVERY existing parent edge and says which it removed", () => {
    // A node blocking two things is a multiple-parents violation; reparenting
    // it must leave exactly one edge, and name the rows it took away.
    const r = rig({
      nodes: {
        "shape:goal": "todo",
        "shape:api": "todo",
        "shape:ui": "todo",
        "shape:schema": "todo",
      },
      edges: [
        ["shape:api", "shape:goal"],
        ["shape:schema", "shape:api"],
        ["shape:schema", "shape:ui"],
      ],
    });
    expect(r.problems().some((p) => p.kind === "multiple-parents")).toBe(true);
    // shape:goal, because schema already blocks BOTH api and ui — a target it
    // already blocks is refused as a duplicate, which is a different test.
    const done = r.writer.reparent({ nodeId: "shape:schema", newParentId: "shape:goal" });
    if (!done.ok) return expect.unreachable(done.detail);
    expect(done.value.removedEdgeIds).toHaveLength(2);
    expect(viewOf(r, "shape:schema").parentIds).toEqual(["shape:goal"]);
    expect(r.problems().some((p) => p.kind === "multiple-parents")).toBe(false);
  });

  it("refuses when the tree above the target is ALREADY cyclic — W11's ground, not this node's", () => {
    const r = rig({
      nodes: { "shape:a": "todo", "shape:b": "todo", "shape:c": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:a"],
      ],
    });
    const before = r.fingerprint();
    const done = r.writer.reparent({ nodeId: "shape:c", newParentId: "shape:a" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.reason).toBe("broken-tree");
    expect(r.fingerprint()).toBe(before);
  });

  it("refuses an unknown node and an unknown parent alike", () => {
    const r = rig();
    expect(r.writer.reparent({ nodeId: "shape:ghost", newParentId: "shape:goal" }).ok).toBe(false);
    expect(r.writer.reparent({ nodeId: "shape:api", newParentId: "shape:ghost" }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setState
// ---------------------------------------------------------------------------

describe("setState", () => {
  it("sets the state the read spine reads, with no new problem", () => {
    const r = rig();
    const before = r.problems().length;
    expect(r.writer.setState({ nodeId: "shape:schema", state: "done" }).ok).toBe(true);
    expect(viewOf(r, "shape:schema").state).toBe("done");
    expect(r.problems()).toHaveLength(before);
  });

  it("moves the frontier, because readiness has exactly one definition", () => {
    const r = rig();
    // api is blocked by schema, so it is not ready until schema is done.
    expect(viewOf(r, "shape:api").isReady).toBe(false);
    expect(r.writer.setState({ nodeId: "shape:schema", state: "done" }).ok).toBe(true);
    expect(viewOf(r, "shape:api").isReady).toBe(true);
  });

  it("preserves the node's title, context and edges", () => {
    const r = rig();
    const was = viewOf(r, "shape:api");
    expect(r.writer.setState({ nodeId: "shape:api", state: "done" }).ok).toBe(true);
    const now = viewOf(r, "shape:api");
    expect(now.title).toBe(was.title);
    expect(now.context).toBe(was.context);
    expect(now.childIds).toEqual(was.childIds);
    expect(now.parentIds).toEqual(was.parentIds);
  });

  it("refuses an unknown node, naming it", () => {
    const r = rig();
    const done = r.writer.setState({ nodeId: "shape:ghost", state: "done" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.detail).toContain("shape:ghost");
  });
});

// ---------------------------------------------------------------------------
// writeContext
// ---------------------------------------------------------------------------

describe("writeContext", () => {
  it("writes the note the digest never carries, and the read spine reads it back", () => {
    const r = rig();
    expect(
      r.writer.writeContext({ nodeId: "shape:api", context: "## Done when\nEvery query answered." })
        .ok,
    ).toBe(true);
    expect(viewOf(r, "shape:api").context).toContain("Every query answered.");
    expect(r.problems()).toEqual([]);
  });

  it("says how much writing it replaced, because the write is destructive", () => {
    const r = rig({ ...EXAMPLE, context: { "shape:api": "the old note" } });
    const done = r.writer.writeContext({ nodeId: "shape:api", context: "the new note" });
    if (!done.ok) return expect.unreachable(done.detail);
    expect(done.value.changed.join(" ")).toContain(String("the old note".length));
  });

  it("refuses a note over the encoding's cap, and writes nothing", () => {
    const r = rig();
    const before = r.fingerprint();
    const done = r.writer.writeContext({
      nodeId: "shape:api",
      context: "x".repeat(MAX_CONTEXT_LENGTH + 1),
    });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.detail).toContain(String(MAX_CONTEXT_LENGTH));
    expect(r.fingerprint()).toBe(before);
  });

  it("keeps the title, which lives in props and must not be clobbered by a meta write", () => {
    const r = rig();
    expect(r.writer.writeContext({ nodeId: "shape:api", context: "note" }).ok).toBe(true);
    expect(plainText(r.doc.getShape("shape:api") as never)).toBe("Tree service");
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: a refusal never writes, and never throws
// ---------------------------------------------------------------------------

describe("a refusal is a feature", () => {
  const refusals = (w: TreeWriter) => [
    () => w.addChild({ parentId: "shape:ghost", title: "x" }),
    () => w.rename({ nodeId: "shape:ghost", title: "x" }),
    () => w.reparent({ nodeId: "shape:goal", newParentId: "shape:schema" }),
    () => w.setState({ nodeId: "shape:ghost", state: "done" }),
    () => w.writeContext({ nodeId: "shape:ghost", context: "x" }),
  ];

  it("leaves the document byte-for-byte unchanged, for every refusal", () => {
    const r = rig();
    const before = r.fingerprint();
    for (const attempt of refusals(r.writer)) {
      const done = attempt();
      expect(done.ok).toBe(false);
      expect(r.fingerprint()).toBe(before);
    }
  });

  it("never throws — a refusal is an answer, like W5's miss", () => {
    const r = rig();
    for (const attempt of refusals(r.writer)) expect(attempt).not.toThrow();
  });

  it("names an id in every refusal, so the agent can act on it", () => {
    const r = rig();
    for (const attempt of refusals(r.writer)) {
      const done = attempt();
      if (done.ok) return expect.unreachable("expected a refusal");
      expect(done.detail).toMatch(/shape:|page:/);
    }
  });
});

// ---------------------------------------------------------------------------
// A write that did not land is not a write
// ---------------------------------------------------------------------------

describe("a document that drops the write", () => {
  /** `CanvasDoc.putShape` REJECTS an invalid shape as a total no-op — no throw,
   * no report. So "I called putShape" is not evidence, and a writer that
   * trusted the call would answer success for a write that never happened. This
   * target drops everything, which is that failure at its most extreme. */
  function deafTarget(): TreeWriteTarget {
    const doc = liveDoc();
    return {
      document: () => dumpModel(doc),
      getShape: (id) => doc.getShape(id),
      putShape: () => {},
      updateProps: () => {},
      putBinding: () => {},
      deleteBinding: () => {},
      deleteShape: () => {},
      commit: () => {},
      random: seededRandom(2),
    };
  }

  it("refuses every write the document silently declined", () => {
    const writer = createTreeWriter(deafTarget());
    for (const done of [
      writer.setState({ nodeId: "shape:api", state: "done" }),
      writer.rename({ nodeId: "shape:api", title: "Nope" }),
      writer.writeContext({ nodeId: "shape:api", context: "nope" }),
      writer.addChild({ parentId: "shape:api", title: "Nope" }),
      writer.reparent({ nodeId: "shape:schema", newParentId: "shape:ui" }),
    ]) {
      expect(done.ok).toBe(false);
      if (done.ok) continue;
      expect(done.reason).toBe("rejected");
    }
  });
});

// ---------------------------------------------------------------------------
// Post-write verification is a REPORT, not a silent repair
// ---------------------------------------------------------------------------

describe("post-write verification", () => {
  /** A target whose document gains damage between the preflight and the
   * read-back — what a concurrent peer write looks like from in here. */
  function damagedTarget(): TreeWriteTarget {
    const doc = liveDoc();
    let writes = 0;
    return {
      document() {
        const model = dumpModel(doc);
        writes += 1;
        if (writes <= 1) return model;
        // A second, concurrent edge closing a loop: individually legal,
        // jointly a cycle. This is exactly W11's subject, and all this node
        // owes it is an honest report. Its own id, not one docOf would mint —
        // the fixture's edges are already shape:edge-0..2, and reusing one of
        // those makes an AMBIGUOUS edge (two bindings per terminal) rather than
        // the cycle this is about.
        const extra = buildTreeEdge({
          id: "shape:edge-concurrent",
          treeId: TREE,
          parentId: TREE,
          index: "zz",
          blockerId: "shape:goal",
          blockedId: "shape:schema",
          from: { x: 0, y: 0 },
          to: { x: 0, y: 0 },
        });
        return {
          ...model,
          shapes: [...model.shapes, extra.shape],
          bindings: [...model.bindings, ...extra.bindings],
        } as CanvasDocument;
      },
      getShape: (id) => doc.getShape(id),
      putShape: (shape) => doc.putShape(shape),
      updateProps: (id, props) => doc.updateProps(id, props),
      putBinding: (binding) => doc.putBinding(binding),
      deleteBinding: (id) => doc.deleteBinding(id),
      deleteShape: (id) => doc.deleteShape(id),
      commit: () => doc.commit(),
      random: seededRandom(3),
    };
  }

  it("reports a problem that appeared after the write instead of hiding it", () => {
    const writer = createTreeWriter(damagedTarget());
    const done = writer.setState({ nodeId: "shape:schema", state: "done" });
    if (!done.ok) return expect.unreachable(done.detail);
    expect(done.value.newProblems.map((problem) => problem.kind)).toContain("cycle");
  });

  it("does not report a problem that was already there before the write", () => {
    const r = rig({
      nodes: { "shape:a": "todo", "shape:b": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:a"],
      ],
    });
    const done = r.writer.setState({ nodeId: "shape:a", state: "wip" });
    if (!done.ok) return expect.unreachable(done.detail);
    expect(done.value.newProblems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

function toolDeps(spec: Spec = EXAMPLE, seed = 1): TreeWriteToolDeps & TreeToolDeps {
  const doc = liveDoc(spec);
  return {
    service: treeServiceForDoc(doc),
    writer: treeWriterForDoc(doc, { random: seededRandom(seed) }),
    linkedShapeId: (threadId) => (threadId === THREAD ? "shape:api" : null),
  };
}

async function call(
  deps: TreeWriteToolDeps,
  name: string,
  params: Record<string, unknown> = {},
  threadId: string = THREAD,
): Promise<{ text: string; isError: boolean }> {
  const tool = createTreeWriteTools(deps).find((candidate) => candidate.name === name);
  if (tool === undefined) return expect.unreachable(`no tool named ${name}`);
  const context: PluginAgentToolContext = {
    threadId,
    projectId: "proj_test",
    signal: new AbortController().signal,
  };
  const result = await tool.execute(tool.parameters.parse(params) as never, context);
  const text =
    typeof result === "string"
      ? result
      : result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  return { text, isError: typeof result === "string" ? false : result.isError === true };
}

describe("the write tools", () => {
  it("namespaces every name, because tool names are global across plugins", () => {
    for (const name of TREE_WRITE_TOOL_NAMES) expect(name.startsWith("canvas_tree_")).toBe(true);
  });

  it("uses only the characters bb allows in a tool name", () => {
    for (const name of TREE_WRITE_TOOL_NAMES) expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("registers each declared name exactly once", () => {
    const names = createTreeWriteTools(toolDeps()).map((tool) => tool.name);
    expect([...names].sort()).toEqual([...TREE_WRITE_TOOL_NAMES].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it("describes every tool, since the description is all a cold model has", () => {
    for (const tool of createTreeWriteTools(toolDeps())) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it("shows the resulting subtree, so the agent sees what it did", async () => {
    const deps = toolDeps();
    const answer = await call(deps, "canvas_tree_add_child", {
      parentId: "shape:goal",
      title: "Proof",
    });
    expect(answer.isError).toBe(false);
    // The parent, with the new child under it, and the child's own title.
    expect(answer.text).toContain("shape:goal");
    expect(answer.text).toContain("Proof");
  });

  // M13's regression: the first version asserted the answer mentioned the
  // parent id and the new title — both of which the "Created …" sentence
  // already carries, so deleting the OUTLINE changed nothing. This matches the
  // outline's own shape: the parent at column 0, the child indented under it.
  it("shows the outline itself, not just a sentence that names the same ids", async () => {
    const deps = toolDeps();
    const answer = await call(deps, "canvas_tree_add_child", {
      parentId: "shape:goal",
      title: "Proof",
    });
    expect(answer.text).toMatch(/^shape:goal — .+ \[todo\]/m);
    expect(answer.text).toMatch(/^ {2}shape:\S+ — Proof \[todo\]/m);
  });

  // M15's regression: the writer reports a concurrently-created problem, and
  // nothing asserted the TOOL passes it on. A model that was not told the tree
  // broke under it plans its next write against a tree that is not there.
  it("surfaces a problem that appeared during the write, with isError", async () => {
    const deps = toolDeps();
    const damaged: TreeWriteToolDeps = {
      ...deps,
      writer: {
        ...deps.writer,
        setState: () => ({
          ok: true,
          value: {
            focusId: "shape:api",
            changed: ["shape:api moved from wip to done."],
            newProblems: [
              {
                kind: "cycle",
                subjects: ["shape:api", "shape:goal"],
                detail: "shape:api blocks shape:goal blocks shape:api",
              },
            ],
          },
        }),
      },
    };
    const answer = await call(damaged, "canvas_tree_set_state", { state: "done" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("cycle");
    expect(answer.text).toContain("another editor changed it at the same time");
  });

  it("defaults to the thread's own node, like every read tool", async () => {
    const deps = toolDeps();
    const answer = await call(deps, "canvas_tree_set_state", { state: "done" });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("shape:api");
  });

  it("refuses with isError, so a refusal can never read as tree content", async () => {
    const deps = toolDeps();
    const answer = await call(deps, "canvas_tree_reparent", {
      nodeId: "shape:goal",
      newParentId: "shape:schema",
    });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("shape:goal");
    expect(answer.text).toContain("shape:schema");
  });

  it("refuses when the thread has no node and the call named none", async () => {
    const deps = toolDeps();
    const answer = await call(deps, "canvas_tree_rename", { title: "x" }, "thr_elsewhere");
    expect(answer.isError).toBe(true);
  });

  it("renames through the tool, and the read spine sees it", async () => {
    const deps = toolDeps();
    await call(deps, "canvas_tree_rename", { nodeId: "shape:api", title: "Renamed by an agent" });
    const found = deps.service.node("shape:api");
    expect(found.ok && found.value.title).toBe("Renamed by an agent");
  });

  it("writes a context note through the tool", async () => {
    const deps = toolDeps();
    await call(deps, "canvas_tree_write_context", { nodeId: "shape:api", context: "the brief" });
    const found = deps.service.node("shape:api");
    expect(found.ok && found.value.context).toBe("the brief");
  });
});

describe("scope — a write tool is offered exactly where a read tool is", () => {
  it("offers reads AND writes in a thread about a tree node", () => {
    expect(selectTreeTools(THREAD, toolDeps())).toEqual([...TREE_TOOL_NAMES]);
    for (const name of TREE_WRITE_TOOL_NAMES) {
      expect(selectTreeTools(THREAD, toolDeps())).toContain(name);
    }
  });

  it("offers nothing at all in a thread that is not about a tree node", () => {
    expect(selectTreeTools("thr_elsewhere", toolDeps())).toEqual([]);
  });

  it("registers the read and the write set through one configure callback", () => {
    const registered: string[] = [];
    let selector: ((context: { thread: { id: string } }) => { tools: string[] }) | null = null;
    const bb = {
      agents: {
        registerTool: (tool: { name: string }) => registered.push(tool.name),
        configure: (fn: (context: { thread: { id: string } }) => { tools: string[] }) => {
          if (selector !== null) throw new Error("bb accepts one configure callback per plugin");
          selector = fn;
        },
      },
    };
    registerTreeAgentTools(bb as never, toolDeps());
    expect([...registered].sort()).toEqual([...TREE_TOOL_NAMES].sort());
    expect(registered).toContain(TREE_READ_TOOL_NAMES[0]);
    expect(registered).toContain(TREE_WRITE_TOOL_NAMES[0]);
    expect((selector as never as (c: { thread: { id: string } }) => { tools: string[] })({
      thread: { id: THREAD },
    }).tools).toEqual([...TREE_TOOL_NAMES]);
  });
});

// ---------------------------------------------------------------------------
// Durability — an agent write must survive a reload
// ---------------------------------------------------------------------------

describe("durability of a server-local write", () => {
  it("logs the delta, so the write survives a restart before the next compaction", () => {
    const db = new Database(":memory:");
    const store = new CanvasStore(db);
    for (const statement of CANVAS_MIGRATIONS) db.exec(statement);
    const host = new CanvasRoomHost({ store, publish: () => {}, room: "main" });
    const writer = treeWriterForDoc(host.peer.doc, {
      commit: () => host.commitLocalWrite(),
      random: seededRandom(5),
    });
    // Seed a tree the way a human's client would, through the doc.
    loadModel(host.peer.doc, docOf(EXAMPLE));
    host.commitLocalWrite();
    const done = writer.addChild({ parentId: "shape:goal", title: "Written by an agent" });
    if (!done.ok) return expect.unreachable(done.detail);
    expect(store.updateCount("main")).toBeGreaterThan(0);

    // A second host over the same store is what a plugin reload looks like.
    const reloaded = new CanvasRoomHost({ store, publish: () => {}, room: "main" });
    const tree = readTree(dumpModel(reloaded.peer.doc), TREE);
    expect(tree.nodes.has(done.value.createdId as string)).toBe(true);
  });
});
