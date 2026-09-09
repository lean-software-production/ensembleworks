// W11 — INVARIANTS AND REPAIR: reconciling the damage that two individually
// legal, concurrent edits leave behind once a CRDT has merged them.
//
// WHERE THIS BEGINS. W10 refuses a write that is illegal ON ITS OWN, judged
// against the state its peer could see. That is everything a preflight can do,
// and it is not enough: two peers can each make a legal reparent and converge
// on a cycle, with no moment at which either write was wrong. This module is
// what runs afterwards.
//
//   Peer A: "ui blocks schema"      — legal, schema is not above ui
//   Peer B: "schema blocks ui"      — legal, ui is not above schema
//   Merged: schema blocks ui blocks schema.
//
// THE ONE RULE. REPAIR NEVER SILENTLY DROPS A HUMAN EDIT. Reconciling that
// cycle means one of the two edges has to stop counting, and DELETING it would
// take a relationship a human drew off their screen with no trace — the plan
// says outright that a silent drop is worse than a visible refusal. So repair
// QUARANTINES: `encoding.quarantineTreeShape` moves the arrow's `meta.tree`
// into `meta.treeQuarantine`, and the arrow, its two `Binding` rows and its
// geometry all stay exactly as they were. `restoreQuarantinedEdge` puts the
// one key back.
//
// THE SEAM SAYS THE SAME THING. `TreeRepairTarget` is a `TreeWriteTarget`
// minus `deleteShape`, `deleteBinding`, `putBinding`, `updateProps` and
// `random`. Repair CANNOT delete anything, cannot mint anything, and has no
// entropy — those are not disciplines it observes, they are capabilities it
// was not given.
//
// DETERMINISM IS A HARD REQUIREMENT, not a nicety. Every peer holding the same
// merged document must reach the same repaired state, so `treeRepairPlan` is a
// pure function of document CONTENT: no clock, no PRNG, no arrival order, no
// "which peer noticed first". Every choice below breaks a tie by the smallest
// id, reading a graph W1 already sorted. canvas-model's own `repairPlan` makes
// the identical argument for the same reason — this is that posture extended
// to the tree encoding, not a second repair system (canvas-model repairs the
// DOCUMENT: dangling bindings, orphans, invalid props. It knows nothing about
// `meta.tree`, and it may delete, because a dangling binding row is not
// anybody's drawing).
//
// COST. A pass is `readTree` + `checkTreeInvariants` per tree, per call, and
// the planner re-reads after each op it chooses (a projection, in memory — see
// `withoutEdge`). That is O(edges × doc) worst case on a document that is
// badly broken, and O(doc) on the overwhelmingly common healthy one. The room
// only calls it when an inbound frame actually changed the document, which is
// what keeps it off the presence path — see `CanvasRoomHost.frame`.
import {
  makeDocument,
  type Binding,
  type CanvasDocument,
  type Shape,
} from "@ensembleworks/canvas-model";
import {
  TREE_KEY,
  quarantineTreeShape,
  readTreeQuarantine,
  restoreTreeShape,
  type TreeQuarantine,
} from "./encoding.js";
import {
  checkTreeInvariants,
  listTrees,
  readTree,
  type Tree,
  type TreeProblem,
  type TreeProblemKind,
} from "./model.js";
import type { TreeWrite, TreeWriteTarget } from "./writes.js";

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/**
 * What repair needs from the document — and, more to the point, what it does
 * NOT. Derived from `TreeWriteTarget` with `Pick` rather than declared afresh,
 * so the two can never describe `putShape` differently, and so the absence of
 * every delete is a fact a reader can check in one line.
 */
export type TreeRepairTarget = Pick<
  TreeWriteTarget,
  "document" | "getShape" | "putShape" | "commit"
