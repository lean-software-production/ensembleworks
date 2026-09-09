// Run: npx vitest run tests/tree-agent-tools.test.ts
//
// W6's gate. These are the plugin's FIRST agent-facing tools: what a bb thread
// can ask about a discovery tree living in the canvas document.
//
// What these tests are aimed at, because they are the ways this layer goes
// wrong once a model is on the other end of it:
//
//  1. SCOPE. Tool names are global across every bb plugin and a tool offered
//     in a thread that has nothing to do with a canvas is a permanent tax on
//     every model's context. The tools appear only in a thread linked to a
//     shape that IS a tree node.
//  2. ORIENTATION WITHOUT ARGUMENTS. The thread's own node is the default
//     subject. A model that has just been started must be able to ask "where
//     am I" without first having to learn an id.
//  3. THE DIGEST'S DROPPINGS ARE REACHABLE. W7 contributes the digest inside
//     a 4096-char cap and the digest itself is capped at 2000. This node's
//     whole reason to exist (plan risk 1) is that everything the digest is
//     forced to drop can still be fetched by a tool.
//  4. A MISS IS DATA, NOT A THROW. W5's contract carried to the wire: a
//     deleted node answers, it does not take the tool set down.
//  5. ONE DEFINITION OF READY. `model.isReadyNode`, through the service, and
//     nothing else — no second rule re-derived at the tool layer.
import { describe, expect, it } from "vitest";
import type { PluginAgentToolContext } from "@get-bb/plugin-sdk";
import {
  createTreeService,
  type TreeService,
} from "../canvas/tree/service.js";
import {
  MAX_ANSWER_CHARS,
  TREE_TOOL_NAMES,
  createTreeTools,
  registerTreeAgentTools,
  selectTreeTools,
  type TreeToolDeps,
} from "../canvas/tree/agent-tools.js";
import { EXAMPLE, TREE, docOf, serviceOf, type Spec } from "./lib/tree-fixture.js";

const THREAD = "thr_linked";

/** Deps over a fixed document, with one thread linked to `shapeId`. */
function depsOf(
  spec: Spec,
  links: Readonly<Record<string, string>> = { [THREAD]: "shape:api" },
): TreeToolDeps {
  return {
    service: serviceOf(spec),
    linkedShapeId: (threadId) => links[threadId] ?? null,
  };
}

