// W16 — THE WRITE SEAM: what a write to a discovery tree IS, and the protocol
// every one of them obeys. No operation lives here.
//
// THIS MODULE IS THE FACE THE REST OF THE PLUGIN ALREADY USED. Before the
// split, seven production modules and five suites imported from `writes.ts`,
// and every single one of them took only what is now in this file — the
// target interface, the result types, the writer interface, the title cap.
// Not one of them imported an operation. The boundary drawn here is therefore
// not a new idea: it is the one the importers had already drawn, made
// explicit, so that "the contract" and "the five mutations that satisfy it"
// stop being one 931-line module.
//
// WHAT LIVES HERE, and the rule that decides it: everything an operation needs
// in order to BE an operation, and nothing that is about any particular one.
// The seam (`TreeWriteTarget`), the vocabulary of an answer (`TreeWrite`,
// `TreeWriteRefusal`, `TreeWriteOutcome`), the protocol (`locateNode`,
// `applyWrite` — find, mutate, commit, read the whole tree back, report what
// appeared), and the shared guards the protocol needs (a title check, a
// context check, id minting, index minting). `writes.ts` holds the five
// additive operations; `reparent.ts` holds the one that displaces.
//
// THE NO-DELETE NARROWING MOVES HERE UNCHANGED. `TreeWriteTarget` still has no
// `deleteShape` and no `deleteBinding`, which is the type-level guarantee C2
// verified — "no write can lose a shape" is still checkable by reading one
// interface, and it is now the FIRST thing in the module a reader opens.
// Nothing was exported to make a metric move: `problemsOf`/`problemKey` became
// exported because repair.ts already held a byte-identical copy of both and
// said in a comment that it had to (it does not, any more).

