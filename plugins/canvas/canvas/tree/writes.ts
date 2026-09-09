// W10 — the TREE WRITE ENGINE: the five mutations an agent is allowed to make
// to a discovery tree, and the refusals that keep them from breaking one.
//
// W1 reads a document into a graph, W5 answers questions about it, W6 puts
// those answers in front of a model. This module is the first thing in the
// feature that CHANGES the document, so its whole design is about one rule:
//
//   A REFUSAL IS A FEATURE. A write that would create a cycle, orphan an edge,
//   duplicate a relationship or overflow the encoding's own caps is REFUSED,
//   naming the ids it is about — never quietly adjusted into something legal.
//   An agent that is told "no, because shape:goal is already above
//   shape:schema" can pick a different move; an agent whose illegal move was
//   silently turned into a legal one has been lied to, and the human watching
//   the canvas sees an edit nobody asked for.
//
// WHERE THE LINE WITH W11 IS, EXACTLY. This module refuses writes that are
// ILLEGAL ON THEIR OWN — judged against the state it can see at the moment it
// looks. It does NOT reconcile damage that two individually-legal concurrent
// writes produce: on a CRDT, two peers can each add a legal edge and converge
// on a cycle, and no preflight anywhere can prevent that. That is W11's
// subject. What this module owes W11 is honesty: after every accepted write it
// RE-READS the whole tree through W1 and reports any problem that was not
// there before (`TreeWriteOutcome.newProblems`). It never repairs one — a
// reader that quietly fixed a cycle would hide exactly the state repair exists
// to find (model.ts's header says the same thing from the read side).
//
// EVERY ACCEPTED WRITE LEAVES A DOCUMENT THE READ SPINE READS BACK CLEANLY.
// That is the property the suite asserts after each mutation, and it is why
// the encoding's builders (W0) are the only way a shape or a binding is
// constructed here: `buildTreeNode` returns a value that passes canvas-model's
// `validateShape`, which is the same gate `CanvasDoc.putShape` applies, so a
// write cannot half-land.
//
// TARGET, NOT DOC. The doc operations this needs arrive as an injected
// `TreeWriteTarget` — nine methods, no Loro, no WASM, no bb SDK, no clock, no
// Math.random (id entropy is injected too, exactly as canvas-editor injects
// `random()`). doc-source.ts is the three-line adapter over a live room's
// `CanvasDoc`, so this module stays testable against any document.
import {
  indexBetween,
  plainText,
  type Binding,
  type CanvasDocument,
  type Shape,
} from "@ensembleworks/canvas-model";
import {
  MAX_CONTEXT_LENGTH,
  TREE_KEY,
  buildTreeEdge,
  buildTreeNode,
  quarantineTreeShape,
  type NodeState,
} from "./encoding.js";
import {
  checkTreeInvariants,
  childrenOf,
  parentsOf,
  readTree,
  type Tree,
  type TreeNode,
  type TreeProblem,
} from "./model.js";

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/**
 * What a writer needs from the document, and nothing else.
 *
 * Every method except `document` and `random` is `CanvasDoc`'s own, with
 * `CanvasDoc`'s own contracts — in particular `putShape` REJECTS an invalid
 * shape as a total no-op rather than throwing, which is why an accepted write
 * is verified by reading it back rather than by trusting the call.
 */
export interface TreeWriteTarget {
  /** The document as canvas-model values. Called once per phase of a write:
   * once to judge it, once to read back what it did. */
  document(): CanvasDocument;
  getShape(id: string): Shape | undefined;
  putShape(shape: Shape): void;
  updateProps(id: string, props: Record<string, unknown>): void;
  putBinding(binding: Binding): void;
  /**
   * NO `deleteShape`, NO `deleteBinding` — the same type-level guarantee W11's
   * `TreeRepairTarget` makes, and for the same reason. This engine used to
   * hold both, and used them in exactly one place: `reparent`, where a
   * declined new edge left the old one tombstoned (C2 finding 1). An edge
   * leaves a tree by QUARANTINE now, which is a meta key on a shape the human
   * drew, so the absence below is checkable in one line rather than only
   * asserted by a test.
   */
  /**
   * Commit the change — and, in production, durably log it. Injected rather
   * than `doc.commit()` because a server-local write is NOT persisted by the
   * room's inbound-frame path: see canvas/room.ts's `commitLocalWrite`.
   */
  commit(): void;
  /** Entropy for minted ids. Injected so a test can name what a write creates. */
  random(): number;
}

