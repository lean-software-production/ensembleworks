// W10 — THE TREE WRITE ENGINE: the mutations an agent is allowed to make to a
// discovery tree, and the refusals that keep them from breaking one.
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
// WHAT IS IN THIS FILE, AFTER W16's SPLIT: the ADDITIVE operations, and the
// assembly that hands all six of them out. `write-seam.ts` holds the contract
// and the apply protocol they share; `reparent.ts` holds the one operation
// that displaces an existing relationship. The three files are a strict
// layering — seam, then reparent, then this — with no cycle between them.
//
// WHERE THE LINE WITH W11 IS, EXACTLY. This module refuses writes that are
// ILLEGAL ON THEIR OWN — judged against the state it can see at the moment it
// looks. It does NOT reconcile damage that two individually-legal concurrent
// writes produce: on a CRDT, two peers can each add a legal edge and converge
// on a cycle, and no preflight anywhere can prevent that. That is W11's
// subject. What this module owes W11 is honesty: after every accepted write
// `applyWrite` RE-READS the whole tree through W1 and reports any problem that
// was not there before (`TreeWriteOutcome.newProblems`). It never repairs one —
// a reader that quietly fixed a cycle would hide exactly the state repair
// exists to find (model.ts's header says the same thing from the read side).
//
// EVERY ACCEPTED WRITE LEAVES A DOCUMENT THE READ SPINE READS BACK CLEANLY.
// That is the property the suite asserts after each mutation, and it is why
// the encoding's builders (W0) are the only way a shape or a binding is
// constructed here: `buildTreeNode` returns a value that passes canvas-model's
// `validateShape`, which is the same gate `CanvasDoc.putShape` applies, so a
// write cannot half-land.

import {
  buildTreeEdge,
  buildTreeNode,
  markTreePage,
  readTreePage,
  type NodeState,
} from "./encoding.js";
import { placeNewChild, placeNewGoal } from "./layout.js";
import { readTree } from "./model.js";
import { reparent } from "./reparent.js";
import {
  applyWrite,
  checkContext,
  checkTitle,
  locateNode,
  mintShapeId,
  nextIndex,
  refusal,
  titleOf,
  withMeta,
  type TreeWrite,
  type TreeWriteOutcome,
  type TreeWriteTarget,
  type TreeWriter,
  type WriteOps,
} from "./write-seam.js";

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------


export function createTreeWriter(target: TreeWriteTarget): TreeWriter {
  const ops: WriteOps = {
    target,
    locate: (nodeId) => locateNode(target, nodeId),
    applied: (before, focusId, mutate, outcome, landed) =>
      applyWrite(target, before, focusId, mutate, outcome, landed),
  };
  return {
    addGoal: (input) => addGoal(ops, input),
    addChild: (input) => addChild(ops, input),
    rename: (input) => rename(ops, input),
    reparent: (input) => reparent(ops, input),
    setState: (input) => setState(ops, input),
    writeContext: (input) => writeContext(ops, input),
  };
}

// ---------------------------------------------------------------------------
// The five operations
// ---------------------------------------------------------------------------

/**
 * W4's goal gesture: a ROOT node, and the page mark that makes the page a tree.
 *
 * THE ONE WRITE THAT DOES NOT START FROM A NODE, and therefore the only one
 * that cannot use `locate`. Every other operation here needs a node that is
 * already on a marked page, which means that before this existed there was no
 * path — human or agent — to a FIRST tree at all; the only trees in existence
 * were the ones a seed script hand-built.
 *
 * MARKING IS PART OF THE GESTURE, not repair. An UNMARKED page gets the mark:
 * "put a goal here" is exactly the act that declares the page a tree, and the
 * mark is additive (`markTreePage` copies the page and sets one key). A
 * MALFORMED mark is REFUSED instead — restamping it would destroy the evidence
 * of how it broke, which is W11's to look at and not a creation gesture's to
 * erase. An already-marked page is left alone, so a second goal broadcasts no
 * page delta at all.
 *
 * No edge, so no direction to get wrong, and no cycle to check: a goal blocks
 * nothing by definition. The only refusals are the page's and the title's.
 */
