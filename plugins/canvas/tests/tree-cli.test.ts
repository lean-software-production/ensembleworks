// Run: npx vitest run tests/tree-cli.test.ts
//
// W13's gate. `bb canvas tree` is the discovery tree for a reader who has NO
// bb tool session — a Claude Code session in a canvas terminal, a human at a
// prompt. It answers the same questions W5 already answers, so the risk here
// is not the tree logic (W1/W5 own that, and their suites guard it) but the
// three things a CLI can get wrong on its own:
//
//  1. IT READS THE TREE THROUGH W5, not through a second reader. Every
//     assertion below that names a node's state, readiness or blockers is
//     really an assertion that the service answered — the source guard in
//     tree-cli-wiring.test.ts pins the structural half of that claim.
//  2. THERE IS NO DEFAULT SUBJECT. The agent tools default to "the node this
//     thread was launched on"; the CLI has no thread and no link, so it has
//     to resolve a tree from the DOCUMENT (the single tree, or an explicit
//     id) and refuse — listing the candidates — when it cannot.
//  3. A HUMAN AND A MACHINE READ THE SAME RUN DIFFERENTLY. Human output is an
//     indented outline with a legend; `--json` is the service's own plain
//     values. Both are tested, because a CLI whose --json is a stringified
//     paragraph is not a machine surface.
import { describe, expect, it } from "vitest";
import {
  TREE_CLI_USAGE,
  runTreeCli,
  type TreeCliDeps,
} from "../canvas/tree/cli-view.js";
import type { QuarantinedEdge } from "../canvas/tree/repair.js";
import { createTreeService } from "../canvas/tree/service.js";
import type { TreeWrite } from "../canvas/tree/writes.js";
import { EXAMPLE, TREE, docOf, type Spec } from "./lib/tree-fixture.js";

/**
 * The CLI over a fixture document. `quarantined`/`restore` are stubs a test
 * arms per case: the real ones are `repair.ts`'s, guarded by
 * tree-repair.test.ts, and re-testing them here would be testing W11 twice.
 */
function cliFor(
  spec: Spec = EXAMPLE,
  options?: {
    quarantined?: readonly QuarantinedEdge[];
    restore?: (edgeId: string) => TreeWrite<{ edgeId: string; treeId: string }>;
  },
): TreeCliDeps {
  const document = docOf(spec);
  const restore = options?.restore;
  return {
    service: createTreeService({ document: () => document }),
    quarantined: (treeId) =>
      (options?.quarantined ?? []).filter(
        (entry) => treeId === undefined || entry.quarantine.tree === treeId,
      ),
    restore: (edgeId) =>
      restore
        ? restore(edgeId)
        : { ok: false, reason: "no-such-node", detail: `no shape ${edgeId} in this document` },
  };
}

/** A run, with `stdout`/`stderr` defaulted to "" — `PluginCliResult` leaves
 * both optional, and every assertion below is about what was PRINTED. */
