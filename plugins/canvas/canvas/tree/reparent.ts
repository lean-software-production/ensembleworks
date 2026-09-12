// W16 — REPARENT: the one write that DISPLACES.
//
// Split out of writes.ts along the boundary the module always had. Five of the
// six operations are purely ADDITIVE — `addGoal` and `addChild` create, and
// `rename`, `setState`, `writeContext` overwrite one field of one node. None
// of them can take a relationship out of a tree, and none of them can leave
// the document holding something a human drew but the tree no longer counts.
//
// This one can, and everything that is special about it follows from that:
//
//   * It is the only operation with an ORDERING safety property — the new edge
//     goes in and is CHECKED before the old one is disposed of (C2 finding 1).
//   * It is the only producer of a `reparented` quarantine, so `REPARENT_REASON`
//     is its constant and lives with it.
//   * It is the only operation that can close a CYCLE, so the climb is here.
//
// Reading it beside `addChild` never made those three facts look like anything
// but incidental detail of a long file. They are the whole subject of this one.

import { buildTreeEdge, quarantineTreeShape } from "./encoding.js";
import { parentsOf, type Tree, type TreeNode } from "./model.js";
import {
  mintShapeId,
  nextIndex,
  refusal,
  type TreeWrite,
  type TreeWriteOutcome,
  type WriteOps,
} from "./write-seam.js";

/**
 * The quarantine `reason` a reparent stamps on the edge it replaced — a
 * MOVE, not damage. Named so a reader (and a test) can tell the two apart:
 * every other reason in a quarantine record is a `TreeProblemKind` W11 found.
 */
export const REPARENT_REASON = "reparented";


export function reparent(
  ops: WriteOps,
  { nodeId, newParentId }: { nodeId: string; newParentId: string },
): TreeWrite<TreeWriteOutcome> {
  const checked = checkReparent(ops, nodeId, newParentId);
  if (!checked.ok) return checked;
  const { tree, node, parent } = checked.value;

  const removed = tree.edges.filter((edge) => edge.blockerId === node.id);
  const minted = mintShapeId(ops.target, tree);
  if (!minted.ok) return minted;
  const edgeId = minted.value;
  const edge = buildTreeEdge({
    id: edgeId,
    treeId: tree.treeId,
    parentId: parent.shape.parentId,
    index: nextIndex(tree),
    blockerId: node.id,
    blockedId: parent.id,
    from: { x: node.shape.x, y: node.shape.y },
    to: { x: parent.shape.x, y: parent.shape.y },
  });

  return ops.applied(
    tree,
    node.id,
    () => {
      // THE ORDER IS THE SAFETY PROPERTY (C2 finding 1). The first version
      // removed the old edges FIRST and let `applyWrite`'s read-back decide
      // afterwards — so a `putShape` the document declined (its documented
      // right: an arrow built from a valid parent can still fail
      // `validateShape` on geometry a remote peer wrote) left the human's
      // relationship DELETED, a Loro tombstone, while the agent was told
      // `rejected`. Worse than the loss: `readTree` then saw a legal tree with
      // one more root, so W11 never learned anything had gone. The new edge
      // therefore goes in and is CHECKED before anything else moves.
      ops.target.putShape(edge.shape);
      if (ops.target.getShape(edgeId) === undefined) return; // declined: touch nothing else
      for (const binding of edge.bindings) ops.target.putBinding(binding);
      // QUARANTINE, NOT DELETE — the same disposal W11 uses, for the same
      // reason: the old arrow is a thing a human drew, and taking it out of
      // the tree is a meta key, not a tombstone. `restoreQuarantinedEdge` puts
      // the relationship back if the move was wrong.
      for (const gone of removed) {
        const shape = ops.target.getShape(gone.edgeId);
        if (shape === undefined) continue;
        const parked = quarantineTreeShape(shape, {
          reason: REPARENT_REASON,
          detail: `${node.id} was moved to block ${parent.id} instead of ${gone.blockedId}`,
        });
        if (parked.status === "ok") ops.target.putShape(parked.value);
      }
    },
    {
      edgeId,
      removedEdgeIds: removed.map((gone) => gone.edgeId),
      changed: [movedSentence(node.id, parent.id, removed)],
    },
    (after) => {
      const parents = after.edges
        .filter((edge) => edge.blockerId === node.id)
        .map((edge) => edge.blockedId);
      if (!parents.includes(parent.id)) {
        // A refusal that does not account for the OLD edge is the one an agent
        // cannot act on: it has to know whether the relationship it asked to
        // replace is still there.
        return `the document declined the new edge ${edgeId}, so ${node.id} was not moved under ${
          parent.id
        }; ${
          removed.length === 0
            ? `${node.id} is still a root`
            : `it still blocks ${removed.map((gone) => gone.blockedId).join(", ")} through ${removed
                .map((gone) => gone.edgeId)
                .join(", ")}`
        }`;
      }
      return parents.length === 1
        ? null
        : `${node.id} still blocks ${parents.join(", ")} — the old edges did not go`;
    },
  );
}

/**
 * Every reason a reparent is refused, in one place — this is the node's most
 * dangerous write and the refusals ARE the feature, so they are worth reading
 * as a list rather than threaded through the mutation.
 */
