// Run: npx vitest run tests/tree-inspector-rpc.test.ts
//
// W18's edits, end to end through the real plugin factory — the same shape
// tests/tree-gesture-rpc.test.ts takes for W4's two gestures, and for the same
// reason: a human's edit to a node goes over rpc into W10's engine, so it
// obeys the same refusals, the same post-write invariant re-read and the same
// durable commit an agent's does. There is no second, client-side write path.
//
// The assertions are about the ROUND TRIP: the human's own peer must SEE the
// change arrive, because on this path that is the only way it ever reaches
// their screen.
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { dumpModel } from "@ensembleworks/canvas-doc";
import { markTreePage, readTreeNode } from "../canvas/tree/encoding.js";
import { connectPeer, type ConnectedPeer } from "./lib/room-rig.js";
import plugin from "../server.js";

const TREE = "page:inspected";

const host = () => createFakePluginHost({ pluginId: "canvas", settings: { project: "proj_test" } });

const call = (h: FakePluginHost, method: string, input: unknown) =>
  h.harness.behavior.callRpc(method, input) as Promise<{
    nodeId: string;
    changed: string[];
    problems: string[];
  }>;

/** The node's tree meta as the HUMAN's own peer holds it. */
function metaOnClient(client: ConnectedPeer, nodeId: string) {
  const shape = dumpModel(client.peer.doc).byId.get(nodeId);
  const read = readTreeNode(shape!);
  if (read.status !== "ok") throw new Error(`unreadable node ${nodeId}`);
  return read.value;
}

/** A tree page with one goal on it, made the way a human makes one. */
async function seeded(): Promise<{ h: FakePluginHost; client: ConnectedPeer; nodeId: string }> {
  const h = host();
  await plugin(h.bb);
  const client = await connectPeer(h, "client-a");
  client.peer.doc.putPage(markTreePage({ id: TREE, name: "Inspected", index: "a5" }) as never);
  client.peer.doc.commit();
  await client.pump();
  const goal = await call(h, "canvas_tree_add_goal", { treeId: TREE, title: "Ship the loop" });
  await client.pump();
  return { h, client, nodeId: goal.nodeId };
}

describe("canvas_tree_set_state", () => {
  it("moves a node, and the human's own canvas receives it", async () => {
    const { h, client, nodeId } = await seeded();
    const result = await call(h, "canvas_tree_set_state", { nodeId, state: "done" });
    await client.pump();
    expect(metaOnClient(client, nodeId).state).toBe("done");
    expect(result.changed.join(" ")).toContain(nodeId);
    expect(result.problems).toEqual([]);
  });

  it("refuses a shape that is not a node, in the engine's own words", async () => {
    const { h } = await seeded();
    await expect(call(h, "canvas_tree_set_state", { nodeId: "shape:nope", state: "done" }))
      .rejects.toThrow(/shape:nope/);
  });
});

describe("canvas_tree_set_approached", () => {
  it("records that a human looked at a node and nothing came up", async () => {
    const { h, client, nodeId } = await seeded();
    await call(h, "canvas_tree_set_approached", { nodeId, approached: true });
    await client.pump();
    expect(metaOnClient(client, nodeId).approached).toBe(true);
    await call(h, "canvas_tree_set_approached", { nodeId, approached: false });
    await client.pump();
    expect(metaOnClient(client, nodeId).approached).toBe(false);
  });
});

describe("canvas_tree_write_context", () => {
  it("writes a note the human's own canvas then holds", async () => {
    const { h, client, nodeId } = await seeded();
    await call(h, "canvas_tree_write_context", {
      nodeId,
      context: "# Definition of done\nA human can see state.",
      expected: "",
    });
    await client.pump();
    expect(metaOnClient(client, nodeId).context).toContain("Definition of done");
  });

  it("REFUSES a save whose expectation the document no longer matches", async () => {
    const { h, client, nodeId } = await seeded();
    await call(h, "canvas_tree_write_context", { nodeId, context: "an agent's note", expected: "" });
    await client.pump();
    await expect(
      call(h, "canvas_tree_write_context", { nodeId, context: "mine", expected: "" }),
    ).rejects.toThrow(/stale-write/);
    expect(metaOnClient(client, nodeId).context).toBe("an agent's note");
  });
});