>;

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * The problem kinds a repair pass will act on. Every one of them is damage a
 * pair of legal concurrent edits can produce, and every one of them is fixed
 * by taking an EDGE out of the tree — which is the only thing repair can undo
 * without destroying writing.
 *
 * Everything else W1 can report is deliberately absent:
 *
 * - `invalid-node` and `foreign-kind` are a human's NOTE. There is no losing
 *   edge to quarantine and no way to guess what they meant; repair reports and
 *   leaves it.
 * - `unmarked-page` is a fact about the page, not about a merge.
 * - `unreachable` is a CONSEQUENCE of a cycle. Breaking the cycle resolves it;
 *   if it survives the pass it is reported, never "fixed" by inventing an edge
 *   to a root.
 */
export const REPAIRABLE_KINDS = [
  "cycle",
  "dangling-edge",
  "duplicate-edge",
  "invalid-edge",
  "multiple-parents",
] as const;
export type TreeRepairReason = (typeof REPAIRABLE_KINDS)[number];

const isRepairable = (kind: TreeProblemKind): kind is TreeRepairReason =>
  (REPAIRABLE_KINDS as readonly string[]).includes(kind);

/**
 * One thing a repair pass will do. There is exactly ONE operation, and it is
 * reversible — that is the whole design, so the type says so rather than
 * leaving `op` as a union of one for symmetry with canvas-model's `RepairOp`.
 */
export interface TreeRepairOp {
  readonly op: "quarantine-edge";
  readonly treeId: string;
  /** The arrow shape leaving the tree. It is not deleted. */
  readonly edgeId: string;
  readonly reason: TreeRepairReason;
  /** The problem's own subjects, so a report can say what this was about
   * without re-deriving it from the document. */
  readonly subjects: readonly string[];
  readonly detail: string;
}

/** A problem this pass will not act on, and why not. */
export interface TreeUnrepaired {
  readonly problem: TreeProblem;
  readonly why: string;
}

export interface TreeRepairPlan {
  readonly treeId: string;
  /** In the order they are applied. Deterministic. */
  readonly ops: readonly TreeRepairOp[];
  readonly unrepaired: readonly TreeUnrepaired[];
}

/**
 * What a pass DID, read back out of the document afterwards.
 *
 * `applied` is what the document accepted, not what was planned — `putShape`
 * rejects an invalid shape as a silent no-op, so an unverified repair could
 * report success having changed nothing. Same discipline as `writes.applyWrite`.
 */
export interface TreeRepairReport {
  readonly treeId: string;
  readonly applied: readonly TreeRepairOp[];
  /** Planned, then refused by the document or gone before it could be applied. */
  readonly rejected: readonly { readonly op: TreeRepairOp; readonly why: string }[];
  readonly unrepaired: readonly TreeUnrepaired[];
  /** Everything still wrong with the tree AFTER the pass. Empty on a tree whose
   * only damage was repairable. */
  readonly remaining: readonly TreeProblem[];
  /** The pass in sentences an operator can read. Empty when nothing happened. */
  readonly lines: readonly string[];
}

/**
 * Plan the repair of one tree. PURE — no document is written, nothing is
 * committed, and the answer is a function of `doc` alone.
 *
 * Chooses ONE op, projects the document as if it had been applied, and asks
 * again. Iterating rather than planning every problem in one look is what
 * keeps the plan MINIMAL: two cycles that share an edge are broken by
 * quarantining that one edge, where a per-problem plan would quarantine two —
 * and every extra op is another human relationship taken out of the tree.
 */
