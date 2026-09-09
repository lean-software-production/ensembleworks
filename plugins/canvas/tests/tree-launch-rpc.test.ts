// Run: npx vitest run tests/tree-launch-rpc.test.ts
//
// W12 through the real plugin factory: launching a thread TO WORK ON one node,
// over the room's own document.
//
// NO SECOND LINK STORE. The launch records through `AgentLinks`, exactly as
// `canvas_run_note` does, so the badge, bb's three lifecycle events and the
// canvas-gc sweep all apply unchanged — this suite asserts that by driving the
// EXISTING surfaces (`canvas_agents`, `thread.idle`, `canvas_unlink_agent`)
// against a link the tree launch minted.
//
// AND THE ORDERING. `agents.record` cannot run until `threads.spawn` resolves,
// and spawn starts turn 1. The probe below reads `canvas_agents` from INSIDE
// the fake spawn and finds nothing — which is why the prompt has to carry the
// node's orientation itself rather than leaning on W7's brief.
import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { buildTreeNode, markTreePage } from "../canvas/tree/encoding.js";
import { AGENT_CHANNEL, agentLinkFrom, type CanvasAgentLink } from "../canvas/wire.js";
import { connectPeer, type ConnectedPeer } from "./lib/room-rig.js";
import plugin from "../server.js";

const PROJECT = "proj_test";
const TREE = "page:discovery";
const NODE = "shape:goal";

interface SpawnArgs {
  readonly prompt: string;
  readonly title: string;
  readonly projectId: string;
}

function hostWithThreads(
  spawned: SpawnArgs[],
  onSpawn?: () => Promise<void>,
): FakePluginHost {
  let next = 0;
  return createFakePluginHost({
    pluginId: "canvas",
    settings: { project: PROJECT },
    sdk: {
      threads: {
        spawn: async (args) => {
          spawned.push(args as unknown as SpawnArgs);
          if (onSpawn !== undefined) await onSpawn();
          next += 1;
          return makeThreadResponse({ id: `th_${next}` });
        },
      },
    },
  });
}

/** A tree page with one goal carrying a context note, on the room's document. */
async function seed(client: ConnectedPeer, context: string | undefined): Promise<void> {
  client.peer.doc.putPage(markTreePage({ id: TREE, name: "Discovery", index: "a5" }) as never);
  client.peer.putShape(
    ((): never => {
      const node = buildTreeNode({
        id: NODE,
        treeId: TREE,
        parentId: TREE,
        index: "a0",
        x: 0,
        y: 0,
        state: "todo",
        context,
      });
      return {
        ...node,
        props: {
          ...(node.props as Record<string, unknown>),
          richText: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Ship the loop" }] }],
          },
        },
      } as never;
    })(),
  );
  client.peer.doc.commit();
  await client.pump();
}

const launch = (h: FakePluginHost, nodeId: string) =>
  h.harness.behavior.callRpc("canvas_tree_launch", { nodeId }) as Promise<CanvasAgentLink>;

const linksOf = async (h: FakePluginHost): Promise<CanvasAgentLink[]> =>
  ((await h.harness.behavior.callRpc("canvas_agents", null)) as { links: CanvasAgentLink[] })
    .links;

const badgeSignals = (h: FakePluginHost): CanvasAgentLink[] =>
  h.harness.inspection.realtimeSignals
    .filter((signal) => signal.channel === AGENT_CHANNEL)
    .map((signal) => agentLinkFrom(signal.payload))
    .filter((link): link is CanvasAgentLink => link !== null);

describe("canvas_tree_launch", () => {
  it("spawns on the node's brief and binds the thread to the node", async () => {
    const spawned: SpawnArgs[] = [];
    const h = hostWithThreads(spawned);
    await plugin(h.bb);
    const client = await connectPeer(h, "client-a");
    await seed(client, "Done when the loop runs end to end.");

    const link = await launch(h, NODE);

    expect(link).toEqual({ shapeId: NODE, threadId: "th_1", status: "running" });
    expect(spawned[0]?.projectId).toBe(PROJECT);
    expect(spawned[0]?.title).toBe("Canvas: Ship the loop");
    expect(spawned[0]?.prompt).toContain("Done when the loop runs end to end.");
    // Reuse, asserted: the badge and the durable link are the ones the
    // note-launch path already mints.
    expect(badgeSignals(h)).toEqual([link]);
    expect(await linksOf(h)).toEqual([link]);
  });

  it("hands turn 1 the orientation, because turn 1 has no link and so no brief", async () => {
    const spawned: SpawnArgs[] = [];
    let linksDuringSpawn: CanvasAgentLink[] | null = null;
    const h = hostWithThreads(spawned, async () => {
      linksDuringSpawn = await linksOf(h);
    });
    await plugin(h.bb);
    const client = await connectPeer(h, "client-a");
    await seed(client, undefined);

    await launch(h, NODE);

    // The link does not exist while the first turn is being started.
    expect(linksDuringSpawn).toEqual([]);
    // So the prompt says what the node is and where it sits, itself.
    expect(spawned[0]?.prompt).toContain(NODE);
    expect(spawned[0]?.prompt).toContain("up to root:");
    expect(spawned[0]?.prompt).toContain("blocked by");
  });

  it("refuses a shape that is not a tree node, in a sentence naming it", async () => {
    const h = hostWithThreads([]);
    await plugin(h.bb);
    const client = await connectPeer(h, "client-a");
    await seed(client, undefined);

    await expect(launch(h, "shape:nope")).rejects.toThrow(/shape:nope/);
    expect(await linksOf(h)).toEqual([]);
  });

  it("hands the node's link to the SAME lifecycle a note's link gets", async () => {
    const h = hostWithThreads([]);
    await plugin(h.bb);
    const client = await connectPeer(h, "client-a");
    await seed(client, undefined);
    await launch(h, NODE);

    await h.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "th_1" }),
      lastAssistantText: "done",
    });
    expect((await linksOf(h))[0]?.status).toBe("idle");

    await h.harness.behavior.callRpc("canvas_unlink_agent", { shapeId: NODE });
    expect(await linksOf(h)).toEqual([]);
  });
});
