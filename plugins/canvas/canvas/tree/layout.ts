// W3 — TIDY TREE LAYOUT. `Tree -> positions`, and nothing else.
//
// PURE, and this is the whole point of the module. Input is W1's `Tree` value;
// output is a list of `{nodeId, x, y}`. No doc handle, no `putShape`, no bb
// SDK, no DOM, no `Date.now`, no `Math.random`. Two peers holding the same
// converged state compute the same positions, so a reorganise one human
// triggers does not have to be broadcast as N moves to be agreed on — and a
// test can hold the whole answer in one `toEqual`.
//
// NOT AN AUTO-LAYOUT, which is a constraint from the plan and not a stylistic
// preference: "used when nodes are created and when a subtree is reorganised —
// never a continuous auto-layout that fights a human's drag". Nothing here
// subscribes to anything or runs on a commit. A caller invokes it at a moment
// a human asked for, applies the positions once, and stops.
//
// ORIENTATION: TOP-DOWN. The goal is at the top; the work that blocks it hangs
// below it; siblings run left to right. Three reasons, in order of weight:
//
//   1. It is already the picture. W1's module header, W0's encoding header and
//      the plan all draw this tree with the goal on top and its blockers under
//      it, and W10's `addChild` already places a new node BELOW its parent
//      (`NODE_STEP_Y`). Layout that inverted that would silently re-draw every
//      tree built so far into a shape nobody described.
//   2. It matches the arrow. An edge is drawn blocker -> blocked, so the
//      arrowhead points at the thing being unblocked. Top-down puts every
//      arrowhead pointing UP the page, into the goal: work flows up into what
//      it makes possible. Left-to-right would make that read right-to-left,
//      against the text direction of every label on the canvas.
//   3. Nodes are 200-wide notes with wrapped text. Depth is the axis that
//      grows without bound on a discovery tree, and growing it DOWN keeps the
//      canvas the shape of the screen it is read on.
//
// The `yaks` CLI draws left-to-right because it is indented TEXT, where depth
// has to be the horizontal axis; a 2D canvas has no such constraint.
//
// THE ALGORITHM is bounding-box packing: bottom-up, a subtree's width is the
// larger of its own node and its children's bands laid side by side; top-down,
// each node is centred over its own band. That is NOT full Reingold-Tilford —
// RT threads the left and right CONTOURS of adjacent subtrees so a tall thin
// one can nest under a wide short one, and gives narrower drawings. It is
// rejected here for one reason: RT's contour pass is where variable node sizes
// (a note grows with its text — `localBounds` reports 200 x 200+growY) turn a
// twenty-line function into a hundred-line one whose failure mode is a silent
// overlap. Box packing is wider than optimal and provably never overlaps,
// because sibling subtrees own disjoint x-intervals and a parent's band is
// strictly above its children's. The suite asserts the non-overlap directly.
// If a real tree ever looks too wide, RT is a drop-in replacement behind these
// same three entry points.
//
// CYCLES AND BROKEN TREES: total, always. A document can legitimately be
// mid-repair (W11), so layout must terminate and answer on any input readTree
// can produce. Every walk here is over a SPANNING FOREST built once, breadth
// first from the roots, where a node is claimed by exactly one parent — so a
// cycle cannot be walked twice and a node with two parents cannot be placed
// twice. Anything a root cannot reach is REPORTED as skipped, never placed at
// an invented position: layout does not repair, for the reason model.ts states
// (a reader that quietly fixes state hides what repair exists to find).
//
// QUARANTINE: nothing here mentions it, deliberately. Quarantine moves
// `meta.tree` to `meta.treeQuarantine` (encoding.ts), so a quarantined edge is
// not in `tree.edges` at all and the blindness is inherited from `readTree`
// rather than re-implemented. A second check here would be a second reading of
// the quarantine contract, and the two would rot apart.
import { localBounds, type Shape } from "@ensembleworks/canvas-model";
import type { TreeRead } from "./encoding.js";
import { childrenOf, roots, treeNodes, type Tree, type TreeNode } from "./model.js";

// ---------------------------------------------------------------------------
// The dimensions
// ---------------------------------------------------------------------------

