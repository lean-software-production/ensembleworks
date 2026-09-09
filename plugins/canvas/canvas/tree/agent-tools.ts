// W6 — the discovery tree, as tools a bb thread can call.
//
// This is the plugin's FIRST agent-facing surface. Everything it answers with
// comes from W5's `TreeService`; nothing here re-derives a tree fact. In
// particular readiness is `model.isReadyNode` through `service.ready` and
// `view.isReady`, and there is deliberately no second rule at this layer —
// that second definition is exactly what C1's finding 1 was.
//
// THREE THINGS THIS FILE DECIDES.
//
// 1. NAMES ARE NAMESPACED, because bb tool names are global across every
//    loaded plugin: a bare `node` or `digest` would collide with the first
//    other plugin to want the obvious word, and the loser's registration is
//    REJECTED (see PluginAgents.registerTool). `canvas_tree_*` says which
//    plugin and which surface, and reads as a sentence to a model choosing a
//    tool: canvas_tree_children, canvas_tree_path.
//
// 2. THE THREAD'S OWN NODE IS THE DEFAULT SUBJECT. Every tool's id argument is
//    OPTIONAL, and omitting it means "the node this thread was launched on".
//    A model opening a fresh session can ask where it is before it has learned
//    a single id — which is the whole point of launching a thread on a node.
//
// 3. AN ANSWER IS PROSE, NOT A DUMP. The reader is a model reading cold, and
//    what orients it is the digest and the path to root, not a JSON blob of
//    every field. Each answer is a handful of lines, bounded by
//    MAX_ANSWER_CHARS, and says out loud when it left something out.
import { z } from "zod";
import type {
  BbPluginApi,
  PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import type { TreeNodeView, TreeQuery, TreeService } from "./service.js";
import {
  MAX_ANSWER_CHARS,
  failed,
  listing,
  nodeDetail,
  ok,
  oneLine,
  outline,
  refuse,
  titleOf,
} from "./answers.js";
import { treeInstructions } from "./instructions.js";
import {
  TREE_WRITE_TOOL_NAMES,
  createTreeWriteTools,
  type TreeWriteToolDeps,
} from "./write-tools.js";
import {
  TREE_QUARANTINE_TOOL_NAMES,
  createTreeQuarantineTools,
  type TreeQuarantineToolDeps,
} from "./quarantine-tools.js";
import type { TreeWriter } from "./writes.js";

/** Re-exported at its original home: W6's suite and any later reader looks for
 * the answer ceiling here, and answers.ts is where it now lives. */
export { MAX_ANSWER_CHARS };

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/** What the tools need from the server, and nothing else. */
export interface TreeToolDeps extends TreeWriteToolDeps, TreeQuarantineToolDeps {
  /** W5's query surface, over the live room document. */
  readonly service: TreeService;
  /** W10's write engine, over the same live document. Required, not optional:
   * an optional writer would mean a deployment could silently offer the read
   * half only, and a model would learn the tree is read-only. */
  readonly writer: TreeWriter;
  /**
   * The canvas shape this thread was launched on, or null. `AgentLinks`
   * answers this from its in-memory mirror, which is what makes it usable in
   * `bb.agents.configure` — that callback is synchronous and sits on the
   * thread-start path.
   */
  linkedShapeId(threadId: string): string | null;
}

/** The slice of a bb tool call these tools actually read. */
export interface TreeToolCallContext {
  readonly threadId: string;
}

/** Parameters, unioned across the tool set: each tool declares only its own. */
export interface TreeToolParams {
  readonly nodeId?: string;
  readonly treeId?: string;
  readonly depth?: number;
}

export interface TreeToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType<TreeToolParams>;
  execute(params: TreeToolParams, ctx: TreeToolCallContext): PluginAgentToolResult;
}

/** The READ tools (W6), in the order a reader meets them. */
export const TREE_READ_TOOL_NAMES = [
  "canvas_tree_digest",
  "canvas_tree_node",
  "canvas_tree_children",
  "canvas_tree_path",
  "canvas_tree_subtree",
  "canvas_tree_ready",
] as const;

/**
 * Every tree tool a scoped thread gets: the reads and W10's writes.
 *
 * ONE LIST, because there is one `bb.agents.configure` callback per plugin and
 * scope is decided in it — a thread that may read this tree may also change it.
 * Splitting the scope would mean a second callback, which bb rejects.
 */
