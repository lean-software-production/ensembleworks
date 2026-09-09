// W5 — the TREE SERVICE: the query surface the server exposes over a live
// room's document.
//
// W1 turned a document into a graph. This module is what everything OUTSIDE
// the tree code is allowed to ask: the agent read tools (W6), the per-turn
// digest (W7), the write guards (W10), `bb canvas tree` (W13). None of them
// rebuild a tree from shapes, and none of them touch W1's value types — so
// there is exactly one place to change when the encoding grows.
//
// THREE PROPERTIES THIS LAYER OWES ITS CALLERS, none of which W1 owes:
//
//  1. EVERY ANSWER IS PLAIN, SERIALISABLE DATA. W1's `TreeNode` carries the
//     whole `Shape` it came from, and `Tree.nodes` is a Map. Both are correct
//     for a model and wrong at a boundary where the next hop is JSON: a Map
//     serialises to `{}`, and a Shape ships a document's worth of props to an
//     agent that asked for a title. `TreeNodeView` is the flattened value.
//  2. A MISS IS DATA, NOT A THROW. An agent holds ids from a previous turn
//     and the human has since deleted one; "no such node" is a NORMAL answer,
//     several times a session. `TreeQuery<T>` makes the caller handle it, and
//     keeps a stale id from becoming a tool-call outage.
//  3. OUTPUT IS BOUNDED AND SAYS SO. `subtree` takes a depth and `digest`
//     takes a character budget, and both REPORT what they dropped (`elided`,
//     `truncated`). W7's instructions have a 4096-char ceiling; a digest that
//     silently overflowed it — or silently omitted half a tree — would leave
//     an agent confidently reasoning about a tree that is not there.
//
// NO CACHE, ON PURPOSE. The document is a live CRDT that a human is editing
// while the agent reads it; the service calls `document()` exactly ONCE per
// public method and derives the whole answer from that one value. Once per
// call, not once per service: an answer can never straddle two states, and no
// invalidation signal has to exist. The cost is that a query is O(shapes) —
// acceptable at the sizes a canvas page holds, and the honest place to
// revisit if it ever is not.
//
// PURE, LIKE W1. The input is a `document()` thunk over a canvas-model value:
// no bb SDK, no CanvasDoc, no Loro, no DOM, no clock, no PRNG. The server
// wiring that turns `room.peer.doc` into that thunk is `doc-source.ts`, one
// function, so this module stays testable against a fixture document.
import { plainText, type CanvasDocument } from "@ensembleworks/canvas-model";
import type { NodeState } from "./encoding.js";
import {
  checkTreeInvariants,
  childrenOf,
  listTrees,
  parentsOf,
  pathToRoot,
  readTree,
  readyLeaves,
  roots,
  treeNodes,
  type Tree,
  type TreeNode,
  type TreeProblem,
} from "./model.js";

// ---------------------------------------------------------------------------
// What a caller gets back
// ---------------------------------------------------------------------------

/**
 * One node, flattened for a boundary. Everything a reader has asked for so
 * far, and nothing that needs the document to interpret.
 *
 * `parentIds` is a LIST even though a well-formed tree node blocks at most
 * one thing. W1 reports `multiple-parents` as a violation without refusing to
 * answer, and a `parentId: string | null` here would have to pick one and
 * present the guess as fact — the ambiguity would vanish precisely where a
 * human is trying to understand why their tree looks wrong.
 */
export interface TreeNodeView {
  readonly id: string;
  readonly treeId: string;
  /** The note's text, as canvas-model reads it. `""` for an empty note. */
  readonly title: string;
  readonly state: NodeState;
  readonly approached: boolean;
  readonly context: string;
  /** The nodes this one BLOCKS. Empty for a root. */
  readonly parentIds: readonly string[];
  /** The nodes that BLOCK this one — its children in the drawn tree. */
  readonly childIds: readonly string[];
  readonly isRoot: boolean;
  /** No blockers left and not done: this is work that could start now. */
  readonly isReady: boolean;
}

/** Why a query could not answer. Every value is a NORMAL outcome, not a bug. */
export type TreeQueryFailure =
  /** No node with that id in any tree of this document. */
  | "no-such-node"
  /** No page with that id at all. (A page that merely LOST its tree mark is
   * still served — the human's nodes are on it, and the missing mark shows up
   * as a problem in the digest.) */
  | "no-such-tree"
  /** The tree is cyclic, so the question has no truthful answer. */
  | "cycle";

export type TreeQuery<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: TreeQueryFailure; readonly detail: string };

