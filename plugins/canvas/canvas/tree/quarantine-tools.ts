// W13 — the recovery surface, as tools a bb thread can call. C2's obligation 3.
//
// WHY THIS FILE EXISTS. `reparent` displaces the edge it replaces on the HAPPY
// path — every routine move quarantines a relationship a human drew — and its
// answer told the agent that relationship was "restorable". W11 had built both
// halves of that promise (`listQuarantinedEdges`, `restoreQuarantinedEdge`)
// and neither was reachable from any tool, so the caller was told to remove a
// rival edge it could not see and to restore an edge it could not name. C2
// called that "true at the API level and unreachable from the agent's
// toolset". These two tools are the reach.
//
// THE PAIR IS THE POINT, and it is why they are ONE module rather than a read
// filed with W6 and a write filed with W10. A restore is refused while a rival
// live edge stands (repair.ts), and the refusal names that rival — an agent
// handed `restore` without `quarantined` would be able to act only on ids it
// had guessed. Seeing comes first, always, so the two ship together or not at
// all.
//
// SAME IDIOM AS EVERY OTHER TREE TOOL: the `canvas_tree_` prefix (bb tool names
// are global across plugins and a collision rejects the loser's registration),
// the thread's own node as the default subject where a default is meaningful,
// `answers.ts`'s vocabulary, and `isError` on a refusal so a model cannot read
// a refusal as content. The refusal sentence itself is passed through
// UNEDITED — the rival edge id it carries is the whole value of it.
import { z } from "zod";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { ok, refuse } from "./answers.js";
import { listQuarantinedEdges, restoreQuarantinedEdge, type TreeRepairTarget } from "./repair.js";
import type { TreeService } from "./service.js";

/** The tools, in the order a reader meets them — and the order they must be
 * used in. */
export const TREE_QUARANTINE_TOOL_NAMES = [
  "canvas_tree_quarantined",
  "canvas_tree_restore_edge",
] as const;

/** What these tools need from the server. A `TreeRepairTarget` rather than a
 * `TreeWriter`: restore is the inverse of a repair op, and the target type is
 * the one that CANNOT delete (repair.ts's `Pick`), so this surface inherits
 * that guarantee instead of re-arguing it. */
export interface TreeQuarantineToolDeps {
  readonly service: TreeService;
  readonly repair: TreeRepairTarget;
  linkedShapeId(threadId: string): string | null;
}

export interface TreeQuarantineToolParams {
  readonly treeId?: string;
  readonly edgeId?: string;
}

export interface TreeQuarantineToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType<TreeQuarantineToolParams>;
  execute(
    params: TreeQuarantineToolParams,
    ctx: { readonly threadId: string },
  ): PluginAgentToolResult;
}

const listParams = z.object({
  treeId: z
    .string()
    .optional()
    .describe("A tree's page id. Defaults to the tree this thread's node is in."),
});

const restoreParams = z.object({
  edgeId: z
    .string()
    .describe(
      "The quarantined edge's shape id, exactly as canvas_tree_quarantined printed it.",
    ),
});

export function createTreeQuarantineTools(
  deps: TreeQuarantineToolDeps,
): TreeQuarantineToolRegistration[] {
  /** The tree a list call is about: its argument, else the thread's own node's
   * tree. Resolved through the DOCUMENT, like every other tool here, so a link
   * to a shape the human has since deleted resolves to nothing rather than to
   * a stale tree id. */
  const subjectTree = (params: TreeQuarantineToolParams, threadId: string): string | null => {
    if (params.treeId !== undefined) return params.treeId;
    const shapeId = deps.linkedShapeId(threadId);
    if (shapeId === null) return null;
    const found = deps.service.node(shapeId);
    return found.ok ? found.value.treeId : null;
  };

  return [
    {
      name: "canvas_tree_quarantined",
      description:
        "List the edges that have been taken OUT of a discovery tree — by a move you made, or by a repair after two people edited at once. A quarantined edge is still drawn on the canvas but is not part of the tree, so no other canvas_tree_* tool can see it. Read this before canvas_tree_restore_edge.",
      parameters: listParams,
      execute(params, ctx) {
        const treeId = subjectTree(params, ctx.threadId);
        if (treeId === null) {
          const trees = deps.service.trees();
          return refuse(
            `No tree to answer about: this thread is not linked to a tree node, so name one explicitly. ${
              trees.length === 0
                ? "This canvas has no tree pages."
                : `Trees on this canvas: ${trees.join(", ")}.`
            }`,
          );
        }
        const entries = listQuarantinedEdges(deps.repair.document(), treeId);
        if (entries.length === 0) {
          return ok(`Nothing is quarantined in ${treeId}: no edge has been taken out of it.`);
        }
        return ok(
          [
            `Taken out of ${treeId} — still drawn on the canvas, not part of the tree:`,
            ...entries.map(
              (entry) =>
                `${entry.edgeId} — ${entry.quarantine.reason}: ${entry.quarantine.detail}`,
            ),
            "",
            "Put one back with canvas_tree_restore_edge. A restore is refused while a rival edge stands in its place; the refusal names the rival.",
          ].join("\n"),
        );
      },
    },
    {
      name: "canvas_tree_restore_edge",
      description:
        "Put a quarantined edge back into its tree — undo a move, or reverse a repair that took out the wrong relationship. Refused, naming the rival edge to remove first, if restoring it would recreate the damage that got it quarantined. Find the id with canvas_tree_quarantined.",
      parameters: restoreParams,
      execute(params) {
        // NO THREAD DEFAULT. A thread is linked to a NODE; an edge is not a
        // node, and defaulting to "some edge near you" would restore a
        // relationship nobody named.
        const edgeId = params.edgeId;
        if (edgeId === undefined || edgeId.trim() === "") {
          return refuse(
            "Name the edge to restore: canvas_tree_quarantined lists every quarantined edge with its id.",
          );
        }
        const result = restoreQuarantinedEdge(deps.repair, edgeId);
        // UNEDITED, both ways. The refusal carries the rival edge id (C2
        // finding 3) and the success carries the tree it went back into.
        if (!result.ok) return refuse(`${result.reason}: ${result.detail}`);
        // NO SUBTREE IN THE ANSWER, unlike W10's writes. Those are about a
        // NODE and can show the node back; this is about an EDGE, which no
        // read tool addresses — so the honest follow-up is a whole-tree read,
        // named rather than faked.
        return ok(
          [
            `Restored ${result.value.edgeId} into ${result.value.treeId}: the relationship it carries is part of the tree again.`,
            "Read the tree back with canvas_tree_digest — a restored edge changes what is ready.",
          ].join("\n"),
        );
      },
    },
  ];
}
