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
  isReadyNode,
  listTrees,
  parentsOf,
  pathToRoot,
  readTree,
  readyNodes,
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
  /** Not done, and every blocker of it is done: work that could start now.
   * W1's `isReadyNode` is the single definition — see the note there on why
   * this is NOT "has no children". */
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
  /** Every ready node's id — the same list `ready(treeId)` answers with. */
  readonly ready: readonly string[];
  /** Structural (W1's `readTree`) and graph (`checkTreeInvariants`) problems,
   * together — a caller of a digest wants "what is wrong with this tree", not
   * a lesson in which pass found it. */
  readonly problems: readonly TreeProblem[];
  /** True when `text` is not the whole truth — a line was dropped, a line was
   * cut short, or a list hit its entry cap. `counts` is always whole. */
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
  /** The startable work in one tree, ascending by id: every node that is not
   * done and has nothing unfinished under it. Named `ready`, not
   * `readyLeaves`, because these are not necessarily leaves — a goal whose
   * blockers are all done is startable and must be in this list. */
  ready(treeId: string): TreeQuery<readonly TreeNodeView[]>;
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

    ready: (treeId) =>
      map(load(treeId), (tree) => readyNodes(tree).map((node) => viewOf(tree, node))),

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
    isReady: isReadyNode(tree, node),
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
 * The rendering DEGRADES IN A FIXED ORDER — counts, then the frontier, then
 * the problems, then the outline — and every line is clamped to a share of
 * the budget so no single one of them can starve the rest (`fitLines`). What
 * survives longest is what a reader needs to know that the rest is partial:
 * where the work is, and what is wrong. Nothing here re-flows or summarises
 * prose — a digest that guessed at what mattered would be a worse lie than a
 * short one.
 */
function buildDigest(tree: Tree, maxChars: number): TreeDigest {
  const nodes = treeNodes(tree);
  const problems = [...tree.problems, ...checkTreeInvariants(tree)];
  const rootIds = roots(tree).map((root) => root.id);
  const readyIds = readyNodes(tree).map((node) => node.id);
  const counts = {
    nodes: nodes.length,
    todo: nodes.filter((node) => node.meta.state === "todo").length,
    wip: nodes.filter((node) => node.meta.state === "wip").length,
    done: nodes.filter((node) => node.meta.state === "done").length,
    edges: tree.edges.length,
    problems: problems.length,
  };

  // THE ORDER IS THE PRIORITY. `fitLines` keeps lines from the front and drops
  // from the back, so this list is a ranking: the counts orient a reader, the
  // frontier is the one thing they can act on, the problems say why the rest
  // may be wrong, and the outline is the detail that a small budget can lose.
  // `ready` sits ABOVE the problems deliberately — C1's probe was one 240-node
  // cycle whose single problem line pushed `ready:` out of the text entirely.
  const readyLine =
    readyIds.length === 0
      ? "ready: none"
      : `ready: ${readyIds.slice(0, READY_IN_DIGEST).join(", ")}${
          readyIds.length > READY_IN_DIGEST
            ? ` … and ${readyIds.length - READY_IN_DIGEST} more`
            : ""
        }`;
  const problemLines = capped(
    problems.map((problem) => `! ${problem.kind}: ${problem.subjects.join(", ")}`),
    PROBLEMS_IN_DIGEST,
    (n) => `! … and ${n} more problems`,
  );
  const listsCut = problems.length > PROBLEMS_IN_DIGEST || readyIds.length > READY_IN_DIGEST;

  const fitted = fitLines(
    [
      `tree ${tree.treeId} — ${counts.nodes} nodes (${counts.done} done, ${counts.wip} wip, ${counts.todo} todo), ${counts.edges} edges`,
      readyLine,
      ...problemLines,
      ...outlineOf(tree),
    ],
    maxChars,
  );

  return {
    treeId: tree.treeId,
    text: fitted.text,
    counts,
    roots: rootIds,
    ready: readyIds,
    problems,
    // `truncated` is about the TEXT, not the structured fields: `problems`
    // and `ready` above are always whole, however short the prose got.
    truncated: fitted.truncated || listsCut,
  };
}