/** A node with its blockers nested beneath it, cut to a depth. */
export interface SubtreeView {
  readonly node: TreeNodeView;
  readonly children: readonly SubtreeView[];
  /** Why this node's blockers are NOT listed, or `null` if they all are.
   * `"depth"` — the cut fell here. `"cycle"` — this node is already on the
   * path above, so descending would not terminate. */
  readonly elided: "depth" | "cycle" | null;
}

export interface TreeDigest {
  readonly treeId: string;
  /** The rendered outline, at most `maxChars` long. */
  readonly text: string;
  readonly counts: {
    readonly nodes: number;
    readonly todo: number;
    readonly wip: number;
    readonly done: number;
    readonly edges: number;
    readonly problems: number;
  };
  readonly roots: readonly string[];
  readonly readyLeaves: readonly string[];
  /** Structural (W1's `readTree`) and graph (`checkTreeInvariants`) problems,
   * together — a caller of a digest wants "what is wrong with this tree", not
   * a lesson in which pass found it. */
  readonly problems: readonly TreeProblem[];
  /** True when `text` does not describe every node. `counts` is always whole. */
  readonly truncated: boolean;
}

/** Default ceiling on a digest's `text`.
 *
 * Deliberately well under W7's 4096-char instruction budget: the digest is
 * ONE contribution to a turn's instructions, not the whole of it, and a
 * default that exactly filled the ceiling would leave W7 nothing to add and
 * no room to say what changed. */
export const DIGEST_MAX_CHARS = 2_000;

/** Where the service reads the document. One thunk, called once per query. */
export interface TreeDocumentSource {
  document(): CanvasDocument;
}

