// W10 — the write engine, as tools a bb thread can call.
//
// The read tools (W6) and these are deliberately the same surface: same
// `canvas_tree_` prefix (bb tool names are global across plugins and a
// collision REJECTS the loser's registration), same "the thread's own node is
// the default subject" rule, same `isError` on a refusal, same answer
// vocabulary (answers.ts). A model that has learned to read this tree does not
// have to learn a second idiom to change it.
//
// TWO THINGS THESE TOOLS ADD OVER THE READ ONES.
//
// 1. EVERY ANSWER SHOWS THE RESULTING SUBTREE. The plan's outcome for this node
//    says the agent must see what it actually did, and a bare "ok" cannot say
//    that — a write that landed somewhere unintended reads identically. So each
//    answer is: what changed, then the subtree around it as it now is, read
//    back through W5 AFTER the write.
// 2. A REFUSAL IS THE POINT, not an error path. `writes.ts` refuses any write
//    that would break the tree, naming the ids; these tools pass that sentence
//    through unedited, with `isError` set so a model cannot read it as content.
import { z } from "zod";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { NODE_STATES } from "./encoding.js";
import { ok, outline, refuse } from "./answers.js";
import type { TreeNodeView, TreeService } from "./service.js";
import type { TreeWriteOutcome, TreeWriter, TreeWrite } from "./writes.js";

/** What the write tools need from the server. */
export interface TreeWriteToolDeps {
  readonly service: TreeService;
  readonly writer: TreeWriter;
  linkedShapeId(threadId: string): string | null;
}

export interface TreeWriteToolCallContext {
  readonly threadId: string;
}

export interface TreeWriteToolParams {
  readonly nodeId?: string;
  readonly parentId?: string;
  readonly newParentId?: string;
  readonly title?: string;
  readonly state?: (typeof NODE_STATES)[number];
  readonly context?: string;
}

export interface TreeWriteToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType<TreeWriteToolParams>;
  execute(
    params: TreeWriteToolParams,
    ctx: TreeWriteToolCallContext,
  ): PluginAgentToolResult;
}

/** Every write tool, in the order a reader meets them. */
export const TREE_WRITE_TOOL_NAMES = [
  "canvas_tree_add_child",
  "canvas_tree_rename",
  "canvas_tree_reparent",
  "canvas_tree_set_state",
  "canvas_tree_write_context",
] as const;

/** How deep the subtree an answer shows goes. Two levels: the node and what
 * blocks it, which is what a write is about. Deeper is `canvas_tree_subtree`. */
const ANSWER_DEPTH = 2;

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const nodeId = z
  .string()
  .optional()
  .describe("A node's shape id. Defaults to the node this thread is about.");

const title = z.string().describe("The node's one-line title, as a human will read it.");

const addChildParams = z.object({
  parentId: nodeId.describe(
    "The node the new one will BLOCK — its parent in the drawn tree. Defaults to the node this thread is about.",
  ),
  title,
  state: z
    .enum(NODE_STATES)
    .optional()
    .describe("Lifecycle state. Defaults to todo."),
  context: z
    .string()
    .optional()
    .describe("Markdown for the node's context note: goal, definition of done, knowns, unknowns."),
});

const renameParams = z.object({ nodeId, title });

const reparentParams = z.object({
  nodeId,
  newParentId: z
    .string()
    .describe("The node this one should BLOCK from now on. Must be in the same tree."),
});

const setStateParams = z.object({
  nodeId,
  state: z.enum(NODE_STATES).describe("todo, wip or done."),
});