/** Why a write was refused. Every one of these is a NORMAL answer. */
export type TreeWriteRefusal =
  /** No node with that id in any tree of this document. */
  | "no-such-node"
  /** The shape exists but is not a usable node of a tree. */
  | "not-a-tree-node"
  /** The two ends of the write are in different trees. */
  | "different-tree"
  /** The write would make work transitively block itself. */
  | "would-cycle"
  /** The relationship the write asks for is already asserted by an edge. */
  | "already-blocks"
  /** A string the write carries is longer than the encoding allows. */
  | "too-long"
  /** A title that is empty or only whitespace. */
  | "empty-title"
  /**
   * The tree is ALREADY broken in a way that makes this write undecidable —
   * a cycle above the target. W11's ground: this module refuses rather than
   * writing into damage and rather than repairing it.
   */
  | "broken-tree"
  /**
   * The document did not take the write. `putShape`/`updateProps` reject an
   * invalid value as a silent no-op, so an accepted-looking call that did
   * nothing is possible and is caught by reading the result back.
   */
  | "rejected";

export type TreeWrite<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: TreeWriteRefusal; readonly detail: string };

/** What an accepted write did. */
export interface TreeWriteOutcome {
  /** The node a reader should look at now — the subject of the write, or the
   * parent it was added under. */
  readonly focusId: string;
  /** The node this write created, if it created one. */
  readonly createdId?: string;
  /** The edge this write created, if it created one. */
  readonly edgeId?: string;
  /** The edges it removed, if any — named, because a removal an agent did not
   * ask for out loud is an edit the human cannot account for. */
  readonly removedEdgeIds?: readonly string[];
  /** What it did, in the words the tool will show the model. */
  readonly changed: readonly string[];
  /**
   * Problems present AFTER the write that were not present before it. Empty on
   * every write this module accepts against a document nobody else is editing;
   * non-empty means a concurrent peer landed something in between, which is
   * W11's to reconcile and this module's to report.
   */
  readonly newProblems: readonly TreeProblem[];
}

export interface TreeWriter {
  /** Create a node that BLOCKS `parentId`, and the edge saying so. */
  addChild(input: {
    parentId: string;
    title: string;
    state?: NodeState;
    context?: string;
  }): TreeWrite<TreeWriteOutcome>;
  /** Retitle a node. */
  rename(input: { nodeId: string; title: string }): TreeWrite<TreeWriteOutcome>;
  /** Move a node so it blocks `newParentId` instead of whatever it blocked. */
  reparent(input: { nodeId: string; newParentId: string }): TreeWrite<TreeWriteOutcome>;
  setState(input: { nodeId: string; state: NodeState }): TreeWrite<TreeWriteOutcome>;
  /** Overwrite a node's context note (goal / definition of done / knowns). */
  writeContext(input: { nodeId: string; context: string }): TreeWrite<TreeWriteOutcome>;
}

/**
 * Ceiling on a title an agent writes. A WRITE POLICY, deliberately not an
 * encoding invariant: `encoding.ts` caps `meta.context` because a malformed
 * value there makes a node unreadable, but a human's existing 900-character
 * note title is legal and must keep reading fine. This bounds what an AGENT
 * may add, since a title rides every delta to every connected client and is
 * drawn on a 200x200 note.
 */
export const MAX_TITLE_LENGTH = 500;

/** How far below its parent a new node is placed, and how far apart siblings
 * sit. W3 owns real layout; this is the deterministic placeholder so a created
 * node is not stacked on top of its parent, and it is a function of the tree
 * (the sibling count), never of a clock. */
