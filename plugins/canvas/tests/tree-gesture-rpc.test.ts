// Run: npx vitest run tests/tree-gesture-rpc.test.ts
//
// W4's WRITE PATH, end to end, through the real plugin factory.
//
// THE CHOICE THIS SUITE EXISTS TO PIN. A canvas gesture could have written
// straight into the browser's own copy of the document — it is a CRDT, the
// panel already holds an editor, and the shape would appear instantly. It does
// not. Every node a human creates goes over rpc to the plugin server and
// through W10's write engine, so a human's create obeys the SAME refusals, the
// SAME post-write invariant re-read and the SAME durable
// `commitLocalWrite` an agent's does. A second, client-side write path would
// be a second definition of what a legal tree is, and the two would drift.
//
// So the assertions here are deliberately about the ROUND TRIP: the human's
// own peer must SEE the node it asked for arrive, because on this path that is
// the only way it ever appears on their screen.
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { dumpModel } from "@ensembleworks/canvas-doc";
import { shapeText } from "../canvas/shape-text.js";
import { markTreePage, readTreePage } from "../canvas/tree/encoding.js";
import { readTree } from "../canvas/tree/model.js";
import { connectPeer, type ConnectedPeer } from "./lib/room-rig.js";
import { treeWriteResult } from "../canvas/rpc-handlers.js";
import plugin from "../server.js";

const TREE = "page:discovery";

const host = () => createFakePluginHost({ pluginId: "canvas", settings: { project: "proj_test" } });

/** The tree as the HUMAN's own peer holds it — the only copy that matters for
 * "did anything appear on their canvas". */
const treeOnClient = (client: ConnectedPeer, treeId = TREE) =>
  readTree(dumpModel(client.peer.doc), treeId);

/** A page the human made, with `mark` deciding whether it is a tree yet. */
async function seedPage(client: ConnectedPeer, mark: boolean): Promise<void> {
  const page = { id: TREE, name: "Discovery", index: "a5" } as const;
  client.peer.doc.putPage((mark ? markTreePage(page) : page) as never);
  client.peer.doc.commit();
  await client.pump();
}

const call = (h: FakePluginHost, method: string, input: unknown) =>
  h.harness.behavior.callRpc(method, input) as Promise<{
    nodeId: string;
    changed: string[];
    problems: string[];
  }>;

describe("canvas_tree_add_goal", () => {
  it("creates a goal the human's own canvas then receives", async () => {
    const h = host();
    await plugin(h.bb);
    const client = await connectPeer(h, "client-a");
    await seedPage(client, true);

    const result = await call(h, "canvas_tree_add_goal", { treeId: TREE, title: "Ship the loop" });
    await client.pump();

    const tree = treeOnClient(client);
    const created = tree.nodes.get(result.nodeId);
    expect(created).toBeDefined();
    // Read on the CLIENT's own live text container — the channel canvas-react
    // renders from and a human types into. A server-side write that only
    // reached `props.richText` would satisfy a `plainText` assertion here and
    // still be invisible on a note the human had ever typed in (W14's F1).
    expect(client.peer.doc.getText(result.nodeId)).toBe("Ship the loop");
    expect(shapeText(created!.shape, client.peer.doc.getText(result.nodeId)).trim()).toBe(
      "Ship the loop",
    );
    // A goal blocks nothing: no edge came with it.
    expect(tree.edges).toHaveLength(0);
    expect(result.problems).toEqual([]);
  });

  it("marks an UNMARKED page, so a human can start a tree from an ordinary page", async () => {
    const h = host();
    await plugin(h.bb);
    const client = await connectPeer(h, "client-a");
    await seedPage(client, false);

    const result = await call(h, "canvas_tree_add_goal", { treeId: TREE, title: "First goal" });
    await client.pump();

    const page = dumpModel(client.peer.doc).pages.find((candidate) => candidate.id === TREE);
    expect(readTreePage(page!).status).toBe("ok");
    expect(treeOnClient(client).nodes.has(result.nodeId)).toBe(true);
  });

  it("rejects a refusal as an error the panel can toast, naming the page", async () => {
    const h = host();
    await plugin(h.bb);
    await connectPeer(h, "client-a");
    await expect(call(h, "canvas_tree_add_goal", { treeId: "page:nope", title: "Nowhere" })).rejects.toThrow(
      /page:nope/,
    );
  });

  it("refuses a blank title at the WIRE, before any write is attempted", async () => {
    const h = host();
    await plugin(h.bb);
    await expect(call(h, "canvas_tree_add_goal", { treeId: TREE, title: "   " })).rejects.toThrow();
  });
});