const writeContextParams = z.object({
  nodeId,
  context: z
    .string()
    .describe(
      "The whole context note, as markdown. This REPLACES what is there — read it first with canvas_tree_node.",
    ),
});

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export function createTreeWriteTools(deps: TreeWriteToolDeps): TreeWriteToolRegistration[] {
  /** The thread's own node, resolved through the DOCUMENT rather than the link
   * — same rule as W6, and for the same reason: the kv row outlives the shape,
   * and a write aimed at a deleted node must not be attempted. */
  const own = (threadId: string): TreeNodeView | null => {
    const shapeId = deps.linkedShapeId(threadId);
    if (shapeId === null) return null;
    const found = deps.service.node(shapeId);
    return found.ok ? found.value : null;
  };

  const subject = (given: string | undefined, threadId: string): string | null =>
    given ?? own(threadId)?.id ?? null;

  const noSubject = (): PluginAgentToolResult => {
    const trees = deps.service.trees();
    return refuse(
      `No node to write to: this thread is not linked to a tree node, so name one explicitly. ${
        trees.length === 0
          ? "This canvas has no tree pages."
          : `Trees on this canvas: ${trees.join(", ")}.`
      }`,
    );
  };

  /**
   * Render a completed write: what it did, then the tree around it AS IT NOW
   * IS. The subtree is read back through W5 after the commit, so the answer is
   * the document's state and not the writer's belief about it.
   */
  const answer = (result: TreeWrite<TreeWriteOutcome>): PluginAgentToolResult => {
    if (!result.ok) return refuse(`${result.reason}: ${result.detail}`);
    const done = result.value;
    const lines = [...done.changed];
    const shown = deps.service.subtree(done.focusId, ANSWER_DEPTH);
    if (shown.ok) {
      lines.push("", ...outline(shown.value));
    } else {
      // The write landed and then the subject went — a concurrent delete. Say
      // so rather than dropping the sentence.
      lines.push("", `(cannot show ${done.focusId} now: ${shown.detail})`);
    }
    if (done.newProblems.length === 0) return ok(lines.join("\n"));
    // A problem that appeared WHILE this write was in flight. Not repaired
    // here — that is W11 — and not swallowed either: `isError` because the tree
    // the agent is now looking at is damaged, and the next write should not be
    // planned as though it were not.
    return refuse(
      [
        ...lines,
        "",
        `The write landed, but the tree now has ${done.newProblems.length} problem(s) it did not have before — another editor changed it at the same time:`,
        ...done.newProblems.map(
          (problem) => `! ${problem.kind}: ${problem.subjects.join(", ")} — ${problem.detail}`,
        ),
      ].join("\n"),
    );
  };

  return [
    {
      name: "canvas_tree_add_child",
      description:
        "Add a node that BLOCKS an existing one — a new piece of work discovered beneath a goal. Creates the note and the edge saying it blocks the parent, and answers with the parent's subtree as it now stands.",
      parameters: addChildParams,
      execute(params, ctx) {
        const parentId = subject(params.parentId, ctx.threadId);
        if (parentId === null) return noSubject();
        return answer(
          deps.writer.addChild({
            parentId,
            title: params.title ?? "",
            ...(params.state === undefined ? {} : { state: params.state }),
            ...(params.context === undefined ? {} : { context: params.context }),
          }),
        );
      },
    },
    {
      name: "canvas_tree_rename",
      description:
        "Retitle a node of a discovery tree. The title is the one line a human reads on the canvas; put detail in the context note instead.",
      parameters: renameParams,
      execute(params, ctx) {
        const id = subject(params.nodeId, ctx.threadId);
        if (id === null) return noSubject();
        return answer(deps.writer.rename({ nodeId: id, title: params.title ?? "" }));
      },
    },
    {
      name: "canvas_tree_reparent",
      description:
        "Move a node so it BLOCKS a different node — reorganise the tree. Refused, naming the ids, if the move would make work block itself, if the two nodes are in different trees, or if that relationship already exists.",
      parameters: reparentParams,
      execute(params, ctx) {
        const id = subject(params.nodeId, ctx.threadId);
        if (id === null) return noSubject();
        return answer(
          deps.writer.reparent({ nodeId: id, newParentId: params.newParentId ?? "" }),
        );
      },
    },
    {
      name: "canvas_tree_set_state",
      description:
        "Set a node's state to todo, wip or done. Marking a node done can make what it blocks READY, so check canvas_tree_ready afterwards.",
      parameters: setStateParams,
      execute(params, ctx) {
        const id = subject(params.nodeId, ctx.threadId);
        if (id === null) return noSubject();
        return answer(
          deps.writer.setState({ nodeId: id, state: params.state ?? "todo" }),
        );
      },
    },
    {
      name: "canvas_tree_write_context",
      description:
        "Write a node's context note: what this work is for, its definition of done, what is known and unknown. REPLACES the whole note, so read it with canvas_tree_node first — the answer says how much writing was replaced.",
      parameters: writeContextParams,
      execute(params, ctx) {
        const id = subject(params.nodeId, ctx.threadId);
        if (id === null) return noSubject();
        return answer(
          deps.writer.writeContext({ nodeId: id, context: params.context ?? "" }),
        );
      },
    },
  ];
}