/** The text a tool call produced, whatever result shape it used. */
function textOf(result: Awaited<ReturnType<ReturnType<typeof toolNamed>["execute"]>>): string {
  if (typeof result === "string") return result;
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function toolNamed(deps: TreeToolDeps, name: string) {
  const tool = createTreeTools(deps).find((candidate) => candidate.name === name);
  if (tool === undefined) expect.unreachable(`no tool named ${name}`);
  return tool;
}

/** Call one tool as a thread would, with already-parsed parameters. */
async function call(
  deps: TreeToolDeps,
  name: string,
  params: Record<string, unknown> = {},
  threadId: string = THREAD,
): Promise<{ text: string; isError: boolean }> {
  const tool = toolNamed(deps, name);
  const parsed = tool.parameters.parse(params);
  // Typed as bb's own per-call context, not as the tools' narrower one: this
  // is what proves a real tool call can be handed straight to `execute`.
  const context: PluginAgentToolContext = {
    threadId,
    projectId: "proj_test",
    signal: new AbortController().signal,
  };
  const result = await tool.execute(parsed, context);
  return {
    text: textOf(result),
    isError: typeof result === "string" ? false : result.isError === true,
  };
}

describe("the tool set itself", () => {
  it("namespaces every tool, because tool names are global across plugins", () => {
    for (const name of TREE_TOOL_NAMES) expect(name.startsWith("canvas_tree_")).toBe(true);
  });

  it("uses only the characters bb allows in a tool name", () => {
    for (const name of TREE_TOOL_NAMES) expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("registers each declared name exactly once", () => {
    const names = createTreeTools(depsOf(EXAMPLE)).map((tool) => tool.name);
    expect([...names].sort()).toEqual([...TREE_TOOL_NAMES].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it("describes every tool, since the description is all a cold model has", () => {
    for (const tool of createTreeTools(depsOf(EXAMPLE))) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});

describe("scope — which threads see these tools", () => {
  it("offers them in a thread linked to a shape that is a tree node", () => {
    expect(selectTreeTools(THREAD, depsOf(EXAMPLE))).toEqual([...TREE_TOOL_NAMES]);
  });

  it("offers nothing in a thread with no canvas link at all", () => {
    expect(selectTreeTools("thr_elsewhere", depsOf(EXAMPLE))).toEqual([]);
  });

  it("offers nothing when the linked shape is not a tree node", () => {
    const deps = depsOf(EXAMPLE, { [THREAD]: "shape:some-plain-note" });
    expect(selectTreeTools(THREAD, deps)).toEqual([]);
  });

  it("offers nothing once the linked node has been deleted from the canvas", () => {
    // The link outlives the shape: a human deletes the note, the kv row stays
    // until a sweep. The tools must follow the DOCUMENT, not the link.
    const deps = depsOf(EXAMPLE, { [THREAD]: "shape:deleted-yesterday" });
    expect(selectTreeTools(THREAD, deps)).toEqual([]);
  });
});

describe("the thread's own node is the default subject", () => {
  it("answers canvas_tree_node with no arguments at all", async () => {
    const { text, isError } = await call(depsOf(EXAMPLE), "canvas_tree_node");
    expect(isError).toBe(false);
    expect(text).toContain("shape:api");
    expect(text).toContain("Tree service");
  });

  it("digests the linked node's own tree with no arguments", async () => {
    const { text } = await call(depsOf(EXAMPLE), "canvas_tree_digest");
    expect(text).toContain(TREE);
    expect(text).toContain("4 nodes");
  });

  it("walks to the root from the linked node with no arguments", async () => {
    const { text } = await call(depsOf(EXAMPLE), "canvas_tree_path");
    // NEAREST FIRST, ROOT LAST, and asserted on the NUMBERED lines rather than
    // on where each id first appears: the answer's own header names the
    // starting node, so a plain indexOf comparison passed with the path
    // printed root-first (mutation, 2026-09-09).
    expect(text).toMatch(/^1\. shape:api\b/m);
    expect(text).toMatch(/^2\. shape:goal\b/m);
  });

  it("still answers about an explicitly named node in another part of the tree", async () => {
    const { text } = await call(depsOf(EXAMPLE), "canvas_tree_node", {
      nodeId: "shape:ui",
    });
    expect(text).toContain("Arrow renderer");
  });
});

describe("a thread whose link is gone mid-session", () => {
  // Tool sets apply at session start, so a session CAN outlive its link.
  const deps = depsOf(EXAMPLE, {});

  it("refuses a subject-less call, and names the trees it could read", async () => {
    const { text, isError } = await call(deps, "canvas_tree_digest");
    expect(isError).toBe(true);
    expect(text).toContain(TREE);
  });

  it("still answers when the call names its own node", async () => {
    const { text, isError } = await call(deps, "canvas_tree_node", {
      nodeId: "shape:goal",
    });
    expect(isError).toBe(false);
    expect(text).toContain("Ship discovery trees");
  });
});

describe("a miss is data, not a throw", () => {
  it("answers about a node the human deleted, without taking the tool down", async () => {
    const { text, isError } = await call(depsOf(EXAMPLE), "canvas_tree_node", {
      nodeId: "shape:deleted-last-week",
    });
    expect(isError).toBe(true);
    expect(text).toContain("shape:deleted-last-week");
    expect(text).toContain("no-such-node");
  });

  it("answers about a tree that is not there", async () => {
    const { text, isError } = await call(depsOf(EXAMPLE), "canvas_tree_ready", {
      treeId: "page:not-a-tree",
    });
    expect(isError).toBe(true);
    expect(text).toContain("no-such-tree");
  });
});

describe("readiness is the model's one definition", () => {
  const READY_ONCE_BLOCKERS_DONE: Spec = {
    nodes: { "shape:goal": "todo", "shape:api": "done", "shape:ui": "done" },
    edges: [["shape:api", "shape:goal"], ["shape:ui", "shape:goal"]],
  };

  it("calls a goal ready once every blocker under it is done", async () => {
    const deps = depsOf(READY_ONCE_BLOCKERS_DONE, { [THREAD]: "shape:goal" });
    const { text } = await call(deps, "canvas_tree_ready");
    expect(text).toContain("shape:goal");
  });

  it("says so on the node itself, not only in the list", async () => {
    const deps = depsOf(READY_ONCE_BLOCKERS_DONE, { [THREAD]: "shape:goal" });
    const { text } = await call(deps, "canvas_tree_node");
    expect(text.toLowerCase()).toContain("ready");
  });

  it("marks the ready nodes in a list, not only in the node answer", async () => {
    // A list line is where a model scanning blockers actually sees readiness;
    // dropping the mark left every list test green (mutation, 2026-09-09).
    const deps = depsOf(READY_ONCE_BLOCKERS_DONE, { [THREAD]: "shape:goal" });
    const { text } = await call(deps, "canvas_tree_ready");
    expect(text).toMatch(/shape:goal .*\(ready\)/);
  });

  it("says WHY a node is not ready, since done and blocked read the same as no", async () => {
    const deps = depsOf(READY_ONCE_BLOCKERS_DONE, { [THREAD]: "shape:api" });
    const done = await call(deps, "canvas_tree_node");
    expect(done.text).toContain("already done");
    const blocked = await call(depsOf(EXAMPLE), "canvas_tree_node", {
      nodeId: "shape:goal",
    });
    expect(blocked.text).toContain("unfinished");
  });

  it("agrees with the service, node for node", async () => {
    const deps = depsOf(EXAMPLE);
    const ready = deps.service.ready(TREE);
    if (!ready.ok) expect.unreachable("fixture tree should be readable");
    const { text } = await call(deps, "canvas_tree_ready");
    for (const node of ready.value) expect(text).toContain(node.id);
  });
});

describe("blockers, subtree and context — the shape of one answer", () => {
  it("lists the nodes that block this one", async () => {
    const { text } = await call(depsOf(EXAMPLE), "canvas_tree_children");
    expect(text).toContain("shape:schema");
    expect(text).not.toContain("shape:ui"); // ui blocks goal, not api
  });

  it("nests a subtree and says where it cut", async () => {
    const { text } = await call(depsOf(EXAMPLE), "canvas_tree_subtree", {
      nodeId: "shape:goal",
      depth: 1,
    });
    expect(text).toContain("shape:api");
    expect(text).not.toContain("shape:schema"); // two levels down, cut
    expect(text).toContain("depth");
  });

  it("hands back a node's whole context, which no digest ever carries", async () => {
    const spec: Spec = {
      ...EXAMPLE,
      context: { "shape:api": "Definition of done: every W5 query answered." },
    };
    const { text } = await call(depsOf(spec), "canvas_tree_node");
    expect(text).toContain("Definition of done: every W5 query answered.");
  });
});

describe("what the digest is forced to drop is still reachable — plan risk 1", () => {
  /** A tree far past the digest's 2000-char budget. */
  const BIG: Spec = (() => {
    const nodes: Record<string, "todo"> = { "shape:goal": "todo" };
    const edges: [string, string][] = [];
    for (let i = 0; i < 120; i += 1) {
      nodes[`shape:n${i}`] = "todo";
      edges.push([`shape:n${i}`, "shape:goal"]);
    }
    return { nodes, edges };
  })();

  it("truncates the digest on a big tree, and says so", async () => {
    const { text } = await call(depsOf(BIG, { [THREAD]: "shape:goal" }), "canvas_tree_digest");
    expect(text).toContain("not shown");
  });

  it("tells the model which tool recovers what the digest cut", async () => {
    const { text } = await call(depsOf(BIG, { [THREAD]: "shape:goal" }), "canvas_tree_digest");
    expect(text).toContain("canvas_tree_subtree");
  });

  it("reaches a node the digest could not name, through the tools", async () => {
    const deps = depsOf(BIG, { [THREAD]: "shape:goal" });
    const digest = await call(deps, "canvas_tree_digest");
    const missing = Object.keys(BIG.nodes).filter(
      (id) => id !== "shape:goal" && !digest.text.includes(id),
    );
    expect(missing.length).toBeGreaterThan(0);
    const answer = await call(deps, "canvas_tree_node", { nodeId: missing[0] });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain(missing[0]);
  });

  it("keeps every tool answer inside its ceiling, and says where it cut", async () => {
    // WIDE AND WORDY. The entry cap alone kept the earlier version of this
    // test under any ceiling, so removing the ceiling changed nothing
    // (mutation, 2026-09-09). Forty listed blockers of 400 characters each is
    // four times MAX_ANSWER_CHARS before the ceiling is applied.
    const nodes: Record<string, readonly ["todo", string]> = {
      "shape:goal": ["todo", "Ship it"],
    };
    const edges: [string, string][] = [];
    for (let i = 0; i < 60; i += 1) {
      nodes[`shape:w${i}`] = ["todo", "w".repeat(400)];
      edges.push([`shape:w${i}`, "shape:goal"]);
    }
    const deps = depsOf({ nodes, edges }, { [THREAD]: "shape:goal" });
    for (const name of TREE_TOOL_NAMES) {
      const { text } = await call(deps, name);
      expect(text.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS);
    }
    const { text } = await call(deps, "canvas_tree_children");
    expect(text).toContain("answer cut here");
  });

  it("says it truncated whenever it did", async () => {
    const deps = depsOf(BIG, { [THREAD]: "shape:goal" });
    const { text } = await call(deps, "canvas_tree_children", { nodeId: "shape:goal" });
    // 120 blockers cannot all fit; the answer must say what it left out.
    expect(text).toMatch(/not shown|more/);
  });
});

describe("freshness — the document is live under the reader", () => {
  it("sees a node added between two calls", async () => {
    let spec: Spec = { nodes: { "shape:goal": "todo" }, edges: [] };
    const deps: TreeToolDeps = {
      service: createTreeService({ document: () => docOf(spec) }),
      linkedShapeId: () => "shape:goal",
    };
    const before = await call(deps, "canvas_tree_children");
    expect(before.text).not.toContain("shape:new");
    spec = {
      nodes: { "shape:goal": "todo", "shape:new": "todo" },
      edges: [["shape:new", "shape:goal"]],
    };
    const after = await call(deps, "canvas_tree_children");
    expect(after.text).toContain("shape:new");
  });
});

describe("registration against bb", () => {
  /** The two bb.agents calls this node makes, captured. */
  function fakeBb() {
    const registered: string[] = [];
    let configure:
      | ((context: { thread: { id: string } }) => { tools: unknown[]; skills: unknown[] })
      | null = null;
    return {
      registered,
      configuration(threadId: string): { tools: unknown[]; skills: unknown[] } {
        if (configure === null) expect.unreachable("configure was never called");
        return configure({ thread: { id: threadId } });
      },
      selection(threadId: string): unknown[] {
        if (configure === null) expect.unreachable("configure was never called");
        return configure({ thread: { id: threadId } }).tools;
      },
      bb: {
        agents: {
          registerTool(tool: { name: string }) {
            registered.push(tool.name);
          },
          configure(
            provider: (context: { thread: { id: string } }) => {
              tools: unknown[];
              skills: unknown[];
            },
          ) {
            configure = provider;
          },
        },
      },
    };
  }

  it("registers every tool once and installs exactly one selector", () => {
    const fake = fakeBb();
    registerTreeAgentTools(fake.bb as never, depsOf(EXAMPLE));
    expect([...fake.registered].sort()).toEqual([...TREE_TOOL_NAMES].sort());
  });

  it("selects the tools for a tree thread and nothing for any other", () => {
    const fake = fakeBb();
    registerTreeAgentTools(fake.bb as never, depsOf(EXAMPLE));
    expect(fake.selection(THREAD)).toEqual([...TREE_TOOL_NAMES]);
    expect(fake.selection("thr_elsewhere")).toEqual([]);
  });

  it("claims no skills, because this plugin ships none for a tree thread", () => {
    const fake = fakeBb();
    registerTreeAgentTools(fake.bb as never, depsOf(EXAMPLE));
    expect(fake.configuration(THREAD).skills).toEqual([]);
  });
});

/** The service the deps carry is the real one, not a stand-in. */
describe("wiring sanity", () => {
  it("is built over a TreeService", () => {
    const deps = depsOf(EXAMPLE);
    const service: TreeService = deps.service;
    expect(service.trees()).toEqual([TREE]);
  });
});