/**
 * The quarantine `reason` a reparent stamps on the edge it replaced — a
 * MOVE, not damage. Named so a reader (and a test) can tell the two apart:
 * every other reason in a quarantine record is a `TreeProblemKind` W11 found.
 */
export const REPARENT_REASON = "reparented";

export const NODE_STEP_X = 240;
export const NODE_STEP_Y = 260;

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/**
 * What the five operations share.
 *
 * PASSED, NOT CLOSED OVER. The first version of this file was one
 * `createTreeWriter` with all five operations nested inside it — a 314-token
 * function that the quality audit's hotspot list named outright. Each operation
 * is now a module-level function a reader can hold on its own, and what they
 * have in common is exactly these three things.
 */
interface WriteOps {
  readonly target: TreeWriteTarget;
  /** Find a node the way W5's service does: off the shape's own `meta.tree`. */
  locate(nodeId: string): TreeWrite<{ tree: Tree; node: TreeNode }>;
  /** Mutate, commit, and read the whole tree back — see `applyWrite`. */
  applied(
    before: Tree,
    focusId: string,
    mutate: () => void,
    outcome: Omit<TreeWriteOutcome, "newProblems" | "focusId">,
    landed: (after: Tree) => string | null,
  ): TreeWrite<TreeWriteOutcome>;
}

export function createTreeWriter(target: TreeWriteTarget): TreeWriter {
  const ops: WriteOps = {
    target,
    locate: (nodeId) => locateNode(target, nodeId),
    applied: (before, focusId, mutate, outcome, landed) =>
      applyWrite(target, before, focusId, mutate, outcome, landed),
  };
  return {
    addChild: (input) => addChild(ops, input),
    rename: (input) => rename(ops, input),
    reparent: (input) => reparent(ops, input),
    setState: (input) => setState(ops, input),
    writeContext: (input) => writeContext(ops, input),
  };
}

/**
 * Locate a node, off the shape's own `meta.tree` — so a caller never has to
 * know (or guess, or cache) which page a node lives on.
 */
function locateNode(
  target: TreeWriteTarget,
  nodeId: string,
): TreeWrite<{ tree: Tree; node: TreeNode }> {
  const doc = target.document();
  const shape = doc.shapes.find((candidate) => candidate.id === nodeId);
  if (shape === undefined) {
    return refusal("no-such-node", `no shape ${nodeId} in this document`);
  }
  const treeId = shape.meta[TREE_KEY];
  if (typeof treeId !== "string" || treeId.length === 0) {
    return refusal("not-a-tree-node", `${nodeId} is not part of a tree`);
  }
  const tree = readTree(doc, treeId);
  const node = tree.nodes.get(nodeId);
  if (node === undefined) {
    // W1 has already recorded WHY (invalid-node, foreign-kind). Say which:
    // "not found" would send a human looking for a deletion that never
    // happened.
    const why = tree.problems.find((problem) => problem.subjects.includes(nodeId));
    return refusal(
      "not-a-tree-node",
      why
        ? `${nodeId} is not a usable node of ${treeId}: ${why.detail}`
        : `${nodeId} is not a node of ${treeId}`,
    );
  }
  return { ok: true, value: { tree, node } };
}

/**
 * Apply a mutation, commit it, and read the whole tree back.
 *
 * The read-back is this node's central promise and it does two jobs at once: it
 * PROVES the write landed (`putShape` rejects an invalid shape silently, so an
 * unverified write can be a no-op that reported success), and it reports any
 * problem that appeared while this write was in flight — without repairing it.
 */
function applyWrite(
  target: TreeWriteTarget,
  before: Tree,
  focusId: string,
  mutate: () => void,
  outcome: Omit<TreeWriteOutcome, "newProblems" | "focusId">,
  /** What must be true of the tree afterwards for the write to have landed. */
  landed: (after: Tree) => string | null,
): TreeWrite<TreeWriteOutcome> {
  const had = new Set(problemsOf(before).map(problemKey));
  mutate();
  target.commit();
  const after = readTree(target.document(), before.treeId);
  const missing = landed(after);
  if (missing !== null) return refusal("rejected", missing);
  return {
    ok: true,
    value: {
      ...outcome,
      focusId,
      newProblems: problemsOf(after).filter((problem) => !had.has(problemKey(problem))),
    },
  };
}