export function treeRepairPlan(doc: CanvasDocument, treeId: string): TreeRepairPlan {
  const ops: TreeRepairOp[] = [];
  let current = doc;
  // Bound: every op removes one tree-marked arrow from the graph, so the tree
  // cannot survive more passes than it has edges. The +1 is the pass that
  // finds nothing left to do and stops.
  const limit = readTree(doc, treeId).edges.length + countTreeArrows(doc, treeId) + 1;
  for (let pass = 0; pass < limit; pass += 1) {
    const tree = readTree(current, treeId);
    const next = chooseOp(tree, problemsOf(tree));
    if (next === null) {
      return { treeId, ops, unrepaired: unrepairedOf(problemsOf(readTree(current, treeId))) };
    }
    ops.push(next);
    current = withoutEdge(current, next.edgeId);
  }
  // Unreachable while every op removes an edge from the graph. Reported rather
  // than thrown, and rather than looping: a repairer that cannot converge must
  // say so, not spin on a live room's inbound path.
  return {
    treeId,
    ops,
    unrepaired: problemsOf(readTree(current, treeId)).map((problem) => ({
      problem,
      why: `repair did not converge after ${limit} passes and stopped`,
    })),
  };
}

/** Structural and graph problems together — what "is this tree broken" means.
 * The same pair `writes.problemsOf` asks; both read W1, neither re-derives. */
const problemsOf = (tree: Tree): readonly TreeProblem[] => [
  ...tree.problems,
  ...checkTreeInvariants(tree),
];

/** Tree-marked arrows the graph never took in (dangling, half-bound), so the
 * pass bound covers the edges that are problems rather than edges. */
function countTreeArrows(doc: CanvasDocument, treeId: string): number {
  return doc.shapes.filter((shape) => shape.meta[TREE_KEY] === treeId && shape.kind === "arrow")
    .length;
}

/**
 * The first problem this pass can act on, in W1's own sorted order.
 *
 * "First in a sorted list" IS the determinism argument: `readTree` and
 * `checkTreeInvariants` both return problems sorted by (kind, subjects), so
 * two peers holding the same document consider the same problem first. Nothing
 * here consults arrival order, a clock, or which peer is running.
 */
function chooseOp(tree: Tree, problems: readonly TreeProblem[]): TreeRepairOp | null {
  for (const problem of problems) {
    if (!isRepairable(problem.kind)) continue;
    const edgeId = losingEdge(tree, problem);
    if (edgeId === null) continue;
    return {
      op: "quarantine-edge",
      treeId: tree.treeId,
      edgeId,
      reason: problem.kind,
      subjects: problem.subjects,
      detail: problem.detail,
    };
  }
  return null;
}

/**
 * Which edge loses — the only judgement call in this module, so it is one
 * function and every branch states its tie-break.
 *
 * THE TIE-BREAK IS ALWAYS "SMALLEST EDGE ID WINS, THE NEXT ONE LEAVES". Not
 * newest, not "the one from the other peer", not the one with fewer children:
 * a shape id is the only totally-ordered thing in the document that every peer
 * agrees on. It is arbitrary on purpose — there is no fact in the document
 * about which of two simultaneous edits a human meant, so the choice must not
 * PRETEND to be about merit. What makes it acceptable is that the loser is
 * quarantined rather than deleted.
 */