import {
  indexBetween,
  type Binding,
  type CanvasDocument,
  type Page,
  type Shape,
} from "@ensembleworks/canvas-model";
import { shapeText } from "../shape-text.js";
import { MAX_CONTEXT_LENGTH, TREE_KEY, type NodeState } from "./encoding.js";
import {
  checkTreeInvariants,
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
  /**
   * A shape's LIVE text container, read and written — `CanvasDoc.getText` /
   * `setText`, the per-shape LoroText keyed `text:<shapeId>`.
   *
   * THE TITLE CHANNEL, AND THERE IS ONLY ONE. A human's keystrokes land here
   * (canvas-editor's `SetText` intent calls `doc.setText` verbatim), so this
   * is where an agent's titles are written too: a rename an agent makes is
   * the same field, in the same container, that the human would have typed
   * into. Writing `props.richText` instead is what W14's F1 was — the agent
   * wrote one channel, the human read the other, and each was invisible to
   * the other while both reported success. `props.richText` survives as the
   * READ fallback for imported documents (see canvas/shape-text.ts); nothing
   * in this engine writes it any more.
   *
   * `setText` shares `putShape`'s no-op-on-unknown-id contract, so it is
   * called AFTER the shape it titles is put, and the write is verified by
   * reading the title back like every other one.
   */
  text(id: string): string;
  setText(id: string, text: string): void;
  putBinding(binding: Binding): void;
  /** Upsert a page. W4's goal gesture needs it to MARK a page as a tree — the
   * only write in this engine that is not about a shape. Additive like every
   * other method here: a page cannot be removed through this seam either. */
  putPage(page: Page): void;
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
  /** No page with that id in this document, so there is no tree to add to. */
  | "no-such-page"
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
  /** Create a ROOT node — a goal, blocking nothing — on `treeId`'s page,
   * marking that page as a tree if it is not one yet. W4's gesture. */
  addGoal(input: {
    treeId: string;
    title: string;
    state?: NodeState;
    context?: string;
  }): TreeWrite<TreeWriteOutcome>;
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

/**
 * What the five operations share.
 *
 * PASSED, NOT CLOSED OVER. The first version of this file was one
 * `createTreeWriter` with all five operations nested inside it — a 314-token
 * function that the quality audit's hotspot list named outright. Each operation
 * is now a module-level function a reader can hold on its own, and what they
 * have in common is exactly these three things.
 */
export interface WriteOps {
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

/**
 * Locate a node, off the shape's own `meta.tree` — so a caller never has to
 * know (or guess, or cache) which page a node lives on.
 */
export function locateNode(
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
export function applyWrite(
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
// Guards
// ---------------------------------------------------------------------------

export const refusal = <T>(reason: TreeWriteRefusal, detail: string): TreeWrite<T> => ({
  ok: false,
  reason,
  detail,
});

/**
 * THE VALIDATION ASYMMETRY, STATED RATHER THAN LEFT TO BE FOUND (C3 §1.1(b)).
 *
 * `checkTitle` trims, refuses an empty title and caps at `MAX_TITLE_LENGTH`.
 * The HUMAN path validates none of that: a keystroke becomes canvas-editor's
 * `SetText` intent, which calls `doc.setText` verbatim — no trim, no cap, no
 * non-empty requirement, newlines allowed. So the invariant "a node has a
 * non-empty, bounded, single-line title" holds on exactly one of the two
 * channels W15 unified for READING.
 *
 * ACCEPTED FOR v0, DELIBERATELY, and the reason is that the two channels are
 * not symmetrical in what they may cost. This cap is a WRITE POLICY on what an
 * AGENT may add (see MAX_TITLE_LENGTH's own note): an agent can mint a
 * 50,000-character title in one tool call and ride it out to every connected
 * client. A human types, sees the note, and stops. Enforcing the agent's cap on
 * the human's keystrokes would mean a canvas that refuses text mid-word, which
 * is a worse product than a long title.
 *
 * WHAT MAKES IT SAFE RATHER THAN MERELY TOLERATED: nothing downstream trusts
 * the invariant. The digest is character-budgeted so an over-long title
 * degrades the outline rather than breaking it; `firstLine` (W16) trims and
 * takes one line at every label surface, so a newline a human typed cannot make
 * a list render ragged; and `answers.ts`'s `titleOf` trims before deciding a
 * node is `(untitled)`. The asymmetry is therefore a difference in what is
 * REFUSED, not a difference in what is TRUE downstream — and it is not widened
 * silently: any new reader that starts depending on trimmed-and-bounded input
 * has to close it first.
 */

/**
 * EVERY GUARD NAMES ITS SUBJECT. The first version of these two took only the
 * string, so a blank title was refused with "a node needs a title" and no id at
 * all — and the suite's "names an id in every refusal" test is what caught it.
 * A refusal an agent cannot attribute to a node is a refusal it cannot act on:
 * it does not know which of the writes it just planned was rejected.
 */
export function checkTitle(subject: string, title: string): TreeWrite<string> {
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

export function checkContext(subject: string, context: string): TreeWrite<string> {
  if (context.length > MAX_CONTEXT_LENGTH) {
    return refusal(
      "too-long",
      `that context note for ${subject} is ${context.length} characters; the limit is ${MAX_CONTEXT_LENGTH}. It rides every sync delta to every connected client, so it is bounded.`,
    );
  }
  return { ok: true, value: context };
}

/** Structural and graph problems together — what "is this tree broken" means. */
export const problemsOf = (tree: Tree): readonly TreeProblem[] => [
  ...tree.problems,
  ...checkTreeInvariants(tree),
];

/** Identity of a problem, for "was this here before the write". */
export const problemKey = (problem: TreeProblem): string =>
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
export function mintShapeId(
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
export function nextIndex(tree: Tree, above = 1): string {
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
export function withMeta(shape: Shape, fields: { state?: NodeState; context?: string }): Shape {
  return { ...shape, meta: { ...shape.meta, ...fields } } as Shape;
}

/** A node's title, read through the plugin's ONE rule for it — the same rule
 * every reader of this document uses (canvas/shape-text.ts), so a write's
 * read-back can never disagree with what the next `canvas_tree_node` call

 * answers or with what the human sees on screen. */
export const titleOf = (ops: WriteOps, node: TreeNode): string =>
  shapeText(node.shape, ops.target.text(node.id));