function checkReparent(
  ops: WriteOps,
  nodeId: string,
  newParentId: string,
): TreeWrite<{ tree: Tree; node: TreeNode; parent: TreeNode }> {
  if (nodeId === newParentId) {
    return refusal("would-cycle", `${nodeId} cannot block itself`);
  }
  const foundNode = ops.locate(nodeId);
  if (!foundNode.ok) return foundNode;
  const foundParent = ops.locate(newParentId);
  if (!foundParent.ok) return foundParent;
  const { tree, node } = foundNode.value;
  const parent = foundParent.value.node;
  if (foundParent.value.tree.treeId !== tree.treeId) {
    return refusal(
      "different-tree",
      `${nodeId} is in ${tree.treeId} and ${newParentId} is in ${foundParent.value.tree.treeId}; a node cannot block work in another tree`,
    );
  }
  if (tree.edges.some((edge) => edge.blockerId === node.id && edge.blockedId === parent.id)) {
    return refusal(
      "already-blocks",
      `${nodeId} already blocks ${newParentId}; a second edge saying so would be a duplicate, not a move`,
    );
  }
  // THE CYCLE CHECK. The new edge says `node` blocks `parent`, so it closes a
  // loop exactly when `parent` already transitively blocks `node` — walk what
  // `parent` blocks and see whether `node` is up there.
  const above = climb(tree, parent.id);
  if (above.status === "cycle") {
    return refusal(
      "broken-tree",
      `there is already a cycle above ${newParentId} (${above.at}), so where this move would leave ${nodeId} has no answer — repair the tree first`,
    );
  }
  if (above.ids.includes(node.id)) {
    return refusal(
      "would-cycle",
      `${newParentId} is already blocked by ${nodeId} (via ${above.ids.join(" -> ")}), so making ${nodeId} block ${newParentId} would make that work block itself`,
    );
  }
  return { ok: true, value: { tree, node, parent } };
}

/**
 * What a move DID, naming the edges it took out of the tree AND how to get the
 * relationship back.
 *
 * THIS SENTENCE USED TO BE FALSE ON EVERY SINGLE HAPPY PATH (C3's B3). It said
 * "put back with canvas_tree_restore_edge", and that restore is refused 100% of
 * the time after a move — deterministically, by construction, not by bad luck:
 * a reparent leaves `nodeId` with a LIVE parent edge, so restoring the edge it
 * displaced would project `multiple-parents`, and repair.ts refuses any restore
 * that would. An agent that followed the instruction burned a turn and ended up
 * with a refusal instead of an undo. A line a model acts on without checking is
 * worse than no line at all (D7's argument, one surface along).
 *
 * SO IT NAMES THE MOVE THAT WORKS. Another `canvas_tree_reparent`, back the way
 * it came, genuinely re-establishes the relationship — with a fresh edge, which
 * is why the displaced one stays quarantined and is worth saying out loud.
 * There is no verb that removes the rival edge, so there is no cheaper undo to
 * point at; inventing one is W14's deferred disposal work, not a sentence's.
 *
 * WHAT IT STILL SAYS, unchanged: which edges went, and that they are
 * quarantined rather than deleted. A removal the agent did not say out loud is
 * an edit the human cannot account for, and one described as a deletion when it
 * was a quarantine sends them looking for undo they do not need.
 */
function movedSentence(
  nodeId: string,
  parentId: string,
  removed: readonly { edgeId: string; blockedId: string }[],
): string {
  if (removed.length === 0) return `${nodeId} was a root; it now blocks ${parentId}.`;
  const was = removed.map((gone) => gone.blockedId).join(", ");
  const ids = removed.map((gone) => gone.edgeId).join(", ");
  // One removed edge is the ordinary case; more than one means the node had
  // `multiple-parents` before the move, and a reparent puts back one at a time.
  const back =
    removed.length === 1
      ? `reparent ${nodeId} back under ${was}`
      : `reparent ${nodeId} back under one of ${was}, one at a time`;
  return `Moved ${nodeId}: it now blocks ${parentId} instead of ${was} (took ${removed.length} edge${
    removed.length === 1 ? "" : "s"
  } out of the tree: ${ids} — quarantined, still drawn on the canvas, and NOT restorable while this move stands, because ${nodeId} now has a live parent. To undo the move, canvas_tree_reparent it back: ${back}.)`;
}


/**
 * Walk UP from a node — the things it blocks — collecting what it reaches.
 *
 * `cycle` rather than a truncated list when the walk revisits a node, for the
 * same reason `model.pathToRoot` refuses: a truncated answer here would let a
 * cycle-creating write through. Under `multiple-parents` every branch is
 * followed, because a cycle through EITHER parent is still a cycle.
 */
function climb(
  tree: Tree,
  from: string,
): { status: "ok"; ids: readonly string[] } | { status: "cycle"; at: string; ids: readonly string[] } {
  const seen = new Set<string>([from]);
  const order: string[] = [from];
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const parent of parentsOf(tree, id)) {
      if (seen.has(parent.id)) {
        return { status: "cycle", at: parent.id, ids: order };
      }
      seen.add(parent.id);
      order.push(parent.id);
      queue.push(parent.id);
    }
  }
  return { status: "ok", ids: order };
}

