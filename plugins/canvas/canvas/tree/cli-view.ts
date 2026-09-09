// W13 — the discovery tree as `bb canvas tree`.
//
// WHO THIS IS FOR. W6's tools reach an agent that bb is running as a thread.
// A Claude Code session in a canvas terminal is not that agent: it has no bb
// tool session, no `configure` scope and no linked node, and until this file
// existed it could not read the tree it was sitting inside at all. This is
// that reader's whole surface.
//
// FOUR THINGS THIS MODULE DECIDES.
//
// 1. IT READS THROUGH W5, LIKE EVERYTHING ELSE. Every answer below is a
//    `TreeService` call — `trees`, `node`, `subtree`, `ready`, `digest` — and
//    the quarantine pair is W11's. There is no document parsing here, so the
//    CLI cannot disagree with the digest an agent was handed a second ago.
//
// 2. THERE IS NO DEFAULT SUBJECT, AND THAT IS THE INTERESTING DIFFERENCE.
//    The tools default to "the node this thread was launched on"; a terminal
//    has no thread, so a tree-addressed verb resolves the tree from the
//    DOCUMENT — the only one, or an id the caller names — and refuses,
//    listing the candidates, rather than picking. Node-addressed verbs need no
//    tree at all: a node id self-locates, because the shape carries its own
//    `meta.tree` (see service.ts's `treeIdOfShape`).
//
// 3. HUMAN OUTPUT IS AN OUTLINE, NOT A DUMP. Indentation means "blocks the
//    line above", the state marker and `(ready)` are per line, and a legend
//    says both out loud. It deliberately does NOT reuse `answers.outline`:
//    that vocabulary ends its cut markers with "call canvas_tree_subtree",
//    which is a sentence about a tool this reader does not have. The node
//    DETAIL block is shared (`answers.nodeDetail`), because that one carries
//    no tool names and a second account of what "ready" means is exactly the
//    drift this codebase keeps refusing.
//
// 4. `--json` IS THE SERVICE'S OWN VALUES. W5 promised plain serialisable
//    data at its boundary (service.ts property 1); this verb pipes it out
//    unchanged rather than re-shaping it, so a script and a tool answer are
//    reading the same fields. Under `--json` EVERY outcome is JSON on stdout,
//    including a refusal — the exit code carries ok/failed. Without it,
//    failures go to stderr like the rest of `bb canvas`.
//
// Pure: a service, two closures, argv in, a `PluginCliResult` out. No room, no
// document, no bb api — the wiring is cli.ts and server.ts.
import type { PluginCliResult } from "@get-bb/plugin-sdk";
import { titleOf, nodeDetail } from "./answers.js";
import type { QuarantinedEdge } from "./repair.js";
import type { SubtreeView, TreeNodeView, TreeService } from "./service.js";
import type { TreeProblem } from "./model.js";
import type { TreeWrite } from "./writes.js";

export const TREE_CLI_USAGE = [
  "Usage:",
  "  bb canvas tree [--json]                      Every tree on the canvas: size, frontier, health",
  "  bb canvas tree show [ID] [--depth N] [--json]  A tree, or the branch under a node, as an outline",
  "  bb canvas tree node <NODE> [--json]          One node in full, including its context note",
  "  bb canvas tree ready [TREE] [--json]         What could be started right now",
  "  bb canvas tree quarantined [TREE] [--json]   Edges taken out of a tree, and why",
  "  bb canvas tree restore <EDGE> [--json]       Put a quarantined edge back in its tree",
  "",
  "ID is a node's shape id or a tree's page id. TREE may be omitted when the",
  "canvas holds exactly one tree.",
].join("\n");

/** How far `show` walks when nobody says. A terminal can scroll; the cut
 * exists so a cyclic or enormous tree cannot run away, not to ration context
 * the way the agent tools' depth-2 default does. */
export const DEFAULT_SHOW_DEPTH = 20;

/** What the CLI needs. The quarantine pair is passed as closures rather than a
 * `TreeRepairTarget` so this module never sees a document — see the header. */
