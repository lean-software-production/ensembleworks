// Run: npx vitest run tests/tree-node-rpc.test.ts
//
// W9's read: the one rpc a `::node` card makes, through the real plugin
// factory.
//
// WHY THE CARD ASKS THE SERVER AT ALL, rather than being told everything in
// the directive's attributes. The attributes were written by a model, at some
// point in the past, into a message that is kept forever. A title and a state
// baked in there are a snapshot of a tree that has since moved on — and a card
// confidently showing "todo" on work that finished yesterday is worse than one
// that says it cannot find the node. So the id is the ONLY thing the directive
// carries, and every fact on the card is read live, through W5's service, over
// the same document the canvas draws.
//
// The reply is deliberately small (id, page, title, state, readiness): it
// feeds one line of chrome in a chat message, and a context note has no place
// in a message the model is already writing prose into.
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { buildTreeNode, markTreePage } from "../canvas/tree/encoding.js";
import { connectPeer, type ConnectedPeer } from "./lib/room-rig.js";
import plugin from "../server.js";

const TREE = "page:discovery";

const host = () => createFakePluginHost({ pluginId: "canvas", settings: { project: "proj_test" } });

async function seedTreePage(client: ConnectedPeer): Promise<void> {
  client.peer.doc.putPage(
    markTreePage({ id: TREE, name: "Discovery", index: "a5" }) as never,
  );
  client.peer.doc.commit();
  await client.pump();
}

const call = (h: FakePluginHost, method: string, input: unknown) =>
  h.harness.behavior.callRpc(method, input) as Promise<{
    node: {
      id: string;
      treeId: string;
      title: string;
      state: string;
      isReady: boolean;
    } | null;
  }>;

describe("canvas_tree_node", () => {
  it("answers with the node as the document holds it NOW", async () => {
    const h = host();
    await plugin(h.bb);
    const client = await connectPeer(h, "client-a");
    await seedTreePage(client);
    const created = (await h.harness.behavior.callRpc("canvas_tree_add_goal", {
      treeId: TREE,
      title: "Ship the loop",
    })) as { nodeId: string };

    const answer = await call(h, "canvas_tree_node", { nodeId: created.nodeId });

    expect(answer.node).toEqual({
      id: created.nodeId,
      treeId: TREE,
      title: "Ship the loop",
      state: "todo",
      // A goal with nothing under it is ready by W1's one definition of
      // readiness — the card says so, and this is the fact a human clicking a
      // reference most wants.
      isReady: true,
    });
  });

  it("carries a LABEL, not the whole note", async () => {
    // A node's title is `plainText(shape)` — the entire note, newlines and
    // all. That is right for a tool answer and wrong for a chip in a chat
    // message, and wrong on the wire too: the card re-reads on every repaint.
    const h = host();
    await plugin(h.bb);
    const client = await connectPeer(h, "client-a");
    await seedTreePage(client);
    client.peer.doc.putShape({
      ...buildTreeNode({
        id: "shape:essay",
        treeId: TREE,
        parentId: TREE,
        index: "a1",
        x: 0,
        y: 0,
        state: "todo",
      }),
      props: {
        richText: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Ship the loop" }] },
            { type: "paragraph", content: [{ type: "text", text: "and every reason why" }] },
          ],
        },
      },
    } as never);
    client.peer.doc.commit();
    await client.pump();

    const answer = await call(h, "canvas_tree_node", { nodeId: "shape:essay" });
    expect(answer.node?.title).toBe("Ship the loop");
  });

  it("says null for an id the document does not have, rather than failing", async () => {
    // A deleted node and an invented one are the same answer, and neither is
    // an ERROR: the card renders a dead reference, which is a normal thing for
    // an old message to contain.
    const h = host();
    await plugin(h.bb);
    const client = await connectPeer(h, "client-a");
    await seedTreePage(client);

    expect((await call(h, "canvas_tree_node", { nodeId: "shape:never-was" })).node).toBeNull();
  });

  it("says null for a shape that exists but is not a tree node", async () => {
    const h = host();
    await plugin(h.bb);
    const client = await connectPeer(h, "client-a");
    await seedTreePage(client);
    client.peer.doc.putShape({
      id: "shape:plain",
      kind: "note",
      parentId: TREE,
      index: "a1",
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {},
    } as never);
    client.peer.doc.commit();
    await client.pump();

    expect((await call(h, "canvas_tree_node", { nodeId: "shape:plain" })).node).toBeNull();
  });
});