// ---------------------------------------------------------------------------
// The five operations
// ---------------------------------------------------------------------------

function addChild(
  ops: WriteOps,
  { parentId, title, state, context }: { parentId: string; title: string; state?: NodeState; context?: string },
): TreeWrite<TreeWriteOutcome> {
  const subject = `a new node under ${parentId}`;
  const titled = checkTitle(subject, title);
  if (!titled.ok) return titled;
  const noted = checkContext(subject, context ?? "");
  if (!noted.ok) return noted;
  const found = ops.locate(parentId);
  if (!found.ok) return found;
  const { tree, node: parent } = found.value;

  const minted = mintShapeId(ops.target, tree);
  if (!minted.ok) return minted;
  const nodeId = minted.value;
  const edgeMinted = mintShapeId(ops.target, tree, new Set([nodeId]));
  if (!edgeMinted.ok) return edgeMinted;
  const edgeId = edgeMinted.value;

  // W3 owns layout; this is the deterministic placeholder — a function of the
  // tree (the sibling count), never of a clock.
  const x = parent.shape.x + childrenOf(tree, parent.id).length * NODE_STEP_X;
  const y = parent.shape.y + NODE_STEP_Y;
  const shape = withTitle(
    buildTreeNode({
      id: nodeId,
      treeId: tree.treeId,
      // The parent SHAPE's container, not the parent node: a node may sit
      // inside a frame, and a child that jumped out of it would look like a
      // move the agent never mentioned.
      parentId: parent.shape.parentId,
      index: nextIndex(tree),
      x,
      y,
      ...(state === undefined ? {} : { state }),
      ...(context === undefined ? {} : { context }),
    }),
    titled.value,
  );
  const edge = buildTreeEdge({
    id: edgeId,
    treeId: tree.treeId,
    parentId: parent.shape.parentId,
    index: nextIndex(tree, 2),
    // W0's direction, and the only place this node states it: the NEW node is
    // the blocker, the parent is the blocked.
    blockerId: nodeId,
    blockedId: parent.id,
    from: { x, y },
    to: { x: parent.shape.x, y: parent.shape.y },
  });

  return ops.applied(
    tree,
    parent.id,
    () => {
      // Shape before bindings: a binding whose `fromId` names a shape the doc
      // has never seen is a dangling row repair() would sweep.
      ops.target.putShape(shape);
      ops.target.putShape(edge.shape);
      for (const binding of edge.bindings) ops.target.putBinding(binding);
    },
    {
      createdId: nodeId,
      edgeId,
      changed: [`Created ${nodeId} — ${titled.value} [${state ?? "todo"}], blocking ${parent.id}.`],
    },
    (after) =>
      after.nodes.has(nodeId)
        ? after.edges.some((edge) => edge.blockerId === nodeId && edge.blockedId === parent.id)
          ? null
          : `${nodeId} was created but the edge to ${parent.id} did not land`
        : `the document did not accept a new node under ${parent.id}`,
  );
}

function rename(
  ops: WriteOps,
  { nodeId, title }: { nodeId: string; title: string },
): TreeWrite<TreeWriteOutcome> {
  const titled = checkTitle(nodeId, title);
  if (!titled.ok) return titled;
  const found = ops.locate(nodeId);
  if (!found.ok) return found;
  const { tree, node } = found.value;
  const was = plainText(node.shape).trim();
  return ops.applied(
    tree,
    node.id,
    // A PROPS patch, not a whole-shape put: a title lives in `props.richText`,
    // and merging leaves every other prop (and the node's meta) as it was.
    () => ops.target.updateProps(node.id, { richText: richTextOf(titled.value) }),
    {
      changed: [
        was === ""
          ? `Titled ${node.id} "${titled.value}".`
          : `Retitled ${node.id} from "${was}" to "${titled.value}".`,
      ],
    },
    (after) => {
      const now = after.nodes.get(node.id);
      return now && plainText(now.shape).trim() === titled.value
        ? null
        : `the document did not accept a new title for ${node.id}`;
    },
  );
}