/** How many ready nodes a digest's `ready:` line names before it counts the
 * rest. Ten is "enough to pick from"; the full list is in `ready`. A SECOND
 * limit, not the budget: `fitLines` is what bounds the text. */
const READY_IN_DIGEST = 10;

/** How many problems a digest spells out before it counts the rest. The full
 * list is in `problems`, and W11 is the thing that reads it in full. */
const PROBLEMS_IN_DIGEST = 10;

/** No line is rendered shorter than this: below it a line is all ellipsis and
 * no information, so the honest move is to drop it and say so. */
const MIN_DIGEST_LINE = 40;

/** No single line may take more than this share of the whole budget. One
 * cycle problem can name every node in the tree, and one note can carry a
 * 5,000-character title; without a per-line ceiling either of them spends the
 * budget alone and everything below it — including the marker admitting so —
 * is pushed out. */
const LINE_SHARE = 8;

/** First `limit` lines, plus one line saying how many were dropped. */
function capped(
  lines: readonly string[],
  limit: number,
  note: (dropped: number) => string,
): readonly string[] {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), note(lines.length - limit)];
}

/** `…`-terminated, so a cut line SAYS it was cut. Never longer than `max`. */
function clamp(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Fit lines into a character budget, in priority order, and never lie about it.
 *
 * THE BUDGET IS CHARACTERS, NOT ENTRIES. Counting entries — which is what this
 * did before C1's critique — bounds nothing, because one entry can be
 * arbitrarily long; a single big cycle rendered one problem line longer than
 * the whole budget, and the final hard cut then removed the frontier and every
 * omission marker from the text while `truncated: true` survived only in the
 * structured object that W7 does not pass on.
 *
 * So: every line is clamped to its share of the budget (and a clamped line
 * ends in `…`), lines are kept from the front while they fit, and the space
 * for the "N of M lines not shown" marker is RESERVED BEFORE any line is
 * kept — the marker can never be the thing that gets cut.
 *
 * EXPORTED FOR W7. The per-turn brief (`instructions.ts`) ranks its own lines
 * above this digest and has the same budget problem one level up. It calls
 * this rather than growing a second fitter, because two character budgets that
 * disagreed about what a cut line looks like would be the same defect C1 found
 * here, moved outwards.
 */
export function fitLines(
  lines: readonly string[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const total = lines.length;
  const marker = (dropped: number): string => `… ${dropped} of ${total} lines not shown`;
  // Reserved against the WIDEST marker this call could need (plus its
  // newline), so the reservation holds whenever the loop stops early.
  const reserve = marker(total).length + 1;
  const lineCap = Math.max(MIN_DIGEST_LINE, Math.floor(maxChars / LINE_SHARE));

  const kept: string[] = [];
  let used = 0;
  let clamped = false;
  for (let i = 0; i < total; i += 1) {
    const separator = kept.length > 0 ? 1 : 0;
    const isLast = i === total - 1;
    const room = maxChars - used - separator - (isLast ? 0 : reserve);
    const available = Math.min(room, lineCap);
    if (available < MIN_DIGEST_LINE) break;
    const line = clamp(lines[i] as string, available);
    if (line !== lines[i]) clamped = true;
    kept.push(line);
    used += separator + line.length;
  }

  const dropped = total - kept.length;
  if (kept.length === 0) {
    // A budget too small even for one line is the caller's choice, not a
    // reason to overshoot it: give them the highest-priority line, cut.
    return { text: clamp(lines[0] ?? "", maxChars), truncated: true };
  }
  return {
    text: dropped > 0 ? [...kept, marker(dropped)].join("\n") : kept.join("\n"),
    truncated: clamped || dropped > 0,
  };
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
    isReadyNode(tree, node) ? "ready" : "",
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