export const TREE_TOOL_NAMES = [
  ...TREE_READ_TOOL_NAMES,
  ...TREE_WRITE_TOOL_NAMES,
  // W13's recovery pair. In the SAME scope as the writes, deliberately: the
  // move that quarantines a human's edge is a write tool, so a thread that can
  // displace a relationship must be able to see and undo what it displaced.
  ...TREE_QUARANTINE_TOOL_NAMES,
] as const;

// ---------------------------------------------------------------------------
// Resolving the subject
// ---------------------------------------------------------------------------

/**
 * The tree node this thread was launched on, or null when it was not launched
 * on one — no link at all, a link to a plain note, or a link to a node the
 * human has since deleted. Following the DOCUMENT rather than the link is what
 * makes the last case behave: the kv row outlives the shape until a sweep.
 */
export function treeThreadSubject(
  threadId: string,
  deps: TreeToolDeps,
): TreeNodeView | null {
  const shapeId = deps.linkedShapeId(threadId);
  if (shapeId === null) return null;
  const found = deps.service.node(shapeId);
  return found.ok ? found.value : null;
}

/** Which tools this thread gets — reads AND writes, or nothing. Empty is the
 * answer for most threads on a bb server. */
export function selectTreeTools(threadId: string, deps: TreeToolDeps): string[] {
  return treeThreadSubject(threadId, deps) === null ? [] : [...TREE_TOOL_NAMES];
}