describe("canvas_tree_add_blocker", () => {
  async function withGoal(): Promise<{ h: FakePluginHost; client: ConnectedPeer; goalId: string }> {
    const h = host();
    await plugin(h.bb);
    const client = await connectPeer(h, "client-a");
    await seedPage(client, true);
    const goal = await call(h, "canvas_tree_add_goal", { treeId: TREE, title: "Ship the loop" });
    await client.pump();
    return { h, client, goalId: goal.nodeId };
  }

  it("creates a node BLOCKING the selected one, with its bound edge, on the human's canvas", async () => {
    const { h, client, goalId } = await withGoal();
    const result = await call(h, "canvas_tree_add_blocker", {
      parentId: goalId,
      title: "Decide the encoding",
    });
    await client.pump();

    const tree = treeOnClient(client);
    expect(tree.nodes.has(result.nodeId)).toBe(true);
    // W0's direction, asserted rather than assumed: the NEW node is the
    // blocker, the selected one is the blocked.
    expect(tree.edges.map((edge) => `${edge.blockerId}>${edge.blockedId}`)).toEqual([
      `${result.nodeId}>${goalId}`,
    ]);
    // The edge is bound at BOTH ends, which is what keeps the arrow attached
    // while the human drags either node.
    const bindings = dumpModel(client.peer.doc).bindings.filter(
      (binding) => binding.fromId === tree.edges[0].edgeId,
    );
    expect(bindings).toHaveLength(2);
  });

  it("places a second blocker beside the first rather than on top of it", async () => {
    const { h, client, goalId } = await withGoal();
    const first = await call(h, "canvas_tree_add_blocker", { parentId: goalId, title: "One" });
    const second = await call(h, "canvas_tree_add_blocker", { parentId: goalId, title: "Two" });
    await client.pump();

    const doc = dumpModel(client.peer.doc);
    const a = doc.byId.get(first.nodeId)!;
    const b = doc.byId.get(second.nodeId)!;
    expect(b.x).toBeGreaterThan(a.x);
  });

  it("does not move a node the human dragged", async () => {
    // THE RULE FOR THE WHOLE NODE: a gesture places what it creates and
    // touches nothing else. Drag the goal, add a blocker, and the goal is
    // exactly where it was left.
    const { h, client, goalId } = await withGoal();
    const goal = dumpModel(client.peer.doc).byId.get(goalId)!;
    client.peer.doc.putShape({ ...goal, x: 1234, y: 567 });
    client.peer.doc.commit();
    await client.pump();

    await call(h, "canvas_tree_add_blocker", { parentId: goalId, title: "Under the dragged goal" });
    await client.pump();

    const moved = dumpModel(client.peer.doc).byId.get(goalId)!;
    expect({ x: moved.x, y: moved.y }).toEqual({ x: 1234, y: 567 });
  });

  it("rejects a parent that is not a tree node, naming it", async () => {
    const h = host();
    await plugin(h.bb);
    await connectPeer(h, "client-a");
    await expect(
      call(h, "canvas_tree_add_blocker", { parentId: "shape:nope", title: "Orphan" }),
    ).rejects.toThrow(/shape:nope/);
  });
});

// ---------------------------------------------------------------------------
// The answer shape itself
// ---------------------------------------------------------------------------
//
// `treeWriteResult` is tested directly because the interesting case cannot be
// staged above: the write runs synchronously inside the handler, so no
// concurrent peer can land an edge between its preflight and its read-back.
// The engine's own suite makes that damage with a fake document
// (tests/tree-write-tools.test.ts's `damagedTarget`); what is left to pin here
// is that the handler PASSES IT ON instead of dropping it, which is the only
// thing standing between a human and a silently damaged tree.
describe("treeWriteResult", () => {
  const silent = { info: () => {} };

  it("carries the problems a concurrent editor left behind", () => {
    const answer = treeWriteResult(
      {
        ok: true,
        value: {
          focusId: "shape:goal",
          createdId: "shape:new",
          changed: ["Created shape:new."],
          newProblems: [
            { kind: "cycle", subjects: ["shape:a", "shape:b"], detail: "a blocks b blocks a" },
          ],
        },
      },
      silent,
    );
    expect(answer.problems).toEqual(["cycle: a blocks b blocks a"]);
  });

  it("answers with what the write CREATED, not the node it focused", () => {
    // `addChild` focuses the PARENT — the node the human already had selected.
    // Answering that would make a create look like it did nothing.
    const answer = treeWriteResult(
      {
        ok: true,
        value: { focusId: "shape:goal", createdId: "shape:new", changed: [], newProblems: [] },
      },
      silent,
    );
    expect(answer.nodeId).toBe("shape:new");
  });

  it("turns a refusal into an error carrying the engine's own sentence", () => {
    expect(() =>
      treeWriteResult({ ok: false, reason: "would-cycle", detail: "shape:a already blocks it" }, silent),
    ).toThrow(/would-cycle: shape:a already blocks it/);
  });
});