function reparent(
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

/** What a move DID, naming the edges it took out of the tree — AND saying they
 * are recoverable. A removal the agent did not say out loud is an edit the
 * human cannot account for, and one described as a deletion when it was a
 * quarantine sends them looking for undo they do not need. */
function movedSentence(
  nodeId: string,
  parentId: string,
  removed: readonly { edgeId: string; blockedId: string }[],
): string {
  if (removed.length === 0) return `${nodeId} was a root; it now blocks ${parentId}.`;
  const was = removed.map((gone) => gone.blockedId).join(", ");
  const ids = removed.map((gone) => gone.edgeId).join(", ");
  return `Moved ${nodeId}: it now blocks ${parentId} instead of ${was} (took ${removed.length} edge${
    removed.length === 1 ? "" : "s"
  } out of the tree: ${ids} — quarantined, still drawn, restorable with restoreQuarantinedEdge).`;
}

function setState(
  ops: WriteOps,
  { nodeId, state }: { nodeId: string; state: NodeState },
): TreeWrite<TreeWriteOutcome> {
  const found = ops.locate(nodeId);
  if (!found.ok) return found;
  const { tree, node } = found.value;
  const was = node.meta.state;
  return ops.applied(
    tree,
    node.id,
    () => ops.target.putShape(withMeta(node.shape, { state })),
    {
      changed:
        was === state
          ? [`${node.id} was already ${state}; nothing changed.`]
          : [`${node.id} moved from ${was} to ${state}.`],
    },
    (after) =>
      after.nodes.get(node.id)?.meta.state === state
        ? null
        : `the document did not accept ${state} for ${node.id}`,
  );
}

function writeContext(
  ops: WriteOps,
  { nodeId, context }: { nodeId: string; context: string },
): TreeWrite<TreeWriteOutcome> {
  const noted = checkContext(nodeId, context);
  if (!noted.ok) return noted;
  const found = ops.locate(nodeId);
  if (!found.ok) return found;
  const { tree, node } = found.value;
  const was = node.meta.context;
  return ops.applied(
    tree,
    node.id,
    () => ops.target.putShape(withMeta(node.shape, { context })),
    {
      // The replaced LENGTH, said out loud: this write overwrites whatever a
      // human wrote, and a silent overwrite of a definition of done is the most
      // expensive thing on this tool set.
      changed: [
        was === ""
          ? `Wrote ${context.length} characters of context on ${node.id}.`
          : `Replaced ${was.length} characters of context on ${node.id} with ${context.length}.`,
      ],
    },
    (after) =>
      after.nodes.get(node.id)?.meta.context === context
        ? null
        : `the document did not accept a context note for ${node.id}`,
  );
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const refusal = <T>(reason: TreeWriteRefusal, detail: string): TreeWrite<T> => ({
  ok: false,
  reason,
  detail,
});

/**
 * EVERY GUARD NAMES ITS SUBJECT. The first version of these two took only the
 * string, so a blank title was refused with "a node needs a title" and no id at
 * all — and the suite's "names an id in every refusal" test is what caught it.
 * A refusal an agent cannot attribute to a node is a refusal it cannot act on:
 * it does not know which of the writes it just planned was rejected.
 */
function checkTitle(subject: string, title: string): TreeWrite<string> {
  const trimmed = title.trim();
  if (trimmed === "") {
    return refusal(
      "empty-title",
      `${subject} needs a title: an untitled note is unreadable on the canvas and in every digest`,
    );
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    return refusal(
      "too-long",
      `that title for ${subject} is ${trimmed.length} characters; the limit is ${MAX_TITLE_LENGTH}. Put the detail in the node's context note instead.`,
    );
  }
  return { ok: true, value: trimmed };
}

function checkContext(subject: string, context: string): TreeWrite<string> {
  if (context.length > MAX_CONTEXT_LENGTH) {
    return refusal(
      "too-long",
      `that context note for ${subject} is ${context.length} characters; the limit is ${MAX_CONTEXT_LENGTH}. It rides every sync delta to every connected client, so it is bounded.`,
    );
  }
  return { ok: true, value: context };
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

/** Structural and graph problems together — what "is this tree broken" means. */
const problemsOf = (tree: Tree): readonly TreeProblem[] => [
  ...tree.problems,
  ...checkTreeInvariants(tree),
];

/** Identity of a problem, for "was this here before the write". */
const problemKey = (problem: TreeProblem): string =>
  `${problem.kind}|${problem.subjects.join(",")}`;

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * A fresh shape id, in canvas-editor's own `shape:<base36>` convention.
 *
 * Collision-checked against the whole document rather than assumed unique: the
 * entropy is injected, a test seeds it deliberately, and a minted id that
 * happened to hit an existing shape would UPSERT it — overwriting a human's
 * node is the worst outcome this module could produce, so it refuses instead.
 */
function mintShapeId(
  target: TreeWriteTarget,
  tree: Tree,
  taken: ReadonlySet<string> = new Set(),
): TreeWrite<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `shape:${Math.floor(target.random() * 1e9).toString(36)}`;
    if (!taken.has(id) && target.getShape(id) === undefined && !tree.nodes.has(id)) {
      return { ok: true, value: id };
    }
  }
  return refusal("rejected", "could not mint a free shape id after 8 attempts");
}

/**
 * The next fractional index above everything in the tree, so a created shape
 * sits on top of the stack rather than behind a note it belongs beside.
 *
 * THE MAX IS VALIDATED BEFORE USE, because canvas-model types a shape's
 * `index` as no more than a non-empty string: a shape carrying a value that is
 * not a valid A1 order key is legal in the document and MAKES
 * `generateKeyBetween` THROW (`invalid order key: y1`). Found by a test that
 * planted a node with `index: "y1"` for an unrelated reason — an `addChild`
 * that throws would break this module's "a refusal is an answer, never an
 * exception" promise on account of one bad z-order string somewhere else on the
 * page. An unusable max is IGNORED (the new shape lands at the bottom of the
 * stack, which is cosmetic) rather than turned into a refusal the agent can do
 * nothing about.
 */
function nextIndex(tree: Tree, above = 1): string {
  // ONE guard, at the only place an unvalidated string enters: an index that
  // came out of the document. Everything after this point is a key A1 itself
  // generated, so no call below can throw and no second guard is needed.
  let max: string | null = null;
  for (const node of tree.nodes.values()) {
    const candidate = node.shape.index;
    if (!isOrderKey(candidate)) continue;
    if (max === null || candidate > max) max = candidate;
  }
  let index = indexBetween(max, null);
  for (let i = 1; i < above; i += 1) index = indexBetween(index, null);
  return index;
}

/** Whether A1 can read this as an order key — asked by TRYING, because the
 * generator's validation is not exported. */
const isOrderKey = (value: string): boolean => {
  try {
    indexBetween(value, null);
    return true;
  } catch {
    return false;
  }
};

/** Overwrite a node's tree meta fields, keeping every other key — `meta` is
 * shared with whatever else stamps a shape (encoding.ts's LOOSE note). */
function withMeta(shape: Shape, fields: { state?: NodeState; context?: string }): Shape {
  return { ...shape, meta: { ...shape.meta, ...fields } } as Shape;
}

/** `props.richText`, the one place canvas-model reads a note's text from
 * (`plainText` is its exact inverse). canvas-model exports no builder for it,
 * so this is the single place in the plugin that constructs one. */
export function richTextOf(title: string): Record<string, unknown> {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: title }] }],
  };
}

const withTitle = (shape: Shape, title: string): Shape =>
  ({
    ...shape,
    props: { ...(shape.props as Record<string, unknown>), richText: richTextOf(title) },
  }) as Shape;
