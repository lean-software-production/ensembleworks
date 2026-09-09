// Run: npx vitest run tests/tree-launch.test.ts
//
// W12's decisions, without a DOM: what a thread launched on a node is told,
// and when the arm that launches it is offered.
//
// THE ONE THING THIS SUITE IS REALLY GUARDING is that the launch prompt is
// SELF-SUFFICIENT. W7 contributes an orientation brief to any thread whose
// linked shape is a tree node — but the link is only recorded once
// `threads.spawn` RESOLVES, and spawn starts turn 1. So turn 1 of a launched
// thread has no tree tools and no brief (tests/tree-launch-rpc.test.ts proves
// that ordering at the seam). The prompt is what turn 1 has.
import { describe, expect, it } from "vitest";
import { threadTitleFor } from "../canvas/agents.js";
import {
  LAUNCH_PROMPT_MAX_CHARS,
  launchBrief,
  workArmFor,
} from "../canvas/tree/launch.js";
import { MAX_CONTEXT_LENGTH } from "../canvas/tree/encoding.js";
import type { TreeService } from "../canvas/tree/service.js";
import { EXAMPLE, TREE, docOf, serviceOf } from "./lib/tree-fixture.js";
import { createTreeService } from "../canvas/tree/service.js";

const briefOf = (service: TreeService, nodeId: string) => {
  const read = launchBrief(nodeId, service);
  if (!read.ok) expect.unreachable(`refused: ${read.why}`);
  return read.value;
};

const withContext = (context: Record<string, string>): TreeService =>
  createTreeService({ document: () => docOf({ ...EXAMPLE, context }) });