export interface TreeService {
  /** The treeIds in the document: pages carrying a valid mark, ascending. */
  trees(): readonly string[];
  node(nodeId: string): TreeQuery<TreeNodeView>;
  /** The nodes that BLOCK `nodeId`, ascending by id. */
  children(nodeId: string): TreeQuery<readonly TreeNodeView[]>;
  /** `[node, what it blocks, …, the root]`. */
  pathToRoot(nodeId: string): TreeQuery<readonly TreeNodeView[]>;
  /** `nodeId` with its blockers nested beneath it, `depth` levels deep. */
  subtree(nodeId: string, depth: number): TreeQuery<SubtreeView>;
  /** The startable work in one tree, ascending by id. */
  readyLeaves(treeId: string): TreeQuery<readonly TreeNodeView[]>;
  digest(treeId: string, options?: { maxChars?: number }): TreeQuery<TreeDigest>;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export function createTreeService(source: TreeDocumentSource): TreeService {
  /** Read the document ONCE and locate the node's tree within it. Every
   * node-addressed query starts here, so a caller never has to know (or
   * guess, or cache) which page a node lives on — the shape says so. */
  const locate = (nodeId: string): TreeQuery<{ tree: Tree; node: TreeNode }> => {
    const doc = source.document();
    const treeId = treeIdOfShape(doc, nodeId);
    if (treeId === null) {
      return miss("no-such-node", `no node ${nodeId} in any tree of this document`);
    }
    const tree = readTree(doc, treeId);
    const node = tree.nodes.get(nodeId);
    if (!node) {
      // The shape claims a tree but did not read as a node of it: W1 has
      // already recorded WHY (invalid-node, foreign-kind). Say which, rather
      // than the bare "not found" that sends a human looking for a deletion
      // that never happened.
      const why = tree.problems.find((problem) => problem.subjects.includes(nodeId));
      return miss(
        "no-such-node",
        why ? `${nodeId} is not a usable node of ${treeId}: ${why.detail}` : `no node ${nodeId} in ${treeId}`,
      );
    }
    return { ok: true, value: { tree, node } };
  };

  /** Read the document ONCE for a tree-addressed query. A page that exists
   * but lost its mark is still served — see `TreeQueryFailure`. */
  const load = (treeId: string): TreeQuery<Tree> => {
    const doc = source.document();
    if (!doc.pages.some((page) => page.id === treeId)) {
      return miss("no-such-tree", `no page ${treeId} in this document`);
    }
    return { ok: true, value: readTree(doc, treeId) };
  };

  return {
    trees: () => listTrees(source.document()),

    node: (nodeId) => map(locate(nodeId), ({ tree, node }) => viewOf(tree, node)),

    children: (nodeId) =>
      map(locate(nodeId), ({ tree, node }) =>
        childrenOf(tree, node.id).map((child) => viewOf(tree, child)),
      ),

    pathToRoot: (nodeId) =>
      flatMap(locate(nodeId), ({ tree, node }) => {
        const path = pathToRoot(tree, node.id);
        if (path.status === "invalid") return miss("cycle", path.error);
        if (path.status === "absent") return miss("no-such-node", `no node ${nodeId} in ${tree.treeId}`);
        return { ok: true, value: path.value.map((step) => viewOf(tree, step)) };
      }),

    subtree: (nodeId, depth) =>
      map(locate(nodeId), ({ tree, node }) => buildSubtree(tree, node, depth, new Set())),

    readyLeaves: (treeId) =>
      map(load(treeId), (tree) => readyLeaves(tree).map((leaf) => viewOf(tree, leaf))),

    digest: (treeId, options) =>
      map(load(treeId), (tree) => buildDigest(tree, options?.maxChars ?? DIGEST_MAX_CHARS)),
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Which tree a shape id claims, or null. Read off the shape's own
 * `meta.tree` rather than by scanning every tree, so the cost is one pass
 * whatever the document holds. */
function treeIdOfShape(doc: CanvasDocument, shapeId: string): string | null {
  const shape = doc.shapes.find((candidate) => candidate.id === shapeId);
  const treeId = shape?.meta["tree"];
  return typeof treeId === "string" && treeId.length > 0 ? treeId : null;
}

function viewOf(tree: Tree, node: TreeNode): TreeNodeView {
  const parentIds = parentsOf(tree, node.id).map((parent) => parent.id);
  const childIds = childrenOf(tree, node.id).map((child) => child.id);
  return {
    id: node.id,
    treeId: tree.treeId,
    title: plainText(node.shape),
    state: node.meta.state,
    approached: node.meta.approached,
    context: node.meta.context,
    parentIds,
    childIds,
    isRoot: parentIds.length === 0,
    isReady: node.meta.state !== "done" && childIds.length === 0,
  };
}

/**
 * The subtree, blockers nested under what they block.
 *
 * `seen` is the path FROM THE ROOT OF THIS WALK, not a global visited set: on
 * a cyclic tree the walk must stop, but on a merely `multiple-parents` tree a
 * node legitimately appears under two parents and must be shown under both.
 * A global set would silently drop the second one.
 */
function buildSubtree(
  tree: Tree,
  node: TreeNode,
  depth: number,
  seen: ReadonlySet<string>,
): SubtreeView {
  const view = viewOf(tree, node);
  if (seen.has(node.id)) return { node: view, children: [], elided: "cycle" };
  if (depth <= 0) {
    return { node: view, children: [], elided: view.childIds.length > 0 ? "depth" : null };
  }
  const nextSeen = new Set([...seen, node.id]);
  const children = childrenOf(tree, node.id).map((child) =>
    buildSubtree(tree, child, depth - 1, nextSeen),
  );
  return { node: view, children, elided: null };
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

/**
 * A whole tree, compressed to something an agent can be handed every turn.
 *
 * The rendering DEGRADES IN A FIXED ORDER, and the order is the point: the
 * header (counts) and the problems survive longest, because they are what
 * tells a reader that what follows is partial and what is wrong with it. The
 * outline is trimmed from the tail, and the number of nodes it dropped is
 * stated. Nothing here re-flows or summarises prose — a digest that guessed
 * at what mattered would be a worse lie than a short one.
 */
function buildDigest(tree: Tree, maxChars: number): TreeDigest {
  const nodes = treeNodes(tree);
  const problems = [...tree.problems, ...checkTreeInvariants(tree)];
  const rootIds = roots(tree).map((root) => root.id);
  const readyIds = readyLeaves(tree).map((leaf) => leaf.id);
  const counts = {
    nodes: nodes.length,
    todo: nodes.filter((node) => node.meta.state === "todo").length,
    wip: nodes.filter((node) => node.meta.state === "wip").length,
    done: nodes.filter((node) => node.meta.state === "done").length,
    edges: tree.edges.length,
    problems: problems.length,
  };

  const header = `tree ${tree.treeId} — ${counts.nodes} nodes (${counts.done} done, ${counts.wip} wip, ${counts.todo} todo), ${counts.edges} edges`;
  // Both of these are CAPPED, not just the outline. A wide tree has hundreds
  // of ready leaves and a badly broken one has hundreds of problems; either
  // list, rendered whole, eats a 2000-char budget on its own and leaves no
  // room for the note saying so. Capping here is what keeps the floor below
  // an actual floor.
  const problemLines = capped(
    problems.map((problem) => `! ${problem.kind}: ${problem.subjects.join(", ")}`),
    PROBLEMS_IN_DIGEST,
    (n) => `! … and ${n} more problems`,
  );
  const readyLine =
    readyIds.length === 0
      ? "ready: none"
      : `ready: ${readyIds.slice(0, READY_IN_DIGEST).join(", ")}${
          readyIds.length > READY_IN_DIGEST
            ? ` … and ${readyIds.length - READY_IN_DIGEST} more`
            : ""
        }`;
  const listsCut =
    problems.length > PROBLEMS_IN_DIGEST || readyIds.length > READY_IN_DIGEST;
  const outline = outlineOf(tree);

  // Everything except the outline is the floor: it is what makes a truncated
  // digest still orienting rather than merely short.
  const fixed = [header, ...problemLines, readyLine];
  const fixedLength = fixed.join("\n").length;

  const kept: string[] = [];
  let used = fixedLength;
  for (const line of outline) {
    const note = `… ${counts.nodes - kept.length} of ${counts.nodes} nodes not shown`;
    // Only keep a line if the "not shown" note it might need still fits after
    // it — otherwise the last line in would push the honesty out.
    if (used + 1 + line.length + 1 + note.length > maxChars) break;
    kept.push(line);
    used += 1 + line.length;
  }

  const shown = kept.length;
  const truncated = shown < outline.length;
  const body = [
    ...fixed,
    ...kept,
    ...(truncated ? [`… ${counts.nodes - shown} of ${counts.nodes} nodes not shown`] : []),
  ].join("\n");

  return {
    treeId: tree.treeId,
    // A budget too small even for the header is a caller's choice, not a
    // reason to overshoot it: hard-cut rather than exceed what was asked for.
    text: body.length <= maxChars ? body : body.slice(0, maxChars),
    counts,
    roots: rootIds,
    readyLeaves: readyIds,
    problems,
    // `truncated` is about the TEXT, not the structured fields: `problems`
    // and `readyLeaves` above are always whole, however short the prose got.
    truncated: truncated || listsCut || body.length > maxChars,
  };
}

/** How many ready leaves a digest's `ready:` line names before it counts the
 * rest. Ten is "enough to pick from"; the full list is in `readyLeaves`. */
const READY_IN_DIGEST = 10;

/** How many problems a digest spells out before it counts the rest. The full
 * list is in `problems`, and W11 is the thing that reads it in full. */
const PROBLEMS_IN_DIGEST = 10;

/** First `limit` lines, plus one line saying how many were dropped. */
function capped(
  lines: readonly string[],
  limit: number,
  note: (dropped: number) => string,
): readonly string[] {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), note(lines.length - limit)];
}

/**
 * One line per node: roots first, blockers indented under what they block.
 *
 * A node reached twice (a `multiple-parents` tree) is listed at its first
 * position only, so the outline stays one line per node and the line count is
 * the node count — which is what makes the "N of M not shown" note true.
 * Nodes no root reaches (only possible under a cycle) are appended, because
 * omitting them would hide exactly the state a reader is trying to fix.
 */
function outlineOf(tree: Tree): readonly string[] {
  const lines: string[] = [];
  const listed = new Set<string>();
  const walk = (node: TreeNode, depth: number): void => {
    if (listed.has(node.id)) return;
    listed.add(node.id);
    lines.push(lineOf(node, depth, tree));
    for (const child of childrenOf(tree, node.id)) walk(child, depth + 1);
  };
  for (const root of roots(tree)) walk(root, 0);
  for (const node of treeNodes(tree)) {
    if (listed.has(node.id)) continue;
    listed.add(node.id);
    lines.push(lineOf(node, 0, tree));
  }
  return lines;
}

/** `  - shape:api [wip] Tree service` — id FIRST, because an id is what an
 * agent needs to ask the next question with, and a title is what a human
 * recognises. Both, every line, so neither reader has to cross-reference. */
function lineOf(node: TreeNode, depth: number, tree: Tree): string {
  const title = plainText(node.shape).split("\n")[0] ?? "";
  const marks = [
    node.meta.approached ? "approached" : "",
    node.meta.state !== "done" && childrenOf(tree, node.id).length === 0 ? "ready" : "",
  ].filter(Boolean);
  return `${"  ".repeat(depth)}- ${node.id} [${node.meta.state}]${title ? ` ${title}` : ""}${
    marks.length > 0 ? ` (${marks.join(", ")})` : ""
  }`;
}

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

const miss = <T>(reason: TreeQueryFailure, detail: string): TreeQuery<T> => ({
  ok: false,
  reason,
  detail,
});

const map = <A, B>(result: TreeQuery<A>, fn: (value: A) => B): TreeQuery<B> =>
  result.ok ? { ok: true, value: fn(result.value) } : result;

const flatMap = <A, B>(result: TreeQuery<A>, fn: (value: A) => TreeQuery<B>): TreeQuery<B> =>
  result.ok ? fn(result.value) : result;
