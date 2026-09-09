// W1 — the TREE MODEL: `CanvasDocument -> Tree`, plus the invariant pass.
//
// W0 fixed what a tree IS in the document (encoding.ts). This module is the
// only place that turns a whole document into a graph and answers questions
// about it: roots, children, blockers, path-to-root, ready leaves, and what
// is broken. W5's server queries, W3's layout, W10's write guards and W11's
// repair all read the tree THROUGH here, so there is exactly one description
// of the graph in the codebase.
//
// PURE. No doc handle, no bb SDK, no DOM, no Date.now, no Math.random — the
// input is a canvas-model `CanvasDocument` value and every output is a
// function of it alone.
//
// DIRECTION, restated once because everything below hangs off it. An edge
// means "<blocker> BLOCKS <blocked>" (encoding.ts). Read as a tree:
//
//     goal            a ROOT blocks nothing
//      ^   ^
//    api   ui         a node's CHILDREN are the nodes that BLOCK it
//      ^
//    schema           a READY node is not done and every blocker of it is
//
// so `childrenOf` === "the blockers of", and `parentsOf` === "the things this
// node blocks". Two names for the same fact would rot apart, so the
// structural names are the exported ones and the domain reading is stated
// here.
//
// DETERMINISM is a requirement, not a nicety. Two peers holding the identical
// converged CRDT state iterate the document in different orders (see
// canvas-model's `orderedPages` and `makeDocument`'s byId note for the same
// argument). Every list this module returns is sorted by id, and the cycle
// report is canonicalised, so two peers computing "what is wrong with this
// tree" reach the same answer — otherwise W11 would build divergent repair
// plans from identical state.
//
// NOTHING HERE REPAIRS ANYTHING. A problem is reported, never silently fixed:
// W11 owns repair, and a reader that quietly dropped a human's malformed node
// would hide exactly the state repair exists to find.
import type { Binding, CanvasDocument, Page, Shape } from "@ensembleworks/canvas-model";
import {
  TREE_EDGE_KIND,
  TREE_KEY,
  TREE_NODE_KIND,
  isTreePage,
  readTreeEdge,
  readTreeNode,
  readTreePage,
  type TreeEdge,
  type TreeNodeMeta,
  type TreeRead,
} from "./encoding.js";

// ---------------------------------------------------------------------------
// What a tree is, once read
// ---------------------------------------------------------------------------

/** A node, resolved: its id, its validated tree fields, and the shape it came
 * from (kept so a caller — layout, a digest, a renderer — need not go back to
 * the document for position or text). */
export interface TreeNode {
  readonly id: string;
  readonly meta: TreeNodeMeta;
  readonly shape: Shape;
}

/**
 * Everything that can be wrong with a tree.
 *
 * Structural kinds (`unmarked-page`, `invalid-node`, `invalid-edge`,
 * `foreign-kind`, `dangling-edge`, `duplicate-edge`) come out of `readTree` —
 * they are facts about the DOCUMENT. Graph kinds (`cycle`,
 * `multiple-parents`, `unreachable`) come out of `checkTreeInvariants` — they
 * are facts about the resulting GRAPH, and cost a traversal, so a caller that
 * only wants to draw the tree does not pay for them.
 */
export type TreeProblemKind =
  /** The page this tree claims to live on is missing, or carries no valid mark. */
  | "unmarked-page"
  /** A tree-marked note whose fields do not hold. Not in the graph. */
  | "invalid-node"
  /** A tree-marked arrow that is not a usable edge (e.g. half-bound). Not in the graph. */
  | "invalid-edge"
  /** A tree-marked shape that is neither a node nor an edge kind. */
  | "foreign-kind"
  /** A well-formed edge naming an endpoint that is not a node of this tree. */
  | "dangling-edge"
  /** Two or more edges asserting the same blocker/blocked pair. */
  | "duplicate-edge"
  /** A cycle: work that transitively blocks itself. */
  | "cycle"
  /** A node blocking more than one thing — legal on a DAG, not on a tree. */
  | "multiple-parents"
  /** A node no root can reach. Only possible when a cycle exists. */
  | "unreachable";

export interface TreeProblem {
  readonly kind: TreeProblemKind;
  /** The ids this problem is about — sorted, with two stated exceptions:
   * `cycle`, whose subjects are the cycle IN ORDER rotated to start at its
   * smallest id; and the shape-level kinds (`invalid-node`, `invalid-edge`,
   * …), which name the offending SHAPE first and then any further rows the
   * reader implicated (an ambiguous edge's binding ids), ascending. Subject
   * order is part of the report, so it is fixed rather than incidental. */
  readonly subjects: readonly string[];
  readonly detail: string;
}

