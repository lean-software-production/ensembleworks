// Run: npx vitest run tests/tree-instructions.test.ts
//
// W7's gate. `bb.agents.contributeInstructions` is the only tree surface an
// agent gets WITHOUT asking for it: bb appends this text to the thread's
// instructions at thread start, so a model arrives already oriented instead of
// having to spend its first tool call finding out where it is.
//
// What these tests are aimed at, because they are the ways an ambient brief
// goes wrong:
//
//  1. SILENCE IS THE DEFAULT. Every thread on the bb server resolves this
//     provider. A thread that is not about a tree node must contribute
//     NOTHING — not a "no tree here" paragraph, which would be a permanent tax
//     on every unrelated thread in the project.
//  2. THE 4096 CEILING IS THE HOST'S, AND IT TRUNCATES SILENTLY. bb cuts the
//     string at 4096 characters with no marker. A brief that relied on that
//     cut would lose its own "this is incomplete" sentence — exactly the
//     failure C1 found inside the digest. This module bounds itself.
//  3. WHAT SURVIVES TRUNCATION MUST BE WHAT ORIENTS. Plan risk 1: on a big
//     tree the digest degrades. The part that must not degrade is the thread's
//     OWN node, its path to root, and its immediate blockers — without those
//     the model does not know what it is looking at.
//  4. THE TEXT NEVER CLAIMS COMPLETENESS IT DOES NOT HAVE. A truncated brief
//     says so, in the text, and names the tools that recover what it dropped.
//  5. NO HIDDEN STATE. There is no "what changed since last turn" line, and
//     the absence is load-bearing: see w7-per-turn-digest.md. Two calls over
//     one document return identical text.
import { describe, expect, it } from "vitest";
import {
  INSTRUCTIONS_MAX_CHARS,
  treeInstructions,
  type TreeInstructionDeps,
} from "../canvas/tree/instructions.js";
import {
  TREE_TOOL_NAMES,
  registerTreeAgentTools,
  treeThreadSubject,
  type TreeToolDeps,
} from "../canvas/tree/agent-tools.js";
import { NODE_DIRECTIVE_SYNTAX } from "../canvas/tree/node-reference.js";
import {
  EXAMPLE,
  TREE,
  fixtureRepairTarget,
  serviceOf,
  writerOf,
  type Spec,
} from "./lib/tree-fixture.js";

const THREAD = "thr_linked";

/** Instruction deps over a fixed document, resolving the subject exactly the
 * way the registration does — through W6's document-following resolver. */
function depsOf(
  spec: Spec,
  links: Readonly<Record<string, string>> = { [THREAD]: "shape:api" },
): TreeInstructionDeps {
  const toolDeps: TreeToolDeps = {
    service: serviceOf(spec),
    writer: writerOf(spec),
    repair: fixtureRepairTarget(spec),
    linkedShapeId: (threadId) => links[threadId] ?? null,
  };
  return {
    service: toolDeps.service,
    subject: (threadId) => treeThreadSubject(threadId, toolDeps),
  };
}

/** The brief, asserted to exist. */
function brief(deps: TreeInstructionDeps, threadId = THREAD, maxChars?: number): string {
  const text = treeInstructions(threadId, deps, maxChars);
  if (text === null) expect.unreachable(`no instructions for ${threadId}`);
  return text;
}

/** A chain: `shape:n0` is the root, every `shape:n(i+1)` blocks `shape:n(i)`.
 * Long titles on purpose — a real tree's notes are sentences, and a brief that
 * only fits when every title is short is a brief that fits nothing real. */