const run = (argv: string[], deps: TreeCliDeps = cliFor()) => {
  const result = runTreeCli(argv, deps);
  return { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** A quarantine record shaped like the ones `reparent` leaves behind. */
const parked = (edgeId: string, tree = TREE, detail = "shape:ui was moved"): QuarantinedEdge =>
  ({
    edgeId,
    shape: { id: edgeId } as QuarantinedEdge["shape"],
    quarantine: { v: 1, tree, reason: "reparented", detail },
  }) as QuarantinedEdge;

// ---------------------------------------------------------------------------
// Which trees are there
// ---------------------------------------------------------------------------

describe("bb canvas tree — the tree list", () => {
  it("summarises every tree in the document: size, frontier and health", () => {
    const result = run([]);

    expect(result.exitCode).toBe(0);
    // One line per tree, the id first so it can be copied into the next call.
    expect(result.stdout).toContain(TREE);
    expect(result.stdout).toContain("4 nodes");
    expect(result.stdout).toContain("3 edges");
    expect(result.stdout).toContain("2 ready");
    // A clean tree says so — "0 problems" reads like a missing number.
    expect(result.stdout).toContain("no problems");
  });

  it("counts the problems on a tree that has them", () => {
    const broken = cliFor({
      nodes: { "shape:a": "todo", "shape:b": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:a"],
      ],
    });

    expect(run([], broken).stdout).toMatch(/\d+ problems?/);
  });

  it("says the canvas has no trees rather than printing nothing", () => {
    const empty = cliFor({ nodes: {}, edges: [], markPage: false });

    const result = run([], empty);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No tree pages on this canvas.");
  });

  it("answers --json with the counts as data, not as a sentence", () => {
    const result = run(["--json"]);

    expect(JSON.parse(result.stdout)).toEqual([
      {
        treeId: TREE,
        counts: { nodes: 4, todo: 3, wip: 1, done: 0, edges: 3, problems: 0 },
        roots: ["shape:goal"],
        ready: ["shape:schema", "shape:ui"],
        problems: [],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The outline
// ---------------------------------------------------------------------------

describe("bb canvas tree show — the outline", () => {
  it("indents blockers under what they block, with a legend a reader can act on", () => {
    const result = run(["show"]);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    const goal = lines.find((line) => line.includes("shape:goal"));
    const api = lines.find((line) => line.includes("shape:api"));
    const schema = lines.find((line) => line.includes("shape:schema"));
    expect(goal).toBeDefined();
    // Deeper indent = "blocks the line above". This is the whole reading rule.
    expect(api?.match(/^ */)?.[0].length).toBeGreaterThan(
      goal?.match(/^ */)?.[0].length ?? 0,
    );
    expect(schema?.match(/^ */)?.[0].length).toBeGreaterThan(
      api?.match(/^ */)?.[0].length ?? 0,
    );
    // The titles a human reads on the canvas, not just ids.
    expect(result.stdout).toContain("Ship discovery trees");
    // State and readiness are visible per line, and the legend explains them.
    expect(api).toContain("[~]");
    expect(schema).toContain("(ready)");
    expect(result.stdout).toContain("indent = blocks the line above");
  });

  it("takes a NODE id and shows the branch under it", () => {
    const result = run(["show", "shape:api"]);

    expect(result.stdout).toContain("shape:api");
    expect(result.stdout).toContain("shape:schema");
    // shape:ui blocks the goal, not the api — a branch is not the whole tree.
    expect(result.stdout).not.toContain("shape:ui");
  });

  it("cuts at --depth and names the command that reads further", () => {
    const result = run(["show", "--depth", "1"]);

    expect(result.stdout).toContain("shape:api");
    expect(result.stdout).not.toContain("shape:schema");
    expect(result.stdout).toContain("bb canvas tree show shape:api");
  });

  it("answers --json with the service's own subtree values", () => {
    const parsed = JSON.parse(run(["show", "shape:api", "--json"]).stdout) as {
      node: { id: string; state: string; isReady: boolean };
      children: readonly { node: { id: string } }[];
      elided: string | null;
    };

    expect(parsed.node.id).toBe("shape:api");
    expect(parsed.node.state).toBe("wip");
    expect(parsed.children.map((child) => child.node.id)).toEqual(["shape:schema"]);
    expect(parsed.elided).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One node
// ---------------------------------------------------------------------------

describe("bb canvas tree node — one node in full", () => {
  it("prints the whole context note, which no outline carries", () => {
    const withContext = cliFor({
      ...EXAMPLE,
      context: { "shape:api": "Definition of done: six queries, one module." },
    });

    const result = run(["node", "shape:api"], withContext);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Definition of done: six queries, one module.");
    expect(result.stdout).toContain("blocks:     shape:goal");
    expect(result.stdout).toContain("blocked by: shape:schema");
  });

  it("fails with the service's own sentence on an id that is not a node", () => {
    const result = run(["node", "shape:nope"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no-such-node");
    expect(result.stderr).toContain("shape:nope");
    expect(result.stdout).toBe("");
  });

  it("wants an id — there is no thread here to default one from", () => {
    const result = run(["node"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bb canvas tree node <NODE>");
  });
});

// ---------------------------------------------------------------------------
// The frontier
// ---------------------------------------------------------------------------

describe("bb canvas tree ready — what could be started now", () => {
  it("lists every ready node, not just the leaves", () => {
    const result = run(["ready"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shape:schema");
    expect(result.stdout).toContain("shape:ui");
    expect(result.stdout).not.toContain("shape:goal");
  });

  it("says so when nothing is startable", () => {
    const allDone = cliFor({
      nodes: { "shape:goal": "done", "shape:api": "done" },
      edges: [["shape:api", "shape:goal"]],
    });

    expect(run(["ready"], allDone).stdout).toContain("Nothing is ready");
  });

  it("answers --json with the node views", () => {
    const parsed = JSON.parse(run(["ready", "--json"]).stdout) as readonly { id: string }[];
    expect(parsed.map((view) => view.id)).toEqual(["shape:schema", "shape:ui"]);
  });
});

// ---------------------------------------------------------------------------
// Resolving which tree — the CLI's own problem
// ---------------------------------------------------------------------------

describe("which tree a tree-addressed command is about", () => {
  const twoTrees = () => {
    const one = docOf({ ...EXAMPLE, treeId: "page:one" });
    const two = docOf({
      nodes: { "shape:other": "todo" },
      edges: [],
      treeId: "page:two",
    });
    const merged = {
      ...one,
      pages: [...one.pages, ...two.pages],
      shapes: [...one.shapes, ...two.shapes],
      bindings: [...one.bindings, ...two.bindings],
      byId: new Map([...one.byId, ...two.byId]),
    };
    return {
      service: createTreeService({ document: () => merged }),
      quarantined: () => [],
      restore: () => ({ ok: false as const, reason: "no-such-node" as const, detail: "no" }),
    } satisfies TreeCliDeps;
  };

  it("uses the only tree when there is only one, and says which it picked", () => {
    expect(run(["ready"]).stdout).toContain(TREE);
  });

  it("refuses to guess between two trees, and lists them", () => {
    const result = run(["ready"], twoTrees());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("page:one");
    expect(result.stderr).toContain("page:two");
    expect(result.stderr).toContain("name one");
  });

  it("takes the tree id explicitly", () => {
    const result = run(["ready", "page:two"], twoTrees());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shape:other");
  });

  it("resolves a NODE id without being told its tree — the shape says so", () => {
    const result = run(["show", "shape:other"], twoTrees());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shape:other");
  });

  it("names both misses when an id is neither a node nor a tree", () => {
    const result = run(["show", "shape:ghost"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("shape:ghost");
    expect(result.stderr).toContain("no node");
    expect(result.stderr).toContain("no page");
  });
});

// ---------------------------------------------------------------------------
// Quarantine: the recovery surface (C2 obligation 3)
// ---------------------------------------------------------------------------

describe("bb canvas tree quarantined — seeing what was taken out", () => {
  it("lists every quarantined edge with the reason and the way back", () => {
    const deps = cliFor(EXAMPLE, { quarantined: [parked("shape:edge-1")] });

    const result = run(["quarantined"], deps);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shape:edge-1");
    expect(result.stdout).toContain("reparented");
    expect(result.stdout).toContain("shape:ui was moved");
    // SEE, then act: a list that does not say how to restore leaves the same
    // unreachable promise C2 found in the write path.
    expect(result.stdout).toContain("bb canvas tree restore shape:edge-1");
  });

  it("says so when nothing is quarantined", () => {
    expect(run(["quarantined"]).stdout).toContain("No edges are quarantined");
  });

  it("answers --json with the record, not the whole shape", () => {
    const deps = cliFor(EXAMPLE, { quarantined: [parked("shape:edge-1")] });

    expect(JSON.parse(run(["quarantined", "--json"], deps).stdout)).toEqual([
      {
        edgeId: "shape:edge-1",
        treeId: TREE,
        reason: "reparented",
        detail: "shape:ui was moved",
      },
    ]);
  });
});

describe("bb canvas tree restore — putting a relationship back", () => {
  it("restores and says which tree it went back into", () => {
    const deps = cliFor(EXAMPLE, {
      restore: (edgeId) => ({ ok: true, value: { edgeId, treeId: TREE } }),
    });

    const result = run(["restore", "shape:edge-1"], deps);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shape:edge-1");
    expect(result.stdout).toContain(TREE);
  });

  it("passes W11's refusal through UNEDITED, rival edge and all", () => {
    // The refusal is the useful answer, and its value is the id it names.
    // A CLI that rewrote it into "restore failed" would break the one path
    // C2 asked to be made reachable.
    const detail =
      "restoring shape:edge-1 into page:tree would recreate multiple-parents " +
      "(shape:ui, shape:api, shape:goal) — the next merge would take it straight " +
      "back out. Remove the rival edge first: shape:3z34mh.";
    const deps = cliFor(EXAMPLE, {
      restore: () => ({ ok: false, reason: "broken-tree", detail }),
    });

    const result = run(["restore", "shape:edge-1"], deps);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(detail);
    expect(result.stderr).toContain("shape:3z34mh");
  });

  it("emits the refusal as data under --json, so a caller can read the reason", () => {
    const deps = cliFor(EXAMPLE, {
      restore: () => ({ ok: false, reason: "broken-tree", detail: "nope" }),
    });

    const result = run(["restore", "shape:edge-1", "--json"], deps);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      reason: "broken-tree",
      detail: "nope",
    });
  });

  it("wants an edge id", () => {
    const result = run(["restore"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bb canvas tree restore <EDGE>");
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

describe("usage", () => {
  it("prints the verbs on help", () => {
    const result = run(["help"]);

    expect(result.exitCode).toBe(0);
    for (const verb of ["show", "node", "ready", "quarantined", "restore"]) {
      expect(result.stdout).toContain(verb);
    }
  });

  it("fails on a verb it does not know, showing the usage", () => {
    const result = run(["frobnicate"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("frobnicate");
    expect(result.stderr).toContain(TREE_CLI_USAGE);
  });

  it("fails on --depth without a number", () => {
    expect(run(["show", "--depth"]).exitCode).toBe(1);
    expect(run(["show", "--depth", "nope"]).stderr).toContain("--depth");
  });
});