/** What to say when a call named no subject and the thread has none either. */
function noSubject(deps: TreeToolDeps, what: "node" | "tree"): PluginAgentToolResult {
  const trees = deps.service.trees();
  const known = trees.length === 0
    ? "This canvas has no tree pages."
    : `Trees on this canvas: ${trees.join(", ")}.`;
  return refuse(
    `No ${what} to answer about: this thread is not linked to a tree node, so name one explicitly. ${known}`,
  );
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const nodeParams = z.object({
  nodeId: z
    .string()
    .optional()
    .describe("A node's shape id. Defaults to the node this thread is about."),
});

const treeParams = z.object({
  treeId: z
    .string()
    .optional()
    .describe("A tree's page id. Defaults to the tree this thread's node is in."),
});

const subtreeParams = z.object({
  nodeId: z
    .string()
    .optional()
    .describe("The node to walk down from. Defaults to this thread's node."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("How many levels of blockers to include. Defaults to 2."),
});

export function createTreeTools(deps: TreeToolDeps): TreeToolRegistration[] {
  /** The node a call is about: its argument, else the thread's own node. */
  const subjectNode = (
    params: TreeToolParams,
    ctx: TreeToolCallContext,
  ): TreeQuery<TreeNodeView> | null => {
    if (params.nodeId !== undefined) return deps.service.node(params.nodeId);
    const own = treeThreadSubject(ctx.threadId, deps);
    return own === null ? null : { ok: true, value: own };
  };

  /** The tree a call is about: its argument, else the thread's node's tree. */
  const subjectTree = (params: TreeToolParams, ctx: TreeToolCallContext): string | null => {
    if (params.treeId !== undefined) return params.treeId;
    return treeThreadSubject(ctx.threadId, deps)?.treeId ?? null;
  };

  return [
    {
      name: "canvas_tree_digest",
      description:
        "Orient yourself in a discovery tree on the canvas: its size, what is ready to start now, what is structurally wrong with it, and an outline. Start here, then use the other canvas_tree_* tools for anything the digest says it left out.",
      parameters: treeParams,
      execute(params, ctx) {
        const treeId = subjectTree(params, ctx);
        if (treeId === null) return noSubject(deps, "tree");
        const digest = deps.service.digest(treeId);
        if (!digest.ok) return failed(digest);
        const lines = [digest.value.text];
        if (digest.value.truncated) {
          lines.push(
            "",
            `This digest is incomplete (${digest.value.counts.nodes} nodes, ${digest.value.counts.problems} problems in total). To read what it dropped: canvas_tree_subtree for a branch, canvas_tree_children for one node's blockers, canvas_tree_ready for the whole ready list, canvas_tree_node for a node's context.`,
          );
        }
        return ok(lines.join("\n"));
      },
    },
    {
      name: "canvas_tree_node",
      description:
        "Read one node of a discovery tree in full: its title, state, whether it is ready to start, what it blocks, what blocks it, and its whole context note. The context is never carried by the digest, so this is the only way to read it.",
      parameters: nodeParams,
      execute(params, ctx) {
        const found = subjectNode(params, ctx);
        if (found === null) return noSubject(deps, "node");
        if (!found.ok) return failed(found);
        return ok(nodeDetail(found.value).join("\n"));
      },
    },
    {
      name: "canvas_tree_children",
      description:
        "List the nodes that BLOCK a node of a discovery tree — its children in the drawn tree, the work that has to happen before it can be finished.",
      parameters: nodeParams,
      execute(params, ctx) {
        const found = subjectNode(params, ctx);
        if (found === null) return noSubject(deps, "node");
        if (!found.ok) return failed(found);
        const children = deps.service.children(found.value.id);
        if (!children.ok) return failed(children);
        return ok(
          [
            `Blockers of ${found.value.id} — ${titleOf(found.value)}:`,
            listing(children.value, "nothing blocks this node"),
          ].join("\n"),
        );
      },
    },
    {
      name: "canvas_tree_path",
      description:
        "Walk from a node of a discovery tree up to its root — what this work is ultimately for. Nearest first, root last. This is the cheapest way to recover why a node exists.",
      parameters: nodeParams,
      execute(params, ctx) {
        const found = subjectNode(params, ctx);
        if (found === null) return noSubject(deps, "node");
        if (!found.ok) return failed(found);
        const path = deps.service.pathToRoot(found.value.id);
        if (!path.ok) return failed(path);
        const lines = path.value.map(
          (view, index) => `${index + 1}. ${oneLine(view)}`,
        );
        return ok([`Path from ${found.value.id} to its root:`, ...lines].join("\n"));
      },
    },
    {
      name: "canvas_tree_subtree",
      description:
        "Read a branch of a discovery tree as an indented outline: a node with the blockers beneath it, several levels deep. Use this to read a part of a tree the digest was too small to show.",
      parameters: subtreeParams,
      execute(params, ctx) {
        const found = subjectNode(params, ctx);
        if (found === null) return noSubject(deps, "node");
        if (!found.ok) return failed(found);
        const subtree = deps.service.subtree(found.value.id, params.depth ?? 2);
        if (!subtree.ok) return failed(subtree);
        return ok(outline(subtree.value).join("\n"));
      },
    },
    {
      name: "canvas_tree_ready",
      description:
        "List every READY node in a discovery tree — everything that could be started right now, meaning it is not done and has nothing unfinished beneath it. This is the whole list, even when the digest could only show some of it.",
      parameters: treeParams,
      execute(params, ctx) {
        const treeId = subjectTree(params, ctx);
        if (treeId === null) return noSubject(deps, "tree");
        const ready = deps.service.ready(treeId);
        if (!ready.ok) return failed(ready);
        return ok(
          [
            `Ready now in ${treeId} — not done, nothing unfinished beneath them:`,
            listing(ready.value, "nothing is ready — every node is done, or every one is blocked"),
          ].join("\n"),
        );
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Register the tools and scope them to threads that are about a tree node.
 *
 * `configure` runs synchronously at thread start and turn submit, so the scope
 * decision costs one `AgentLinks` map lookup plus one document read — the same
 * read every query makes, and the reason there is no cache here (see
 * service.ts).
 *
 * ONE `configure` CALLBACK EXISTS PER PLUGIN. This is currently it; a later
 * node that wants to select skills or contribute instructions must extend this
 * callback rather than register a second one, which bb rejects.
 */
export function registerTreeAgentTools(bb: BbPluginApi, deps: TreeToolDeps): void {
  const registered = [
    ...createTreeTools(deps),
    ...createTreeWriteTools(deps),
    ...createTreeQuarantineTools(deps),
  ];
  for (const tool of registered) {
    bb.agents.registerTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as never,
      execute: (params, ctx) => tool.execute(params as never, ctx),
    });
  }
  bb.agents.configure((context) => ({
    tools: selectTreeTools(context.thread.id, deps),
    skills: [],
  }));
  // W7's per-turn brief. A SEPARATE registration from `configure` — bb takes
  // one of each — and it resolves its subject through the same
  // `treeThreadSubject` the tool scope does, so a thread that gets the tools
  // gets the brief and a thread that gets neither is silent in both.
  bb.agents.contributeInstructions((context) =>
    treeInstructions(context.threadId, {
      service: deps.service,
      subject: (threadId) => treeThreadSubject(threadId, deps),
    }),
  );
}