function chain(length: number, titleChars: number): Spec {
  const nodes: Record<string, readonly ["todo", string]> = {};
  const edges: (readonly [string, string])[] = [];
  for (let i = 0; i < length; i += 1) {
    nodes[`shape:n${i}`] = ["todo", `${"long title ".repeat(titleChars / 11)}${i}`];
    if (i > 0) edges.push([`shape:n${i}`, `shape:n${i - 1}`] as const);
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// 1. Silence is the default
// ---------------------------------------------------------------------------

describe("a thread that is not about a tree node contributes nothing", () => {
  it("is silent when the thread has no linked shape at all", () => {
    expect(treeInstructions("thr_elsewhere", depsOf(EXAMPLE))).toBeNull();
  });

  it("is silent when the thread is linked to a shape that is not a tree node", () => {
    const deps = depsOf(EXAMPLE, { [THREAD]: "shape:not-a-node" });
    expect(treeInstructions(THREAD, deps)).toBeNull();
  });

  it("is silent when the linked node was deleted, because scope follows the document", () => {
    const deps = depsOf(EXAMPLE, { [THREAD]: "shape:deleted-yesterday" });
    expect(treeInstructions(THREAD, deps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. What the brief says, and what survives when it cannot say all of it
// ---------------------------------------------------------------------------

describe("the brief orients a model that has not called a tool yet", () => {
  it("names the thread's own node, its title and its state", () => {
    const text = brief(depsOf(EXAMPLE));
    expect(text).toMatch(/^node: shape:api — Tree service \[wip]/m);
  });

  it("marks the node ready when it is ready, using the model's one definition", () => {
    const deps = depsOf(EXAMPLE, { [THREAD]: "shape:schema" });
    expect(brief(deps)).toMatch(/^node: shape:schema .*\(ready\)/m);
  });

  it("carries the path to root, nearest first, so the model knows what this is for", () => {
    const text = brief(depsOf(EXAMPLE));
    expect(text).toMatch(/^up to root: shape:api > shape:goal$/m);
  });

  it("lists the node's immediate blockers", () => {
    const text = brief(depsOf(EXAMPLE));
    expect(text).toMatch(/^blocked by 1 \(canvas_tree_children lists them all\):$/m);
    expect(text).toMatch(/^ {2}- shape:schema — Encoding contract \[todo] \(ready\)$/m);
  });

  it("says so plainly when nothing blocks the node", () => {
    const deps = depsOf(EXAMPLE, { [THREAD]: "shape:schema" });
    expect(brief(deps)).toMatch(/^blocked by: nothing/m);
  });

  it("carries the whole-tree digest under the node's own orientation", () => {
    const text = brief(depsOf(EXAMPLE));
    expect(text).toContain(`tree ${TREE} — 4 nodes`);
    expect(text.indexOf("node: shape:api")).toBeLessThan(text.indexOf(`tree ${TREE} —`));
  });

  it("answers a cyclic tree without throwing, and says the path is unavailable", () => {
    const cyclic: Spec = {
      nodes: { "shape:a": "todo", "shape:b": "todo", "shape:api": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:a"],
        ["shape:api", "shape:a"],
      ],
    };
    const text = brief(depsOf(cyclic));
    expect(text).toMatch(/^up to root: unavailable/m);
    expect(text).toContain("cycle");
  });
});

describe("a big tree degrades without losing the part that orients", () => {
  const big = chain(250, 300);
  const deps = () => depsOf(big, { [THREAD]: "shape:n125" });

  it("never exceeds the host's 4096-character ceiling", () => {
    expect(brief(deps()).length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });

  it("never exceeds the budget, whatever the budget is", () => {
    for (const budget of [200, 500, 1_000, 2_000, INSTRUCTIONS_MAX_CHARS]) {
      const text = treeInstructions(THREAD, deps(), budget);
      expect(text === null ? 0 : text.length).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps the node, its path and its blockers even when the digest cannot fit", () => {
    const text = brief(deps());
    expect(text).toMatch(/^node: shape:n125/m);
    expect(text).toMatch(/^up to root: shape:n125 > /m);
    expect(text).toMatch(/^blocked by 1 \(canvas_tree_children lists them all\):$/m);
    expect(text).toMatch(/^ {2}- shape:n126/m);
  });

  it("does not let one enormous title spend the whole budget", () => {
    // The subject's own title is four budgets long. It must be cut, not
    // allowed to evict the path, the blockers and the digest below it.
    const huge: Spec = {
      nodes: {
        "shape:goal": ["todo", "G"],
        "shape:api": ["todo", "T".repeat(INSTRUCTIONS_MAX_CHARS * 4)],
        "shape:schema": ["todo", "S"],
      },
      edges: [
        ["shape:api", "shape:goal"],
        ["shape:schema", "shape:api"],
      ],
    };
    const text = brief(depsOf(huge));
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
    expect(text).toMatch(/^up to root:/m);
    expect(text).toMatch(/^blocked by /m);
  });

  it("caps the blocker list rather than letting it starve the digest", () => {
    const wide: Spec = {
      nodes: {
        "shape:api": ["todo", "Tree service"],
        ...Object.fromEntries(
          Array.from({ length: 30 }, (_, i) => [
            `shape:b${i}`,
            ["todo", `blocker ${i} ${"x".repeat(200)}`] as const,
          ]),
        ),
      },
      edges: Array.from({ length: 30 }, (_, i) => [`shape:b${i}`, "shape:api"] as const),
    };
    const text = brief(depsOf(wide));
    // The count is in front of the list, where a per-line clamp cannot reach it.
    expect(text).toMatch(/^blocked by 30 \(canvas_tree_children lists them all\):$/m);
    expect(text).toContain(`tree ${TREE} —`);
  });
});

/**
 * A node with `count` blockers, each titled `titleChars` long, and nothing
 * else. Small enough that the DIGEST fits whole — which is what makes these
 * three tests about the blocker list rather than about the tree.
 */
function wide(count: number, titleChars: number, done = 0): Spec {
  return {
    nodes: {
      "shape:api": ["todo", "Tree service"],
      ...Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `shape:b${i}`,
          // `done` of them are finished. Not decoration: a todo blocker is a
          // READY node, and more than ten ready nodes truncates the digest all
          // by itself (READY_IN_DIGEST) — which is what let the "capped
          // blockers are not an omission" mutation survive its first test.
          [i < done ? "done" : "todo", `b${i} ${"x".repeat(titleChars)}`] as const,
        ]),
      ),
    },
    edges: Array.from({ length: count }, (_, i) => [`shape:b${i}`, "shape:api"] as const),
  };
}

/** The three properties of the blocker list that each survived a mutation of
 * their own in the first round — see w7-per-turn-digest.md. Each is asserted
 * on a tree whose digest FITS, so nothing else can be what makes the brief
 * partial or what pushes the digest out. */
describe("the blocker list is bounded three ways, and each bound is load-bearing", () => {
  it("counts a capped blocker list as an omission, even when the tree itself fits", () => {
    const text = brief(depsOf(wide(12, 8, 4)));
    // The digest is whole: 13 short nodes, 8 of them ready (under the digest's
    // own ready cap). The ONLY thing left out is the two blockers past this
    // module's cap, so the closing sentence must still admit it.
    expect(text).toContain(`tree ${TREE} — 13 nodes`);
    expect(text).not.toContain("lines not shown");
    expect(text).not.toMatch(/ready:.*more/);
    expect(text).toContain("INCOMPLETE");
  });

  it("lists exactly the cap, so a wide node cannot spend the orientation", () => {
    const text = brief(depsOf(wide(12, 8, 4)));
    // Counted in the ORIENTATION only: the digest's outline below uses the
    // same `  - id [state]` line shape, and counting both was this test's own
    // first bug.
    const orientation = text.slice(0, text.indexOf(`tree ${TREE} —`));
    const listed = orientation.split("\n").filter((line) => /^ {2}- shape:b\d+ /.test(line));
    expect(listed).toHaveLength(10);
    expect(text).toMatch(/^blocked by 12 \(canvas_tree_children lists them all\):$/m);
  });

  it("leaves the tree room even when every blocker is long", () => {
    // Ten 600-character blocker lines are more than a whole brief. The
    // orientation's SHARE of the budget is what stops them taking it all, so
    // that is what this asserts directly — a downstream "is the digest still
    // there" check passed even with the share removed, because a digest cut to
    // 30 characters is still a digest.
    const text = brief(depsOf(wide(30, 600)));
    const orientation = text.slice(0, text.indexOf(`tree ${TREE} —`));
    expect(orientation.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS / 2);
    expect(text).toContain(`tree ${TREE} — 31 nodes`);
    expect(text).toMatch(/^ready:/m);
  });
});

// ---------------------------------------------------------------------------
// 4. The text never claims completeness it does not have
// ---------------------------------------------------------------------------

describe("the brief is honest about what it left out", () => {
  it("says it is incomplete, and names the tools that recover the rest", () => {
    const text = brief(depsOf(chain(250, 300), { [THREAD]: "shape:n125" }));
    expect(text).toContain("INCOMPLETE");
    for (const tool of ["canvas_tree_subtree", "canvas_tree_children", "canvas_tree_ready"]) {
      expect(text).toContain(tool);
    }
  });

  it("never drops the incompleteness sentence, however small the budget", () => {
    const deps = depsOf(chain(250, 300), { [THREAD]: "shape:n125" });
    for (const budget of [300, 600, 1_200]) {
      const text = treeInstructions(THREAD, deps, budget);
      expect(text === null ? "" : text).toContain("INCOMPLETE");
    }
  });

  it("does not cry incomplete on a small tree it showed whole", () => {
    const text = brief(depsOf(EXAMPLE));
    expect(text).not.toContain("INCOMPLETE");
    expect(text).toContain("canvas_tree_node");
  });

  it("still points at canvas_tree_node, because context notes are never in a brief", () => {
    const withContext: Spec = { ...EXAMPLE, context: { "shape:api": "the whole definition of done" } };
    const text = brief(depsOf(withContext));
    expect(text).not.toContain("the whole definition of done");
    expect(text).toContain("canvas_tree_node");
  });
});

// ---------------------------------------------------------------------------
// 4b. The reply half — W9
// ---------------------------------------------------------------------------

describe("the brief teaches the one thing an agent cannot discover from a tool", () => {
  // W9 makes `::node{id="…"}` in a reply render as a card that takes a human
  // to that node on the canvas. A model that does not know the syntax never
  // emits it, and nothing in a tool's answer can teach it: the tools speak
  // about the tree, not about how bb renders a message. The brief is the one
  // ambient surface a tree thread already has, so it is where the syntax
  // belongs — one sentence, in the same reserved tail as the closing line.
  it("names the directive, with its attribute", () => {
    const text = brief(depsOf(EXAMPLE));
    expect(text).toContain(NODE_DIRECTIVE_SYNTAX);
  });

  it("keeps the syntax even when the tree crowds the brief out", () => {
    // The reserve is the point: a model on a big tree is the one MOST likely
    // to want to point a human at a specific node.
    const deps = depsOf(chain(250, 300), { [THREAD]: "shape:n125" });
    for (const budget of [900, 2_000, INSTRUCTIONS_MAX_CHARS]) {
      const text = treeInstructions(THREAD, deps, budget);
      expect(text === null ? "" : text).toContain(NODE_DIRECTIVE_SYNTAX);
    }
  });

  it("drops the syntax before it drops the incompleteness sentence", () => {
    // A budget that holds neither both sentences nor any tree is pathological
    // — the real ceiling is 4096 — but the RANKING is not: a brief that stayed
    // quiet about being incomplete in order to teach a syntax would be lying
    // about itself, and at that size there is barely a tree to point into.
    const text = treeInstructions(THREAD, depsOf(chain(250, 300), { [THREAD]: "shape:n125" }), 300);
    expect(text === null ? "" : text).toContain("INCOMPLETE");
    expect(text === null ? "" : text).not.toContain(NODE_DIRECTIVE_SYNTAX);
  });

  it("still fits the host's ceiling with the sentence in it", () => {
    const text = brief(depsOf(chain(250, 300), { [THREAD]: "shape:n125" }));
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });
});

// ---------------------------------------------------------------------------
// 5. No hidden state
// ---------------------------------------------------------------------------

describe("the brief is a pure read of the document", () => {
  it("returns the same text twice over an unchanged document", () => {
    const deps = depsOf(EXAMPLE);
    expect(treeInstructions(THREAD, deps)).toBe(treeInstructions(THREAD, deps));
  });

  it("is synchronous, because it sits on the thread-start path", () => {
    const text: string | null = treeInstructions(THREAD, depsOf(EXAMPLE));
    expect(text).not.toBeInstanceOf(Promise);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration against bb", () => {
  function fakeBb() {
    const registered: string[] = [];
    let instructions: ((ctx: { threadId: string; projectId: string }) => string | null) | null = null;
    let instructionRegistrations = 0;
    return {
      registered,
      instructionRegistrations: () => instructionRegistrations,
      contribution(threadId: string): string | null {
        if (instructions === null) expect.unreachable("contributeInstructions was never called");
        return instructions({ threadId, projectId: "proj_test" });
      },
      bb: {
        agents: {
          registerTool(tool: { name: string }) {
            registered.push(tool.name);
          },
          configure() {},
          contributeInstructions(provider: (ctx: { threadId: string; projectId: string }) => string | null) {
            instructionRegistrations += 1;
            instructions = provider;
          },
        },
      },
    };
  }

  /** The tool deps the registration takes — the same value server.ts builds. */
  function toolDepsOf(links: Readonly<Record<string, string>>): TreeToolDeps {
    return {
      service: serviceOf(EXAMPLE),
      writer: writerOf(EXAMPLE),
      repair: fixtureRepairTarget(EXAMPLE),
      linkedShapeId: (threadId) => links[threadId] ?? null,
    };
  }

  it("installs exactly one instruction provider alongside the tools", () => {
    const fake = fakeBb();
    registerTreeAgentTools(fake.bb as never, toolDepsOf({ [THREAD]: "shape:api" }));
    expect(fake.instructionRegistrations()).toBe(1);
    expect([...fake.registered].sort()).toEqual([...TREE_TOOL_NAMES].sort());
  });

  it("contributes the brief to a tree thread and nothing to any other", () => {
    const fake = fakeBb();
    registerTreeAgentTools(fake.bb as never, toolDepsOf({ [THREAD]: "shape:api" }));
    expect(fake.contribution(THREAD)).toContain("shape:api");
    expect(fake.contribution("thr_elsewhere")).toBeNull();
  });

  it("contributes nothing longer than bb will keep", () => {
    const fake = fakeBb();
    registerTreeAgentTools(fake.bb as never, toolDepsOf({ [THREAD]: "shape:api" }));
    expect((fake.contribution(THREAD) ?? "").length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });
});