describe("launchBrief", () => {
  it("names the node it is about, in the same words every other tree answer uses", () => {
    const { prompt } = briefOf(serviceOf(EXAMPLE), "shape:api");
    expect(prompt).toContain("shape:api — Tree service [wip]");
  });

  it("carries the path to root, so turn 1 knows why the work exists", () => {
    const { prompt } = briefOf(serviceOf(EXAMPLE), "shape:api");
    expect(prompt).toContain("up to root: shape:api > shape:goal");
  });

  it("carries what blocks the node, so turn 1 knows what is in the way", () => {
    const { prompt } = briefOf(serviceOf(EXAMPLE), "shape:api");
    expect(prompt).toContain("blocked by 1");
    expect(prompt).toContain("shape:schema — Encoding contract [todo] (ready)");
  });

  it("carries the node's context note VERBATIM — the one thing W7 never carries", () => {
    const note = "Goal: one query surface.\nDone when: the six reads answer off room.doc.";
    const { prompt } = briefOf(withContext({ "shape:api": note }), "shape:api");
    expect(prompt).toContain(note);
  });

  it("says out loud when nobody wrote a context note, and tells the thread to ask", () => {
    const { prompt } = briefOf(serviceOf(EXAMPLE), "shape:api");
    expect(prompt).toMatch(/no context note/i);
    expect(prompt).toMatch(/ask/i);
  });

  it("titles the thread from the NODE, not from the prompt's own first words", () => {
    const { title } = briefOf(serviceOf(EXAMPLE), "shape:api");
    expect(title).toBe(threadTitleFor("Tree service"));
    expect(title).toBe("Canvas: Tree service");
  });

  it("titles an untitled node with the one word every other answer uses for it", () => {
    const bare = createTreeService({
      document: () => docOf({ nodes: { "shape:bare": "todo" }, edges: [] }),
    });
    expect(briefOf(bare, "shape:bare").title).toBe("Canvas: (untitled)");
  });

  it("refuses a node the tree does not have, in the service's own sentence", () => {
    const read = launchBrief("shape:ghost", serviceOf(EXAMPLE));
    if (read.ok) expect.unreachable("a missing node produced a brief");
    expect(read.why).toContain("shape:ghost");
  });

  it("stays under the prompt ceiling even against the biggest context the encoding allows", () => {
    const huge = "x".repeat(MAX_CONTEXT_LENGTH);
    const { prompt } = briefOf(withContext({ "shape:api": huge }), "shape:api");
    expect(prompt.length).toBeLessThanOrEqual(LAUNCH_PROMPT_MAX_CHARS);
  });

  it("says the brief is incomplete when it cut something, and names the recovery", () => {
    const huge = "x".repeat(MAX_CONTEXT_LENGTH);
    const { prompt } = briefOf(withContext({ "shape:api": huge }), "shape:api");
    expect(prompt).toContain("INCOMPLETE");
    expect(prompt).toContain("canvas_tree_node");
  });

  it("does not claim to be incomplete when it showed everything", () => {
    const { prompt } = briefOf(withContext({ "shape:api": "short" }), "shape:api");
    expect(prompt).not.toContain("INCOMPLETE");
  });

  it("keeps the node's own orientation when a very long context would have eaten it", () => {
    const huge = "x".repeat(MAX_CONTEXT_LENGTH);
    const { prompt } = briefOf(withContext({ "shape:api": huge }), "shape:api");
    expect(prompt).toContain("up to root: shape:api > shape:goal");
  });

  it("keeps the context when a very long path would have eaten it", () => {
    // A hundred-deep chain: W7's orientation alone would fill the budget.
    const ids = Array.from({ length: 100 }, (_, i) => `shape:n${i}`);
    const deep = createTreeService({
      document: () =>
        docOf({
          nodes: Object.fromEntries(ids.map((id) => [id, "todo" as const])),
          edges: ids.slice(1).map((id, i) => [id, ids[i] as string] as const),
          context: { [ids[ids.length - 1] as string]: "the note that must survive" },
        }),
    });
    const { prompt } = briefOf(deep, ids[ids.length - 1] as string);
    expect(prompt).toContain("the note that must survive");
    expect(prompt.length).toBeLessThanOrEqual(LAUNCH_PROMPT_MAX_CHARS);
  });

  // THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. "Orientation takes the whole
  // budget" (M6) left the 100-deep-path test above green: `fitLines` already
  // clamps ONE line to an eighth of its budget, so a single enormous path line
  // can never starve anything. What ORIENTATION_SHARE actually bounds is the
  // number of lines — a node with ten long-titled blockers, which is an
  // ordinary tree, not a pathological one.
  it("keeps the context when a wide blocker list would have eaten it", () => {
    const wide = "shape:wide";
    const blockers = Array.from({ length: 10 }, (_, i) => `shape:b${i}`);
    const service = createTreeService({
      document: () =>
        docOf({
          nodes: {
            [wide]: ["todo", "The node being launched"] as const,
            ...Object.fromEntries(
              blockers.map((id) => [id, ["todo", "b".repeat(400)] as const]),
            ),
          },
          edges: blockers.map((id) => [id, wide] as const),
          context: { [wide]: "the note that must survive a wide blocker list" },
        }),
    });
    const { prompt } = briefOf(service, wide);
    expect(prompt).toContain("the note that must survive a wide blocker list");
    expect(prompt.length).toBeLessThanOrEqual(LAUNCH_PROMPT_MAX_CHARS);
  });

  it("builds a brief for a node inside a cycle rather than refusing one", () => {
    const cyclic = createTreeService({
      document: () =>
        docOf({
          nodes: { "shape:a": "todo", "shape:b": "todo" },
          edges: [["shape:a", "shape:b"], ["shape:b", "shape:a"]],
          treeId: TREE,
        }),
    });
    const { prompt } = briefOf(cyclic, "shape:a");
    expect(prompt).toContain("up to root: unavailable");
  });
});

describe("workArmFor", () => {
  it("is not offered when nothing is selected", () => {
    expect(workArmFor(null, false)).toBeNull();
  });

  it("is greyed with the reason on a shape that is not a tree node", () => {
    const arm = workArmFor({ shapeId: "shape:plain", treeId: null }, false);
    expect(arm?.enabled).toBe(false);
    expect(arm?.reason).not.toBe("");
  });

  it("is offered on a tree node", () => {
    const arm = workArmFor({ shapeId: "shape:api", treeId: TREE }, false);
    expect(arm?.enabled).toBe(true);
    expect(arm?.reason).toBe("");
  });

  it("says AGAIN when the node already carries a thread, rather than refusing", () => {
    const first = workArmFor({ shapeId: "shape:api", treeId: TREE }, false);
    const again = workArmFor({ shapeId: "shape:api", treeId: TREE }, true);
    expect(again?.enabled).toBe(true);
    expect(again?.label).not.toBe(first?.label);
  });
});
