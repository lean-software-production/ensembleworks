// Run: npx vitest run tests/tree-cli-wiring.test.ts
//
// W13's OTHER half: the CLI is only worth anything if it is wired to the LIVE
// ROOM DOCUMENT. tree-cli.test.ts proves the rendering and the resolution
// against a fixture; every test there would still pass if `bb canvas tree`
// were registered against nothing at all, or not registered.
//
// So this suite drives the real plugin factory: it builds a tree over rpc —
// the same path a human's "add goal" gesture takes — and then asks the CLI
// about it, with nothing in between. That is the claim W13 makes: an agent in
// a terminal, with no bb tool session, can read the tree a human just drew.
//
// It also pins the two registrations a mutation could drop while leaving every
// other suite green: the `tree` verb in the CLI's own command metadata (which
// is what `bb --help` and the plugin-commands skill read WITHOUT executing
// plugin code), and the quarantine tools in the agent registration.
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { markTreePage } from "../canvas/tree/encoding.js";
import { TREE_QUARANTINE_TOOL_NAMES } from "../canvas/tree/quarantine-tools.js";
import { connectPeer, type ConnectedPeer } from "./lib/room-rig.js";
import plugin from "../server.js";

const TREE = "page:discovery";

const host = () => createFakePluginHost({ pluginId: "canvas", settings: { project: "proj_test" } });

async function seedPage(client: ConnectedPeer): Promise<void> {
  client.peer.doc.putPage(
    markTreePage({ id: TREE, name: "Discovery", index: "a5" }) as never,
  );
  client.peer.doc.commit();
  await client.pump();
}

const add = (h: FakePluginHost, method: string, input: unknown) =>
  h.harness.behavior.callRpc(method, input) as Promise<{ nodeId: string }>;

/** A live plugin holding a two-node tree a human just drew. */
async function boot() {
  const h = host();
  await plugin(h.bb);
  const client = await connectPeer(h, "client-a");
  await seedPage(client);
  const goal = await add(h, "canvas_tree_add_goal", {
    treeId: TREE,
    title: "Ship the loop",
  });
  const blocker = await add(h, "canvas_tree_add_blocker", {
    parentId: goal.nodeId,
    title: "Write the CLI",
  });
  await client.pump();
  return {
    host: h,
    goalId: goal.nodeId,
    blockerId: blocker.nodeId,
    cli: (argv: string[]) => h.harness.behavior.runCli(["tree", ...argv]),
    dispose: () => h.harness.lifecycle.dispose(),
  };
}

describe("bb canvas tree reads the live room document", () => {
  it("lists the tree a human just drew over rpc", async () => {
    const rig = await boot();
    try {
      const result = await rig.cli([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(TREE);
      expect(result.stdout).toContain("2 nodes");
    } finally {
      await rig.dispose();
    }
  });

  it("shows the outline, with the blocker indented under the goal", async () => {
    const rig = await boot();
    try {
      const result = await rig.cli(["show"]);
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split("\n");
      const goal = lines.find((line) => line.includes(rig.goalId));
      const blocker = lines.find((line) => line.includes(rig.blockerId));
      expect(goal).toContain("Ship the loop");
      expect(blocker).toContain("Write the CLI");
      expect(blocker?.match(/^ */)?.[0].length).toBeGreaterThan(
        goal?.match(/^ */)?.[0].length ?? 0,
      );
    } finally {
      await rig.dispose();
    }
  });

  it("answers --json about the same document", async () => {
    const rig = await boot();
    try {
      const result = await rig.cli(["ready", "--json"]);
      const parsed = JSON.parse(result.stdout) as readonly { id: string }[];
      // Only the blocker is startable: the goal has something unfinished
      // beneath it.
      expect(parsed.map((view) => view.id)).toEqual([rig.blockerId]);
    } finally {
      await rig.dispose();
    }
  });

  it("asks the REAL recovery surface, not a stub", async () => {
    // server.ts hands the CLI two closures over `treeRepairTargetForDoc`. A
    // stub in their place would satisfy every test in tree-cli.test.ts, which
    // arms its own. These two answers are W11's own sentences, over the live
    // document: nothing is quarantined here, and an id that is not a shape is
    // refused in `restoreQuarantinedEdge`'s exact words.
    const rig = await boot();
    try {
      const listed = await rig.cli(["quarantined"]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain(`No edges are quarantined in ${TREE}.`);

      const refused = await rig.cli(["restore", "shape:nope"]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("no shape shape:nope in this document");
    } finally {
      await rig.dispose();
    }
  });

  it("says the canvas has no trees when nobody has drawn one", async () => {
    const h = host();
    await plugin(h.bb);
    try {
      const result = await h.harness.behavior.runCli(["tree"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No tree pages on this canvas.");
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});

describe("the registrations a mutation could drop silently", () => {
  it("lists `tree` in the command metadata agents and `bb --help` read", async () => {
    const h = host();
    await plugin(h.bb);
    try {
      expect(h.harness.registrations.cli?.commands).toContainEqual(
        expect.objectContaining({ name: "tree" }),
      );
      const entry = h.harness.registrations.cli?.commands?.find(
        (command) => command.name === "tree",
      );
      // The usage line is the only place a reader who never runs the command
      // learns the verbs exist.
      for (const verb of ["show", "node", "ready", "quarantined", "restore"]) {
        expect(entry?.usage).toContain(verb);
      }
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("registers the quarantine tools alongside the rest of the tree tools", async () => {
    const h = host();
    await plugin(h.bb);
    try {
      const names = h.harness.registrations.agentTools.map((tool) => tool.name);
      for (const name of TREE_QUARANTINE_TOOL_NAMES) {
        expect(names).toContain(name);
      }
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});