/** Horizontal air between two sibling subtrees. */
export const SIBLING_GAP = 40;
/** Vertical air between the BOTTOM of a node and the top of its children. Not
 * a fixed row pitch: a note that has grown with its text pushes its own
 * children down, and only its own. */
export const LEVEL_GAP = 60;
/** Horizontal air between two whole goals on the same page. Wider than
 * `SIBLING_GAP` so the eye reads "two trees", not "one wide tree". */
export const ROOT_GAP = 120;

/** What a node measures when nothing else is known — canvas-model's own note
 * size. Used for a node that does not exist yet (`placeNewChild`'s newcomer);
 * every node that DOES exist is measured with `localBounds`. */
export const DEFAULT_NODE_SIZE = { w: 200, h: 200 } as const;

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface NodePlacement {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Why a node of the tree got no position.
 *
 * `unreachable` — no root can reach it, which on a well-formed tree is
 * impossible and in practice means a cycle (W11's ground). `foreign-frame` —
 * it hangs off a different parent shape than the layout's own root, so its
 * `x`/`y` are measured in another coordinate space and any number written here
 * would land somewhere arbitrary.
 */
export type SkipReason = "unreachable" | "foreign-frame";

export interface SkippedNode {
  readonly nodeId: string;
  readonly reason: SkipReason;
  readonly detail: string;
}

export interface TreeLayout {
  /** Ascending by node id, so two runs compare directly. */
  readonly placements: readonly NodePlacement[];
  /** Ascending by node id. */
  readonly skipped: readonly SkippedNode[];
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * THE PRIMARY ENTRY POINT: where does ONE new child of `parentId` go?
 *
 * Primary because it is the one W4 calls on every "add a blocker" gesture, and
 * because it is the only one that moves nothing. A creation gesture that
 * re-tidied the whole page would be a layout the human did not ask for, landing
 * on top of nodes they had positioned by hand — the "never fight a drag" rule
 * applies to creation too, not just to a background pass.
 *
 * The slot: beside the rightmost existing sibling on the same band, or centred
 * under the parent when there are none. It is a function of the SIBLINGS'
 * current positions rather than of a fresh layout, so a human who has dragged
 * this family somewhere gets the newcomer next to where they put it.
 *
 * It only avoids siblings. A slot that also dodged unrelated nodes would need
 * a whole-page occupancy test and would stop being a function of the tree;
 * `layoutSubtree` is the answer when the result is genuinely crowded.
 *
 * `absent` when the tree does not hold `parentId` — an empty position would be
 * indistinguishable from the origin.
 */
export function placeNewChild(
  tree: Tree,
  parentId: string,
  newSize: { w: number; h: number } = DEFAULT_NODE_SIZE,
): TreeRead<Position> {
  const parent = tree.nodes.get(parentId);
  if (!parent) return { status: "absent" };
  const parentSize = sizeOf(parent);

  // Siblings in another frame are measured in another space; including them
  // would put the newcomer at an arbitrary place on this one.
  const siblings = childrenOf(tree, parentId).filter(
    (child) => child.shape.parentId === parent.shape.parentId,
  );

  if (siblings.length === 0) {
    return {
      status: "ok",
      value: {
        x: parent.shape.x + (parentSize.w - newSize.w) / 2,
        y: parent.shape.y + parentSize.h + LEVEL_GAP,
      },
    };
  }

  let right = -Infinity;
  let top = Infinity;
  for (const sibling of siblings) {
    right = Math.max(right, sibling.shape.x + sizeOf(sibling).w);
    top = Math.min(top, sibling.shape.y);
  }
  return { status: "ok", value: { x: right + SIBLING_GAP, y: top } };
}

/**
 * Tidy ONE branch, leaving its root exactly where the human put it.
 *
 * The secondary entry point, and the one a "reorganise this" action wants: the
 * subtree is rebuilt around a fixed point, so the branch does not jump across
 * the canvas the moment it is tidied.
 *
 * LOCAL, NOT GLOBAL: it can leave this branch overlapping an unrelated one,
 * because it is not allowed to move anything outside the branch. `layoutTree`
 * is the call that guarantees a whole page does not overlap.
 *
 * `absent` for an id the tree does not hold.
 */
export function layoutSubtree(tree: Tree, rootId: string): TreeRead<TreeLayout> {
  const root = tree.nodes.get(rootId);
  if (!root) return { status: "absent" };
  return {
    status: "ok",
    value: layoutFrom(tree, [root], root.shape.parentId, {
      x: root.shape.x,
      y: root.shape.y,
      // The root is centred over its own band like any other node, so the
      // forest origin has to be shifted back by that centring to land the root
      // itself on the pinned point.
      pinRoot: true,
    }),
  };
}

/**
 * Tidy the WHOLE page: every goal, side by side, guaranteed not to overlap.
 *
 * Anchored at the smallest-id root's current position rather than at the
 * origin, so a reorganise leaves the page roughly where the human was looking.
 * Goals are packed left to right in ascending id order, `ROOT_GAP` apart.
 *
 * Roots living in a different frame from the first one are skipped rather than
 * dragged into a coordinate space they are not in; `layoutSubtree` tidies one
 * of those in place.
 */
export function layoutTree(tree: Tree): TreeLayout {
  const allRoots = roots(tree);
  if (allRoots.length === 0) {
    // No node blocks nothing: every node is inside a cycle. Nothing to lay out
    // from, and inventing a root would be repair.
    return { placements: [], skipped: skippedRest(tree, new Set(), undefined) };
  }
  const frame = allRoots[0].shape.parentId;
  const inFrame = allRoots.filter((root) => root.shape.parentId === frame);
  return layoutFrom(tree, inFrame, frame, {
    x: allRoots[0].shape.x,
    y: allRoots[0].shape.y,
    pinRoot: false,
  });
}

// ---------------------------------------------------------------------------
// The layout itself
// ---------------------------------------------------------------------------

/** A node's rendered size, from canvas-model — a note grows with its text, so
 * this is never a constant. */
function sizeOf(node: TreeNode): { w: number; h: number } {
  const { maxX, maxY } = localBounds(node.shape as Shape);
  return { w: maxX, h: maxY };
}

interface Forest {
  readonly roots: readonly string[];
  /** parent id -> its children IN THIS FOREST, ascending. Every node appears
   * as a child of at most one parent. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly claimed: ReadonlySet<string>;
}

/**
 * The spanning forest: the acyclic structure everything below walks.
 *
 * Breadth-first from the roots, roots ascending and children ascending, with
 * one global claimed-set. That single set is what makes the rest of this file
 * safe on a broken tree — a cycle cannot be re-entered, and a node with two
 * parents is claimed by whichever parent BFS reaches first (the shallower one,
 * ties broken by the smaller id). Deterministic, and the ambiguity is already
 * reported by `checkTreeInvariants`; layout's job is to draw something rather
 * than to argue about it.
 *
 * A child in another frame is not claimed: its coordinates are not comparable
 * with this forest's.
 */
function spanningForest(tree: Tree, rootNodes: readonly TreeNode[], frame: string): Forest {
  const rootIds = rootNodes.map((root) => root.id);
  const claimed = new Set<string>(rootIds);
  const children = new Map<string, readonly string[]>();
  const queue = [...rootIds];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const kids: string[] = [];
    for (const child of childrenOf(tree, id)) {
      if (claimed.has(child.id)) continue;
      if (child.shape.parentId !== frame) continue;
      claimed.add(child.id);
      kids.push(child.id);
      queue.push(child.id);
    }
    children.set(id, kids);
  }
  return { roots: rootIds, children, claimed };
}

/**
 * Pass 1, bottom-up: how wide is each subtree?
 *
 * `max(own width, the children's bands laid side by side)`. Iterative with an
 * explicit work list rather than recursion, for the reason `findCycles` gives:
 * a deep tree is a plausible shape here and a blown call stack is an outage,
 * not a bug report.
 */
function subtreeWidths(
  forest: Forest,
  sizeById: (id: string) => { w: number; h: number },
): Map<string, number> {
  const widths = new Map<string, number>();
  for (const root of forest.roots) {
    const work: { id: string; entered: boolean }[] = [{ id: root, entered: false }];
    while (work.length > 0) {
      const step = work[work.length - 1];
      const kids = forest.children.get(step.id) ?? [];
      if (!step.entered) {
        step.entered = true;
        // Children go on top of the stack, so they are finished before this
        // node is popped and their widths are all known when it is.
        for (const kid of kids) work.push({ id: kid, entered: false });
        continue;
      }
      work.pop();
      widths.set(step.id, Math.max(sizeById(step.id).w, bandWidth(kids, widths)));
    }
  }
  return widths;
}

/** The total width of a row of subtrees, gaps included. */
function bandWidth(ids: readonly string[], widths: ReadonlyMap<string, number>): number {
  return ids.reduce(
    (total, id, i) => total + (widths.get(id) ?? 0) + (i > 0 ? SIBLING_GAP : 0),
    0,
  );
}

/** Pass 2, top-down: hand every node a position inside the width its subtree
 * was given. Iterative for the same reason as pass 1. */
function placeForest(
  forest: Forest,
  widths: ReadonlyMap<string, number>,
  sizeById: (id: string) => { w: number; h: number },
  origin: Position,
): NodePlacement[] {
  const placements: NodePlacement[] = [];
  let cursorX = origin.x;
  for (const root of forest.roots) {
    const work: { id: string; left: number; top: number }[] = [
      { id: root, left: cursorX, top: origin.y },
    ];
    while (work.length > 0) {
      const { id, left, top } = work.pop() as { id: string; left: number; top: number };
      const size = sizeById(id);
      const width = widths.get(id) ?? size.w;
      placements.push({ nodeId: id, x: left + (width - size.w) / 2, y: top });

      const kids = forest.children.get(id) ?? [];
      let kidLeft = left + (width - bandWidth(kids, widths)) / 2;
      const kidTop = top + size.h + LEVEL_GAP;
      const frames: { id: string; left: number; top: number }[] = [];
      for (const kid of kids) {
        frames.push({ id: kid, left: kidLeft, top: kidTop });
        kidLeft += (widths.get(kid) ?? 0) + SIBLING_GAP;
      }
      // Reversed onto the LIFO work list so the walk runs left to right —
      // irrelevant to the geometry, but it keeps a debug trace readable.
      for (let i = frames.length - 1; i >= 0; i -= 1) work.push(frames[i]);
    }
    cursorX += (widths.get(root) ?? 0) + ROOT_GAP;
  }
  return placements;
}

function layoutFrom(
  tree: Tree,
  rootNodes: readonly TreeNode[],
  frame: string,
  anchor: Position & { pinRoot: boolean },
): TreeLayout {
  const forest = spanningForest(tree, rootNodes, frame);
  const sizeById = (id: string): { w: number; h: number } => {
    const node = tree.nodes.get(id);
    return node ? sizeOf(node) : { ...DEFAULT_NODE_SIZE };
  };
  const widths = subtreeWidths(forest, sizeById);

  // Pinning: the root is centred inside its own subtree width like everything
  // else, so to land it exactly on the anchor the whole forest slides left by
  // that centring offset.
  const first = forest.roots[0];
  const centring =
    anchor.pinRoot && first !== undefined
      ? ((widths.get(first) ?? 0) - sizeById(first).w) / 2
      : 0;

  const placements = placeForest(forest, widths, sizeById, {
    x: anchor.x - centring,
    y: anchor.y,
  });

  return {
    placements: placements.slice().sort(byNodeId),
    skipped: skippedRest(tree, forest.claimed, frame),
  };
}

const byNodeId = (a: { nodeId: string }, b: { nodeId: string }): number =>
  a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;

/** Every node of the tree that got no position, and why. Ascending by id. */
function skippedRest(
  tree: Tree,
  placed: ReadonlySet<string>,
  frame: string | undefined,
): readonly SkippedNode[] {
  const skipped: SkippedNode[] = [];
  for (const node of treeNodes(tree)) {
    if (placed.has(node.id)) continue;
    if (frame !== undefined && node.shape.parentId !== frame) {
      skipped.push({
        nodeId: node.id,
        reason: "foreign-frame",
        detail: `${node.id} sits inside ${node.shape.parentId}, not ${frame}, so its position is measured in another space`,
      });
      continue;
    }
    skipped.push({
      nodeId: node.id,
      reason: "unreachable",
      detail: `${node.id} is not reachable from any root of ${tree.treeId}`,
    });
  }
  return skipped.sort(byNodeId);
}