function addGoal(
  ops: WriteOps,
  { treeId, title, state, context }: { treeId: string; title: string; state?: NodeState; context?: string },
): TreeWrite<TreeWriteOutcome> {
  const titled = checkTitle(treeId, title);
  if (!titled.ok) return titled;
  const noted = checkContext(treeId, context ?? "");
  if (!noted.ok) return noted;

  const doc = ops.target.document();
  const page = doc.pages.find((candidate) => candidate.id === treeId);
  if (page === undefined) {
    return refusal("no-such-page", `no page ${treeId} in this document`);
  }
  const mark = readTreePage(page);
  if (mark.status === "invalid") {
    return refusal(
      "broken-tree",
      `page ${treeId} carries a malformed tree mark (${mark.error}); repair it before adding to it`,
    );
  }

  const tree = readTree(doc, treeId);
  const minted = mintShapeId(ops.target, tree);
  if (!minted.ok) return minted;
  const nodeId = minted.value;
  const at = placeNewGoal(tree);
  const shape = buildTreeNode({
    id: nodeId,
    treeId,
    // The PAGE, not a frame: a goal is the top of its own tree, so it is not
    // inheriting anybody's container.
    parentId: treeId,
    index: nextIndex(tree),
    x: at.x,
    y: at.y,
    ...(state === undefined ? {} : { state }),
    ...(context === undefined ? {} : { context }),
  });

  const marking = mark.status === "absent";
  return ops.applied(
    tree,
    nodeId,
    () => {
      if (marking) ops.target.putPage(markTreePage(page));
      ops.target.putShape(shape);
      // AFTER the shape: `setText` no-ops on an id the document has never
      // seen, exactly as `putShape` rejects an invalid shape.
      ops.target.setText(nodeId, titled.value);
    },
    {
      createdId: nodeId,
      changed: [
        ...(marking ? [`Marked page ${treeId} as a tree.`] : []),
        `Created goal ${nodeId} — ${titled.value} [${state ?? "todo"}] on ${treeId}, blocking nothing.`,
      ],
    },
    (after) => {
      const made = after.nodes.get(nodeId);
      if (made === undefined) return `the document did not accept a new goal on ${treeId}`;
      // The title is a SEPARATE container from the shape, so an accepted shape
      // does not prove an accepted title — read it back through the same rule
      // every reader uses.
      return titleOf(ops, made) === titled.value
        ? null
        : `goal ${nodeId} was created without its title`;
    },
  );
}

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

  // W3 owns layout, and this is where W10's placeholder used to be. The
  // difference is not cosmetic: the placeholder COUNTED siblings
  // (`parent + n * NODE_STEP`), so a family the human had dragged got the
  // newcomer back beside where the parent is, not beside where they put the
  // family. `placeNewChild` reads the siblings' CURRENT positions, which is
  // the "never fight a drag" rule applied to creation. `absent` is
  // unreachable here — `locate` has already found the parent IN this tree —
  // so the fallback is the parent's own point rather than a refusal an agent
  // could do nothing with.
  const slot = placeNewChild(tree, parent.id);
  const { x, y } =
    slot.status === "ok" ? slot.value : { x: parent.shape.x, y: parent.shape.y };
  const shape = buildTreeNode({
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
  });
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
      // AFTER its shape, like the goal's: `setText` cannot title a shape the
      // document does not hold yet.
      ops.target.setText(nodeId, titled.value);
      ops.target.putShape(edge.shape);
      for (const binding of edge.bindings) ops.target.putBinding(binding);
    },
    {
      createdId: nodeId,
      edgeId,
      changed: [`Created ${nodeId} — ${titled.value} [${state ?? "todo"}], blocking ${parent.id}.`],
    },
    (after) => {
      const made = after.nodes.get(nodeId);
      if (made === undefined) return `the document did not accept a new node under ${parent.id}`;
      if (!after.edges.some((edge) => edge.blockerId === nodeId && edge.blockedId === parent.id)) {
        return `${nodeId} was created but the edge to ${parent.id} did not land`;
      }
      return titleOf(ops, made) === titled.value
        ? null
        : `${nodeId} was created without its title`;
    },
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
  const was = titleOf(ops, node).trim();
  return ops.applied(
    tree,
    node.id,
    // THE LIVE TEXT CONTAINER, which is where a human's keystrokes land — not
    // `props.richText`. Writing the other channel is what made a rename
    // invisible on the canvas while the tool reported success (W14's F1,
    // reverse direction): `labelOf` renders live text first, so a note a human
    // had ever typed into kept showing the old title forever. A shape a human
    // has never typed into still carries an imported `props.richText`; the
    // read rule (canvas/shape-text.ts) puts live text above it, so the stale
    // value is shadowed from this write on and can never surface again.
    () => ops.target.setText(node.id, titled.value),
    {
      changed: [
        was === ""
          ? `Titled ${node.id} "${titled.value}".`
          : `Retitled ${node.id} from "${was}" to "${titled.value}".`,
      ],
    },
    (after) => {
      const now = after.nodes.get(node.id);
      return now && titleOf(ops, now).trim() === titled.value
        ? null
        : `the document did not accept a new title for ${node.id}`;
    },
  );
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