export interface Tree {
  readonly treeId: string;
  /** id -> node, in ascending id order. */
  readonly nodes: ReadonlyMap<string, TreeNode>;
  /**
   * The edges of the GRAPH, sorted by edge id. Every edge here has both
   * endpoints in `nodes` — a dangling one is a problem instead, so no
   * traversal below needs a per-endpoint null guard.
   */
  readonly edges: readonly TreeEdge[];
  /** Structural problems only. Graph invariants are `checkTreeInvariants`. */
  readonly problems: readonly TreeProblem[];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const byId = <T extends { id: string }>(items: readonly T[]): T[] =>
  items.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Problems in a stable order: kind, then subjects. Two peers reporting the
 * same set must report it as the same LIST, or `toEqual`-style comparison —
 * and W11's plan hashing — would see a difference that is not there. */
const sortProblems = (problems: readonly TreeProblem[]): TreeProblem[] =>
  problems
    .slice()
    .sort(
      (a, b) =>
        compareStrings(a.kind, b.kind) || compareStrings(a.subjects.join(), b.subjects.join()),
    );

/** The treeIds in a document: every page carrying a valid mark, ascending. */
export function listTrees(doc: CanvasDocument): readonly string[] {
  return doc.pages
    .filter((page: Page) => isTreePage(page))
    .map((page) => page.id)
    .sort(compareStrings);
}

/**
 * Read one tree out of a document.
 *
 * Membership is `shape.meta.tree === treeId`, NOT the parent chain: a node
 * may sit inside a frame, so `parentId` is not the treeId (encoding.ts says
 * the same thing from the writer's side).
 *
 * KNOWN GAP, deliberately not papered over: a shape whose `meta.tree` is
 * present but is not a string belongs to no tree at all, so no `readTree`
 * call can see it and it is reported by none of them. Attributing it would
 * need a document-wide sweep, which is W11's ground, not a reader's.
 */
export function readTree(doc: CanvasDocument, treeId: string): Tree {
  const problems: TreeProblem[] = [];

  const page = doc.pages.find((candidate) => candidate.id === treeId);
  if (!page) {
    problems.push({
      kind: "unmarked-page",
      subjects: [treeId],
      detail: `no page ${treeId} in the document`,
    });
  } else {
    const mark = readTreePage(page);
    if (mark.status !== "ok") {
      problems.push({
        kind: "unmarked-page",
        subjects: [treeId],
        // A page that lost its mark still has the human's nodes on it, so the
        // nodes below are read anyway; this says WHY it is not a tree yet.
        detail:
          mark.status === "absent"
            ? `page ${treeId} carries no tree mark`
            : `page ${treeId} carries a malformed tree mark: ${mark.error}`,
      });
    }
  }

  const nodes = new Map<string, TreeNode>();
  const edges: TreeEdge[] = [];
  const claimed = byId(doc.shapes.filter((shape) => shape.meta[TREE_KEY] === treeId));

  for (const shape of claimed) {
    if (shape.kind === TREE_NODE_KIND) {
      const read = readTreeNode(shape);
      if (read.status === "ok") nodes.set(shape.id, { id: shape.id, meta: read.value, shape });
      else problems.push(shapeProblem("invalid-node", shape, read));
      continue;
    }
    if (shape.kind === TREE_EDGE_KIND) {
      const read = readTreeEdge(shape, doc.bindings as readonly Binding[]);
      if (read.status === "ok") edges.push(read.value);
      else problems.push(shapeProblem("invalid-edge", shape, read));
      continue;
    }
    problems.push({
      kind: "foreign-kind",
      subjects: [shape.id],
      detail: `shape ${shape.id} is tree-marked but is a ${shape.kind}, not a ${TREE_NODE_KIND} or an ${TREE_EDGE_KIND}`,
    });
  }

  // Endpoints resolve, or the edge is out of the graph. Done AFTER the loop
  // because an edge may legally be read before the nodes it names.
  const resolved: TreeEdge[] = [];
  for (const edge of edges.slice().sort((a, b) => compareStrings(a.edgeId, b.edgeId))) {
    const missing = [edge.blockerId, edge.blockedId].filter((id) => !nodes.has(id));
    if (missing.length > 0) {
      problems.push({
        kind: "dangling-edge",
        subjects: [edge.edgeId, ...missing],
        detail: `edge ${edge.edgeId} names ${missing.join(" and ")}, which ${missing.length > 1 ? "are" : "is"} not a node of ${treeId}`,
      });
      continue;
    }
    resolved.push(edge);
  }

  // Two edges asserting the same relationship: reported once per pair-group,
  // naming every edge id involved, because repair has to choose which rows to
  // drop and cannot do that from a count.
  const byPair = new Map<string, string[]>();
  for (const edge of resolved) {
    const key = `${edge.blockerId} ${edge.blockedId}`;
    byPair.set(key, [...(byPair.get(key) ?? []), edge.edgeId]);
  }
  for (const [key, edgeIds] of byPair) {
    if (edgeIds.length < 2) continue;
    const [blockerId, blockedId] = key.split(" ");
    problems.push({
      kind: "duplicate-edge",
      subjects: edgeIds.slice().sort(compareStrings),
      detail: `${edgeIds.length} edges assert that ${blockerId} blocks ${blockedId}`,
    });
  }

  return { treeId, nodes, edges: resolved, problems: sortProblems(problems) };
}

function shapeProblem(
  kind: "invalid-node" | "invalid-edge",
  shape: Shape,
  read: TreeRead<unknown>,
): TreeProblem {
  return {
    kind,
    // The shape first, then whatever else the reader named — an ambiguous
    // edge's conflicting bindings are rows W11 has to delete BY ID, and a
    // detail string is not something a repair plan can act on.
    subjects: [
      shape.id,
      ...(read.status === "invalid" ? (read.subjects ?? []) : []),
    ],
    detail:
      read.status === "invalid"
        ? read.error
        : // `absent` is unreachable here: the shape is tree-marked and of the
          // right kind, which is exactly what the readers key on. Reported
          // rather than ignored so a future encoding change cannot make a
          // node disappear without anyone noticing.
          `shape ${shape.id} is tree-marked but read as absent`,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Every node, ascending by id. */
export function treeNodes(tree: Tree): readonly TreeNode[] {
  return [...tree.nodes.values()];
}

/**
 * Ids -> nodes, sorted and DEDUPED. Deduping is load-bearing, not tidiness: a
 * relationship exists once however many edge rows assert it, and without this
 * a duplicate edge would list a child twice AND fake a `multiple-parents`
 * violation on a tree whose only fault is a redundant row.
 */
const resolve = (tree: Tree, ids: readonly string[]): readonly TreeNode[] =>
  [...new Set(ids)]
    .sort(compareStrings)
    .flatMap((id) => {
      const node = tree.nodes.get(id);
      return node ? [node] : [];
    });

/** The nodes that BLOCK `nodeId` — its children in the drawn tree. Empty for
 * an id the tree does not hold. */
export function childrenOf(tree: Tree, nodeId: string): readonly TreeNode[] {
  return resolve(
    tree,
    tree.edges.filter((edge) => edge.blockedId === nodeId).map((edge) => edge.blockerId),
  );
}

/** The nodes `nodeId` BLOCKS — its parents in the drawn tree. On a
 * well-formed tree this is at most one; more than one is a
 * `multiple-parents` invariant violation, not an error here. */
export function parentsOf(tree: Tree, nodeId: string): readonly TreeNode[] {
  return resolve(
    tree,
    tree.edges.filter((edge) => edge.blockerId === nodeId).map((edge) => edge.blockedId),
  );
}

/** The goals: nodes that block nothing. Ascending by id. */
export function roots(tree: Tree): readonly TreeNode[] {
  return treeNodes(tree).filter((node) => parentsOf(tree, node.id).length === 0);
}

/**
 * `[node, its parent, …, the root]` — the chain a human or an agent needs to
 * understand what a node is FOR.
 *
 * `absent` for an id the tree does not hold (an empty array would be
 * indistinguishable from a root's own answer). `invalid` when the walk
 * revisits a node: a cycle has no root, and returning a truncated path would
 * hand the caller a lie. Under `multiple-parents` the smallest parent id is
 * taken, so the answer is at least deterministic while the invariant pass
 * reports the ambiguity.
 */
export function pathToRoot(tree: Tree, nodeId: string): TreeRead<readonly TreeNode[]> {
  const start = tree.nodes.get(nodeId);
  if (!start) return { status: "absent" };
  const path: TreeNode[] = [];
  const seen = new Set<string>();
  let current: TreeNode | undefined = start;
  while (current) {
    if (seen.has(current.id)) {
      return { status: "invalid", error: `cycle above ${nodeId} at ${current.id}` };
    }
    seen.add(current.id);
    path.push(current);
    current = parentsOf(tree, current.id)[0];
  }
  return { status: "ok", value: path };
}

/**
 * READINESS, defined once for the whole codebase: this node is not done, and
 * nothing is left blocking it.
 *
 * NOT "is a leaf". W1 originally wrote this as "no children at all", on the
 * argument that "ready leaves" should mean to an agent what the word leaf
 * means to a human reading the canvas. That was wrong, and C1's critique is
 * why: the frontier has to MOVE. A goal whose only blocker is done is exactly
 * the work to pick up next, and a strict-leaf rule reports it as not ready —
 * so once the initial leaves are finished, a tree with work left in it
 * answers "nothing is ready" to W6's tools and W7's digest. A vocabulary
 * quibble is not worth a frontier that stalls after one layer.
 *
 * A structural leaf still satisfies this vacuously, so the leaf case is not
 * lost; it is just no longer the definition.
 *
 * `approached` is deliberately not consulted: "we looked and nothing came up"
 * is a fact about a todo, not a reason to hide it.
 */
export function isReadyNode(tree: Tree, node: TreeNode): boolean {
  return (
    node.meta.state !== "done" &&
    childrenOf(tree, node.id).every((child) => child.meta.state === "done")
  );
}

/** Every node that is ready, ascending by id: the agent's work frontier. */
export function readyNodes(tree: Tree): readonly TreeNode[] {
  return treeNodes(tree).filter((node) => isReadyNode(tree, node));
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * The graph invariants: acyclic, one parent, every node reachable from a root.
 *
 * Endpoint existence — the third invariant the plan names — is enforced by
 * `readTree` itself (a dangling edge never enters the graph), so it is
 * reported there rather than restated here.
 *
 * Reachability is computed honestly rather than assumed: on an acyclic graph
 * it is always empty, because walking up from any node terminates at a root.
 * It is kept because a cycle makes it non-empty, and "these nodes are cut off
 * from every goal" is the fact a human needs, which "there is a cycle" alone
 * does not give them.
 */
export function checkTreeInvariants(tree: Tree): readonly TreeProblem[] {
  const problems: TreeProblem[] = [];

  for (const node of treeNodes(tree)) {
    const parents = parentsOf(tree, node.id);
    if (parents.length > 1) {
      problems.push({
        kind: "multiple-parents",
        subjects: [node.id, ...parents.map((parent) => parent.id)],
        detail: `${node.id} blocks ${parents.length} nodes (${parents.map((p) => p.id).join(", ")}); a tree node blocks at most one`,
      });
    }
  }

  problems.push(...findCycles(tree));

  const reached = new Set<string>();
  const queue = roots(tree).map((root) => root.id);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (reached.has(id)) continue;
    reached.add(id);
    queue.push(...childrenOf(tree, id).map((child) => child.id));
  }
  for (const node of treeNodes(tree)) {
    if (reached.has(node.id)) continue;
    problems.push({
      kind: "unreachable",
      subjects: [node.id],
      detail: `${node.id} is cut off from every root of ${tree.treeId}`,
    });
  }

  return sortProblems(problems);
}

/**
 * Cycles, walking the blocker -> blocked direction.
 *
 * Iterative DFS with the classic three colours. Each cycle is reported once,
 * rotated to start at its smallest id, so the SAME cycle is described the
 * same way whichever node the walk happened to enter it through — the raw
 * stack slice describes one cycle several ways, which would make W11 see two
 * different problems where there is one.
 */
function findCycles(tree: Tree): readonly TreeProblem[] {
  const found = new Map<string, readonly string[]>();
  const done = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  const visit = (start: string): void => {
    // Explicit work list rather than recursion: a deep tree is a plausible
    // shape here and a blown call stack would be an outage, not a bug report.
    const work: { id: string; entered: boolean }[] = [{ id: start, entered: false }];
    while (work.length > 0) {
      const step = work[work.length - 1];
      if (!step.entered) {
        step.entered = true;
        if (done.has(step.id)) {
          work.pop();
          continue;
        }
        if (onStack.has(step.id)) {
          const at = stack.indexOf(step.id);
          const cycle = canonicalRotation(stack.slice(at));
          found.set(cycle.join(" "), cycle);
          work.pop();
          continue;
        }
        onStack.add(step.id);
        stack.push(step.id);
        for (const parent of parentsOf(tree, step.id)) {
          work.push({ id: parent.id, entered: false });
        }
        continue;
      }
      work.pop();
      // Unwind: this node's whole subtree has been explored.
      if (stack[stack.length - 1] === step.id) {
        stack.pop();
        onStack.delete(step.id);
        done.add(step.id);
      }
    }
  };

  for (const node of treeNodes(tree)) visit(node.id);

  return [...found.values()]
    .sort((a, b) => compareStrings(a.join(), b.join()))
    .map((cycle) => ({
      kind: "cycle" as const,
      subjects: cycle,
      detail: `${cycle.join(" blocks ")} blocks ${cycle[0]}`,
    }));
}

/** Rotate a cycle so it starts at its smallest id, preserving order. */
function canonicalRotation(cycle: readonly string[]): readonly string[] {
  let at = 0;
  for (let i = 1; i < cycle.length; i += 1) if (cycle[i] < cycle[at]) at = i;
  return [...cycle.slice(at), ...cycle.slice(0, at)];
}