function losingEdge(tree: Tree, problem: TreeProblem): string | null {
  switch (problem.kind as TreeRepairReason) {
    case "cycle": {
      // `subjects` is the cycle in order, rotated to its smallest id (W1). Its
      // edges are the consecutive pairs, wrapping. Quarantine the smallest
      // edge id among them, so the SAME edge is chosen wherever the walk
      // happened to enter the cycle.
      const ids = problem.subjects;
      const onCycle = tree.edges
        .filter((edge) =>
          ids.some(
            (id, at) => edge.blockerId === id && edge.blockedId === ids[(at + 1) % ids.length],
          ),
        )
        .map((edge) => edge.edgeId);
      return smallest(onCycle);
    }
    case "duplicate-edge":
      // `subjects` is already the edge ids, ascending: keep the first, the
      // next one leaves. The RELATIONSHIP survives untouched — a duplicate is
      // the one case where quarantining loses nothing at all.
      return problem.subjects[1] ?? null;
    case "multiple-parents": {
      // `subjects` is [nodeId, ...the nodes it blocks]. One of those edges
      // stays; the next smallest leaves, and a later pass takes any others.
      const nodeId = problem.subjects[0];
      const outgoing = tree.edges
        .filter((edge) => edge.blockerId === nodeId)
        .map((edge) => edge.edgeId)
        .sort(compare);
      return outgoing[1] ?? null;
    }
    case "dangling-edge": {
      // `subjects` is [edgeId, ...the ids it names that are not nodes here].
      //
      // DEFER WHEN THE ENDPOINT IS A BROKEN NODE RATHER THAN A GONE ONE. An
      // edge to a node someone deleted or moved to another tree is real
      // damage. An edge to a node that is still sitting on the page and merely
      // failed to READ (`invalid-node`, `foreign-kind`) is not: fixing that
      // node makes this edge good again, and quarantining it in the meantime
      // takes away a relationship because of a defect somewhere else. Found by
      // the malformed-node test, which expected repair to leave the tree alone
      // and watched it quarantine two innocent edges.
      const [edgeId, ...missing] = problem.subjects;
      const stillOnThePage = missing.some((id) =>
        tree.problems.some(
          (other) =>
            (other.kind === "invalid-node" || other.kind === "foreign-kind") &&
            other.subjects[0] === id,
        ),
      );
      return stillOnThePage ? null : (edgeId ?? null);
    }
    case "invalid-edge":
      // Names the offending ARROW first (W1's `TreeProblem.subjects`
      // contract). There is no rival to choose between: the edge itself is
      // what cannot be read as a relationship.
      return problem.subjects[0] ?? null;
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const smallest = (ids: readonly string[]): string | null =>
  ids.length === 0 ? null : [...ids].sort(compare)[0] as string;

/** Everything left that this module will not act on, each with its reason. */
function unrepairedOf(problems: readonly TreeProblem[]): TreeUnrepaired[] {
  return problems.map((problem) => ({ problem, why: whyNot(problem.kind) }));
}

function whyNot(kind: TreeProblemKind): string {
  switch (kind) {
    case "invalid-node":
      return "a node is a human's writing; there is no losing edge to take out and no way to guess what was meant";
    case "foreign-kind":
      return "a tree-marked shape of an unexpected kind — repair does not reshape a human's drawing";
    case "unmarked-page":
      return "the page's own tree mark is missing or malformed; mark the page, do not rewrite its shapes";
    case "unreachable":
      return "no cycle is left to break, so these nodes are cut off by an edge nobody drew — repair will not invent one";
    case "dangling-edge":
      // The only way a dangling edge survives a pass: `losingEdge` deferred it.
      return "the node this edge names is still on the page and merely does not read as a node; fix the node and the edge is good again";
    default:
      // A repairable kind that survived the pass: no edge could be derived
      // from it. Reported so the gap is visible rather than looking healed.
      return `repair recognises ${kind} but could not identify an edge to take out of the tree`;
  }
}

/**
 * The document as it would be with `edgeId` quarantined — the projection the
 * planner re-reads.
 *
 * It applies `quarantineTreeShape`, the SAME transform `applyTreeRepair`
 * writes, so the plan cannot be computed against a state the application would
 * not produce.
 */
function withoutEdge(doc: CanvasDocument, edgeId: string): CanvasDocument {
  const shape = doc.byId.get(edgeId);
  if (shape === undefined) return doc;
  const quarantined = quarantineTreeShape(shape, { reason: "planning", detail: "" });
  if (quarantined.status !== "ok") return doc;
  return makeDocument({
    pages: doc.pages,
    shapes: doc.shapes.map((candidate) =>
      candidate.id === edgeId ? (quarantined.value as Shape) : candidate,
    ),
    bindings: doc.bindings as readonly Binding[],
  });
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Plan and apply the repair of one tree, then READ THE WHOLE TREE BACK.
 *
 * The read-back does the two jobs `writes.applyWrite`'s does: it proves each
 * quarantine actually landed (a rejected `putShape` is a silent no-op), and it
 * says what is still wrong afterwards rather than asserting the tree is now
 * fine.
 *
 * A healthy tree costs one document read and NOTHING ELSE — no write, no
 * commit, no broadcast. That matters because this sits on a room's inbound
 * path.
 */
export function applyTreeRepair(target: TreeRepairTarget, treeId: string): TreeRepairReport {
  const plan = treeRepairPlan(target.document(), treeId);
  if (plan.ops.length === 0) {
    return {
      treeId,
      applied: [],
      rejected: [],
      unrepaired: plan.unrepaired,
      remaining: plan.unrepaired.map((entry) => entry.problem),
      lines: reportLines(treeId, [], [], plan.unrepaired),
    };
  }

  const attempted: TreeRepairOp[] = [];
  const rejected: { op: TreeRepairOp; why: string }[] = [];
  for (const op of plan.ops) {
    const shape = target.getShape(op.edgeId);
    if (shape === undefined) {
      // Someone deleted the arrow between the plan and the write. Nothing to
      // quarantine, and nothing lost.
      rejected.push({ op, why: `${op.edgeId} was gone before it could be quarantined` });
      continue;
    }
    const quarantined = quarantineTreeShape(shape, { reason: op.reason, detail: op.detail });
    if (quarantined.status !== "ok") {
      rejected.push({ op, why: `${op.edgeId} could not be quarantined: it carries no tree mark` });
      continue;
    }
    target.putShape(quarantined.value);
    attempted.push(op);
  }
  if (attempted.length > 0) target.commit();

  // What the DOCUMENT says happened, not what was attempted.
  const after = target.document();
  const applied: TreeRepairOp[] = [];
  for (const op of attempted) {
    const shape = after.byId.get(op.edgeId);
    if (shape !== undefined && readTreeQuarantine(shape).status === "ok") applied.push(op);
    else rejected.push({ op, why: `the document did not accept the quarantine of ${op.edgeId}` });
  }
  const tree = readTree(after, treeId);
  const remaining = problemsOf(tree);
  const unrepaired = unrepairedOf(remaining);
  return {
    treeId,
    applied,
    rejected,
    unrepaired,
    remaining,
    lines: reportLines(treeId, applied, rejected, unrepaired),
  };
}

/**
 * Repair every tree in the document, ascending by treeId.
 *
 * One report per tree, including the trees that were already fine — a caller
 * logging this wants "tree X: nothing to do" to be a thing it can see, not an
 * absence it has to infer.
 */
export function repairAllTrees(target: TreeRepairTarget): readonly TreeRepairReport[] {
  return listTrees(target.document()).map((treeId) => applyTreeRepair(target, treeId));
}

/**
 * The pass as an operator reads it. EVERY QUARANTINED EDGE IS NAMED BY ID, and
 * the report says how to get it back — a repair whose losing edit is only
 * recoverable in principle is not much better than a deletion.
 */
function reportLines(
  treeId: string,
  applied: readonly TreeRepairOp[],
  rejected: readonly { op: TreeRepairOp; why: string }[],
  unrepaired: readonly TreeUnrepaired[],
): readonly string[] {
  const lines: string[] = [];
  for (const op of applied) {
    lines.push(
      `${treeId}: took edge ${op.edgeId} out of the tree (${op.reason}: ${op.detail}). The arrow and both its bindings are untouched on the canvas — restore the relationship with restoreQuarantinedEdge(${op.edgeId}).`,
    );
  }
  for (const entry of rejected) {
    lines.push(`${treeId}: could not take edge ${entry.op.edgeId} out — ${entry.why}`);
  }
  for (const entry of unrepaired) {
    lines.push(
      `${treeId}: left alone — ${entry.problem.kind} (${entry.problem.subjects.join(", ")}): ${entry.why}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Getting a relationship back
// ---------------------------------------------------------------------------

/** A quarantined edge, as a caller listing them sees it. */
export interface QuarantinedEdge {
  readonly edgeId: string;
  readonly shape: Shape;
  readonly quarantine: TreeQuarantine;
}

/**
 * Every edge repair has taken out of `treeId` (or out of ANY tree, when no
 * tree is named), ascending by id. This is the recovery surface: what was
 * taken out, of which tree, and why.
 */
export function listQuarantinedEdges(
  doc: CanvasDocument,
  treeId?: string,
): readonly QuarantinedEdge[] {
  const found: QuarantinedEdge[] = [];
  for (const shape of doc.shapes) {
    const record = readTreeQuarantine(shape);
    if (record.status !== "ok") continue;
    if (treeId !== undefined && record.value.tree !== treeId) continue;
    found.push({ edgeId: shape.id, shape, quarantine: record.value });
  }
  return found.sort((a, b) => compare(a.edgeId, b.edgeId));
}

/**
 * Put a quarantined edge back in its tree — the inverse of one repair op.
 *
 * REFUSES A RESTORE THAT WOULD IMMEDIATELY BE UNDONE, naming the problem it
 * would recreate. Repair runs on every merge, so restoring an edge into the
 * damage that got it quarantined would simply quarantine it again on the next
 * inbound frame; a caller who was told "done" and watched it revert has been
 * lied to. Fix the reason first — usually by removing the rival edge — then
 * restore. Same posture as W10: a refusal that names the ids is the useful
 * answer.
 */
export function restoreQuarantinedEdge(
  target: TreeRepairTarget,
  edgeId: string,
): TreeWrite<{ readonly edgeId: string; readonly treeId: string }> {
  const doc = target.document();
  const shape = doc.byId.get(edgeId);
  if (shape === undefined) {
    return { ok: false, reason: "no-such-node", detail: `no shape ${edgeId} in this document` };
  }
  const restored = restoreTreeShape(shape);
  if (restored.status !== "ok") {
    return {
      ok: false,
      reason: "not-a-tree-node",
      detail:
        restored.status === "absent"
          ? `${edgeId} is not a quarantined tree edge`
          : `${edgeId} carries an unreadable quarantine record: ${restored.error}`,
    };
  }
  const record = readTreeQuarantine(shape);
  if (record.status !== "ok") {
    // Unreachable: restoreTreeShape returned ok, which means the record read.
    // Kept so a later encoding change cannot make this branch silently wrong.
    return { ok: false, reason: "rejected", detail: `${edgeId} lost its quarantine record` };
  }
  const treeId = record.value.tree;

  // Would it stick? Judged on the SAME projection the planner uses, so
  // "restore then repair" and "refuse" can never disagree.
  const projected = makeDocument({
    pages: doc.pages,
    shapes: doc.shapes.map((candidate) => (candidate.id === edgeId ? restored.value : candidate)),
    bindings: doc.bindings as readonly Binding[],
  });
  const had = new Set(problemsOf(readTree(doc, treeId)).map(problemKey));
  const created = problemsOf(readTree(projected, treeId)).filter(
    (problem) => !had.has(problemKey(problem)),
  );
  if (created.length > 0) {
    return {
      ok: false,
      reason: "broken-tree",
      detail: `restoring ${edgeId} into ${treeId} would recreate ${created
        .map((problem) => `${problem.kind} (${problem.subjects.join(", ")})`)
        .join("; ")} — the next merge would take it straight back out. Remove the rival edge first.`,
    };
  }

  target.putShape(restored.value);
  target.commit();
  const back = target.document().byId.get(edgeId);
  if (back === undefined || back.meta[TREE_KEY] !== treeId) {
    return { ok: false, reason: "rejected", detail: `the document did not accept ${edgeId} back into ${treeId}` };
  }
  return { ok: true, value: { edgeId, treeId } };
}

/** Identity of a problem, for "was this here before". The same key
 * `writes.problemKey` uses; both exist because neither module may import the
 * other's private helper, and the string is one line. */
const problemKey = (problem: TreeProblem): string =>
  `${problem.kind}|${problem.subjects.join(",")}`;