export interface TreeCliDeps {
  readonly service: TreeService;
  quarantined(treeId?: string): readonly QuarantinedEdge[];
  restore(edgeId: string): TreeWrite<{ readonly edgeId: string; readonly treeId: string }>;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const MARKERS = { todo: "[ ]", wip: "[~]", done: "[x]" } as const;

/** One node on one line, for a reader looking at a whole tree at once. */
const nodeLine = (view: TreeNodeView): string =>
  `${MARKERS[view.state]} ${view.id} — ${titleOf(view)}${view.isReady ? " (ready)" : ""}`;

const LEGEND =
  "indent = blocks the line above   [ ] todo  [~] wip  [x] done   (ready) = not done, nothing unfinished beneath it";

/** A tree's headline: everything a reader needs to decide whether to look. */
function summaryLine(
  treeId: string,
  counts: { nodes: number; edges: number; problems: number },
  ready: number,
): string {
  const problems =
    counts.problems === 0
      ? "no problems"
      : `${counts.problems} problem${counts.problems === 1 ? "" : "s"}`;
  return `${treeId} — ${counts.nodes} nodes, ${counts.edges} edges, ${ready} ready, ${problems}`;
}

/** The outline. The cut markers name the COMMAND that reads further, which is
 * the whole reason this is not `answers.outline`. */
function outlineLines(view: SubtreeView, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}${nodeLine(view.node)}`];
  for (const child of view.children) lines.push(...outlineLines(child, depth + 1));
  if (view.elided === "depth") {
    lines.push(
      `${indent}  … blockers not shown (depth) — bb canvas tree show ${view.node.id}`,
    );
  }
  if (view.elided === "cycle") {
    lines.push(`${indent}  … blockers not shown (cycle) — this node is already above`);
  }
  return lines;
}

const problemLines = (problems: readonly TreeProblem[]): string[] =>
  problems.length === 0
    ? []
    : ["", "problems:", ...problems.map((p) => `! ${p.kind} (${p.subjects.join(", ")}): ${p.detail}`)];

const quarantineLines = (entries: readonly QuarantinedEdge[]): string[] =>
  entries.flatMap((entry) => [
    `${entry.edgeId} — out of ${entry.quarantine.tree} (${entry.quarantine.reason}): ${entry.quarantine.detail}`,
    `  put it back with: bb canvas tree restore ${entry.edgeId}`,
  ]);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const out = (text: string): PluginCliResult => ({ exitCode: 0, stdout: text });
const asJson = (value: unknown): PluginCliResult => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
});

/** A failure. Under `--json` it is still DATA — a caller scripting a restore
 * needs the reason and the rival edge the refusal names, and a sentence on
 * stderr would make it parse prose to get them. */
function fail(json: boolean, detail: string, extra?: Record<string, unknown>): PluginCliResult {
  return json
    ? { exitCode: 1, stdout: JSON.stringify({ ok: false, ...extra, detail }) }
    : { exitCode: 1, stderr: detail };
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  readonly verb: string;
  readonly id: string | null;
  readonly json: boolean;
  readonly depth: number;
}

type Parsed = { ok: true; args: Args } | { ok: false; error: string };

function parseArgs(argv: readonly string[]): Parsed {
  let json = false;
  let depth = DEFAULT_SHOW_DEPTH;
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--depth") {
      const value = argv[index + 1];
      index += 1;
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, error: `--depth wants a whole number of levels, got ${value ?? "nothing"}` };
      }
      depth = parsed;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, error: `unknown flag ${token}` };
    positional.push(token);
  }
  return {
    ok: true,
    args: {
      verb: positional[0] ?? "list",
      id: positional[1] ?? null,
      json,
      depth,
    },
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export function runTreeCli(argv: readonly string[], deps: TreeCliDeps): PluginCliResult {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return { exitCode: 1, stderr: `${parsed.error}\n\n${TREE_CLI_USAGE}` };
  const { verb, id, json, depth } = parsed.args;

  /**
   * Which tree a tree-addressed verb is about. The named one, else the only
   * one there is. NEVER a guess between two: a reader who ran `ready` against
   * the wrong tree of two would be told the wrong work is startable, and
   * nothing in the answer would say so.
   */
  const tree = (given: string | null): { ok: true; treeId: string } | { ok: false; detail: string } => {
    if (given !== null) return { ok: true, treeId: given };
    const trees = deps.service.trees();
    if (trees.length === 1) return { ok: true, treeId: trees[0]! };
    if (trees.length === 0) return { ok: false, detail: "No tree pages on this canvas." };
    return {
      ok: false,
      detail: `This canvas holds ${trees.length} trees, so name one: ${trees.join(", ")}.`,
    };
  };

  switch (verb) {
    case "list": {
      const trees = deps.service.trees();
      const digests = trees.flatMap((treeId) => {
        const digest = deps.service.digest(treeId);
        return digest.ok ? [digest.value] : [];
      });
      if (json) {
        return asJson(
          digests.map((digest) => ({
            treeId: digest.treeId,
            counts: digest.counts,
            roots: digest.roots,
            ready: digest.ready,
            problems: digest.problems,
          })),
        );
      }
      if (digests.length === 0) return out("No tree pages on this canvas.");
      return out(
        [
          ...digests.map((digest) =>
            summaryLine(digest.treeId, digest.counts, digest.ready.length),
          ),
          "",
          "Read one with: bb canvas tree show <TREE>",
        ].join("\n"),
      );
    }

    case "show": {
      // A NODE id first: it self-locates, so a caller never has to know which
      // page a node is on. Only if it is not a node is the id tried as a tree.
      if (id !== null) {
        const node = deps.service.node(id);
        if (node.ok) {
          const branch = deps.service.subtree(id, depth);
          if (!branch.ok) return fail(json, `${branch.reason}: ${branch.detail}`);
          if (json) return asJson(branch.value);
          return out(
            [
              `${node.value.treeId} — the branch under ${id}`,
              "",
              ...outlineLines(branch.value),
              "",
              LEGEND,
            ].join("\n"),
          );
        }
        const digest = deps.service.digest(id);
        if (!digest.ok) {
          // Name BOTH misses: "not found" alone sends a reader looking for a
          // deletion when they simply pasted a page id as a node id.
          return fail(json, `${id} is neither a node nor a tree: ${node.detail}; ${digest.detail}`);
        }
        return showTree(deps, digest.value.treeId, depth, json);
      }
      const only = tree(null);
      if (!only.ok) return fail(json, only.detail);
      return showTree(deps, only.treeId, depth, json);
    }

    case "node": {
      if (id === null) {
        return fail(
          json,
          `bb canvas tree node <NODE> — name the node. There is no thread here to default one from; bb canvas tree show lists the ids.`,
        );
      }
      const found = deps.service.node(id);
      if (!found.ok) return fail(json, `${found.reason}: ${found.detail}`, { reason: found.reason });
      if (json) return asJson(found.value);
      return out(nodeDetail(found.value).join("\n"));
    }

    case "ready": {
      const target = tree(id);
      if (!target.ok) return fail(json, target.detail);
      const ready = deps.service.ready(target.treeId);
      if (!ready.ok) return fail(json, `${ready.reason}: ${ready.detail}`, { reason: ready.reason });
      if (json) return asJson(ready.value);
      if (ready.value.length === 0) {
        return out(
          `Nothing is ready in ${target.treeId} — every node is done, or every one is blocked.`,
        );
      }
      return out(
        [
          `Ready now in ${target.treeId} — not done, nothing unfinished beneath them:`,
          ...ready.value.map(nodeLine),
        ].join("\n"),
      );
    }

    case "quarantined": {
      const target = tree(id);
      if (!target.ok) return fail(json, target.detail);
      const entries = deps.quarantined(target.treeId);
      if (json) {
        return asJson(
          entries.map((entry) => ({
            edgeId: entry.edgeId,
            treeId: entry.quarantine.tree,
            reason: entry.quarantine.reason,
            detail: entry.quarantine.detail,
          })),
        );
      }
      if (entries.length === 0) {
        return out(`No edges are quarantined in ${target.treeId}.`);
      }
      return out(
        [
          `Taken out of ${target.treeId} by a move or a repair — still drawn, not in the tree:`,
          ...quarantineLines(entries),
        ].join("\n"),
      );
    }

    case "restore": {
      if (id === null) {
        return fail(
          json,
          "bb canvas tree restore <EDGE> — name the edge. bb canvas tree quarantined lists them.",
        );
      }
      const result = deps.restore(id);
      if (!result.ok) {
        // VERBATIM. The refusal names the rival edge standing in this one's
        // way (W11's `restoreQuarantinedEdge`), and that id is the entire
        // value of the sentence — see C2 finding 3.
        return fail(json, result.detail, { reason: result.reason });
      }
      if (json) return asJson({ ok: true, ...result.value });
      return out(`Restored ${result.value.edgeId} into ${result.value.treeId}.`);
    }

    case "help":
    case "-h":
    case "--help":
      return out(TREE_CLI_USAGE);
  }
  return { exitCode: 1, stderr: `bb canvas tree: no such command ${verb}\n\n${TREE_CLI_USAGE}` };
}

/** A whole tree: its headline, every root's outline, then what is wrong with
 * it. The problems ride the SAME read as the roots (one `digest` call), so the
 * outline and the complaint can never describe two different documents. */
function showTree(
  deps: TreeCliDeps,
  treeId: string,
  depth: number,
  json: boolean,
): PluginCliResult {
  const digest = deps.service.digest(treeId);
  if (!digest.ok) return fail(json, `${digest.reason}: ${digest.detail}`, { reason: digest.reason });
  const roots = digest.value.roots.flatMap((rootId) => {
    const branch = deps.service.subtree(rootId, depth);
    return branch.ok ? [branch.value] : [];
  });
  if (json) {
    return asJson({
      treeId,
      counts: digest.value.counts,
      problems: digest.value.problems,
      roots,
    });
  }
  const outline = roots.flatMap((root) => outlineLines(root));
  return out(
    [
      summaryLine(treeId, digest.value.counts, digest.value.ready.length),
      "",
      ...(outline.length === 0 ? ["(this tree has no nodes)"] : outline),
      ...problemLines(digest.value.problems),
      "",
      LEGEND,
    ].join("\n"),
  );
}
