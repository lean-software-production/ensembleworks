// W8 — "DISCUSS THIS NODE": carrying a node OFF the canvas and into the
// conversation. The outbound half of D2; W9 (node-reference.ts) is the return
// leg.
//
// A human selects a node, presses one control, and a reference to that node
// lands in the thread composer. THE HUMAN STILL PRESSES SEND. That is the
// whole of D2's "explicit reference first": no `canvas-sync` Presence change,
// no ambient guessing about what anybody is looking at, and an unambiguous
// subject the agent can resolve against the live document.
//
// FOUR DECISIONS, and each is a way this could quietly lie.
//
// 1. WHAT IT CARRIES: the directive plus the PATH TO ROOT, and nothing else.
//    The plan names the path, and the path is what makes the question
//    answerable — "why is this stuck" is a different question under a
//    different goal. Context notes, blocker lists and states are deliberately
//    left out: this text is pasted into a HUMAN's composer, where a wall of
//    quoted tree is unreadable and unreviewable, and everything omitted is one
//    W6 tool call away for the model (`canvas_tree_node`,
//    `canvas_tree_subtree`, `canvas_tree_blockers`). Too little orientation
//    costs the model a tool call; too much costs the human their draft.
//
// 2. IT APPENDS, IT NEVER REPLACES. `setText` would destroy a draft a human is
//    mid-sentence in, to gain a reference they asked for as an ADDITION. The
//    panel therefore goes through `updateText`, and `draftWithReference` is
//    that updater. AT THE END, not at the caret: the composer api exposes
//    `text`, `setText`, `updateText`, `clear` and `focus` — there is no caret
//    to insert at, and `focus()` puts the caret after the insert, which is
//    where a human continues typing anyway.
//
// 3. IT WRITES INTO A NAMED PLACE OR IT REFUSES OUT LOUD. `useComposer()`
//    resolves to a different draft depending on where the panel is mounted
//    (`PluginComposerScope`); the one scope that is not a destination is a
//    new-thread composer whose project has not resolved yet. There, the arm is
//    greyed with the reason — agent-arms.ts's "disabled, never hidden" call —
//    because a control that appears to work and writes into nowhere is the
//    worst of the three options.
//
// 4. THE SYNTAX IS NOT SPELLED HERE. `nodeDirective` (node-reference.ts) is
//    the single emitter, next to the parse side it has to agree with.
//
// PURE, and free of the DOM. The only bb SDK import is a TYPE (erased at
// build), so this module still costs the browser bundle nothing and stays
// testable without a jsdom — the split canvas/agent-arms.ts's header states
// and canvas/tree/gestures.ts already follows.
import type { PluginComposerScope } from "@get-bb/plugin-sdk";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import { firstLine, type LiveText } from "../shape-text.js";
import { titleOf } from "./answers.js";
import type { TreeGestureTarget } from "./gestures.js";
import { pathToRoot, readTree, type TreeNode } from "./model.js";
import { nodeDirective } from "./node-reference.js";

/** Longest one step of the breadcrumb is spelled out.
 *
 * Shorter than W9's `MAX_CARD_TITLE` (120) on purpose: a card shows ONE title
 * and this shows up to six, in a field a human has to read at a glance. */
export const MAX_STEP_TITLE = 60;

/** Most steps of the path spelled out before the middle is elided. */
export const MAX_PATH_STEPS = 6;

/** Hard ceiling on the whole inserted block.
 *
 * The composer is a human's writing surface, not a context window: this is the
 * number that keeps "reference a node" from ever meaning "paste half a tree
 * into the message I was writing". */
export const MAX_REFERENCE_CHARS = 400;

/** Between two steps of the breadcrumb. */
export const PATH_SEPARATOR = " › ";

/** Where a cut middle used to be. */
export const PATH_ELISION = "…";

const PATH_LEAD = "Path: ";

/** Said when the path cannot be read. NOT invented, and not silently omitted —
 * a missing path with no explanation reads as a root node. */
const NO_PATH = `${PATH_LEAD}not available — there is a cycle above this node on the canvas`;

// ---------------------------------------------------------------------------
// Where the reference goes

export type ComposerDestination =
  | { readonly ok: true; readonly where: string }
  | { readonly ok: false; readonly why: string };

/**
 * Which draft `useComposer()` would write into, said in words a human can act
 * on — or the reason there is not one.
 *
 * The host's own rule, restated: inside a thread the write lands in that
 * thread's draft; while a queued message is being edited it lands in that
 * message; in a side chat it lands in the side-chat draft; anywhere else it
 * SEEDS the new-thread composer. All four are real destinations a human can
 * see and send, so all four are offered — including the new-thread one, which
 * is exactly how "start a thread about this node" begins (W12 links it
 * afterwards).
 *
 * `null` is the case where the api is not there at all, which is what a canvas
 * mounted outside the app shell would see.
 */
export function composerDestination(scope: PluginComposerScope | null): ComposerDestination {
  if (scope === null) {
    return { ok: false, why: "No conversation is open next to this canvas to reference it in." };
  }
  switch (scope.kind) {
    case "thread":
      return { ok: true, where: "this thread" };
    case "queued-message":
      return { ok: true, where: "the queued message" };
    case "side-chat":
      return { ok: true, where: "the side chat" };
    case "new-thread":
      // `projectId` is null ONLY while the root composer has not resolved a
      // project (the host says so). Writing then would put the reference into
      // a draft that is about to be re-scoped, so it waits rather than lands
      // somewhere nobody asked for.
      return scope.projectId === null
        ? { ok: false, why: "The new-thread composer has not picked a project yet." }
        : { ok: true, where: "a new thread" };
  }
}

// ---------------------------------------------------------------------------
// The arm

/** One control, with the reason it cannot be used when it cannot. Shaped like
 * `TreeGestureArm` because it renders in the same row (W4's layer). */
export interface DiscussArm {
  readonly label: string;
  readonly enabled: boolean;
  /** Empty when enabled. */
  readonly reason: string;
}

/**
 * The "discuss this node" arm for this selection and this composer.
 *
 * Null with no target at all — there is no shape to anchor it to, which is
 * W4's rule for the whole anchored group rather than a new one.
 *
 * DISABLED, NEVER HIDDEN otherwise: a control that vanishes on a note that is
 * not a tree node reads as a bug, and one that vanishes because a composer is
 * unresolved reads as a broken build. Both say why instead.
 */
export function discussArmFor(
  target: TreeGestureTarget | null,
  destination: ComposerDestination,
): DiscussArm | null {
  if (target === null) return null;
  const label = "Discuss this node";
  if (target.treeId === null) {
    return {
      label,
      enabled: false,
      reason: "This shape is not a node of a tree — start one with “Add a goal”.",
    };
  }
  if (!destination.ok) return { label, enabled: false, reason: destination.why };
  return { label, enabled: true, reason: "" };
}

// ---------------------------------------------------------------------------
// The reference itself

export type NodeReference =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly why: string };

/**
 * The block this node inserts: the directive on its own line, then the path.
 *
 * READ FROM THE DOCUMENT THE PANEL ALREADY HOLDS, through W1's own
 * `readTree`/`pathToRoot` — not through an rpc, and not through a second
 * reading of the encoding. W9's card needs the rpc because it renders inside a
 * chat message where there is no document; the panel HAS the document, and a
 * round trip here would make a synchronous gesture asynchronous for facts that
 * are already on screen.
 */
export function nodeReferenceFor(
  doc: CanvasDocument,
  treeId: string,
  nodeId: string,
  /** The live text channel — `CanvasDoc.getText`. REQUIRED, not defaulted: a
   * caller that quietly omitted it would render a breadcrumb of the titles an
   * import left behind rather than the ones the human typed, and paste that
   * into the agent's own prompt (W14's F1). A caller with no doc handle passes
   * `NO_LIVE_TEXT` and says so. */
  text: LiveText,
): NodeReference {
  const directive = nodeDirective(nodeId);
  if (directive === null) {
    return { ok: false, why: `${nodeId} cannot be written as a node reference.` };
  }
  const tree = readTree(doc, treeId);
  if (!tree.nodes.has(nodeId)) {
    return { ok: false, why: `${nodeId} is not a node of this tree any more.` };
  }
  const read = pathToRoot(tree, nodeId);
  // `absent` is unreachable — the node was just found above — but it is
  // answered rather than assumed, so an encoding change cannot turn it into a
  // crash inside a click handler.
  if (read.status !== "ok") return { ok: true, text: `${directive}\n${NO_PATH}` };
  // `pathToRoot` walks UP; a breadcrumb reads DOWN.
  const steps = [...read.value].reverse().map((node) => stepTitle(node, text));
  return { ok: true, text: `${directive}\n${breadcrumb(steps, MAX_REFERENCE_CHARS - directive.length - 1)}` };
}

/** One node's label: its first line, bounded, never blank. */
function stepTitle(node: TreeNode, text: LiveText): string {
  const line = firstLine(node.shape, text(node.id));
  const title = titleOf({ title: line });
  return title.length <= MAX_STEP_TITLE
    ? title
    : `${title.slice(0, MAX_STEP_TITLE - 1)}${PATH_ELISION}`;
}

/**
 * The path as one line, cut from the MIDDLE until it fits.
 *
 * Which end to keep is the judgement: the ROOT is the goal the whole tree is
 * about, and the nearest ancestors are the local context that makes a question
 * specific. The steps in between are the ones a model can recover with one
 * `canvas_tree_path` call, so they are what goes — and the elision marker says
 * they went, rather than presenting a shortened path as the real one.
 */
function breadcrumb(steps: readonly string[], budget: number): string {
  const shown = [...steps];
  const elided: string[] = [];
  const line = (parts: readonly string[]): string => `${PATH_LEAD}${parts.join(PATH_SEPARATOR)}`;
  // Cut the second step (just under the root) each time, so the root and the
  // node itself are the last two standing.
  while (
    shown.length > 2 &&
    (shown.length + elided.length > MAX_PATH_STEPS ||
      line([...shown.slice(0, 1), ...elided, ...shown.slice(1)]).length > budget)
  ) {
    shown.splice(1, 1);
    if (elided.length === 0) elided.push(PATH_ELISION);
  }
  const parts = [...shown.slice(0, 1), ...elided, ...shown.slice(1)];
  const text = line(parts);
  // Two enormous titles can still overrun the budget with nothing left to cut.
  // The bound is a promise about the composer, so it is enforced rather than
  // hoped for.
  return text.length <= budget ? text : `${text.slice(0, budget - 1)}${PATH_ELISION}`;
}

// ---------------------------------------------------------------------------
// Putting it in the draft

/**
 * The draft with this reference added, or null when nothing should change.
 *
 * NULL MEANS ALREADY THERE. Pressing the control twice — or referencing a node
 * a human already referenced — must not stack duplicates; the caller says so
 * instead of writing. Identity is the DIRECTIVE LINE, not the whole block: the
 * path may differ (the tree moved) and it is still the same reference.
 */
export function draftWithReference(current: string, reference: string): string | null {
  const directive = reference.split("\n")[0] ?? "";
  if (directive !== "" && current.includes(directive)) return null;
  const kept = current.replace(/\s+$/u, "");
  return kept === "" ? reference : `${kept}\n\n${reference}`;
}

/**
 * What actually happened to the draft.
 *
 * `unrun` is the case where the composer never called the updater at all. It
 * is kept SEPARATE from `duplicate` because they are not the same fact:
 * defaulting an unrun update to "already referenced" would tell a human their
 * reference is sitting in a message that does not contain it.
 */
export type DiscussOutcome = "inserted" | "duplicate" | "unrun";

export interface DiscussReport {
  readonly tone: "success" | "info" | "error";
  readonly text: string;
}

/**
 * The one sentence a human gets back.
 *
 * SOMETHING IS ALWAYS SAID. The composer this writes into can be scrolled out
 * of view, collapsed, or on the other side of the window from the canvas, so a
 * silent success is indistinguishable from a dead control — and the sentence
 * names WHERE the text went, which is the fact a human cannot otherwise check
 * from the canvas.
 */
export function discussReport(outcome: DiscussOutcome, where: string): DiscussReport {
  switch (outcome) {
    case "inserted":
      return { tone: "success", text: `Referenced this node in ${where} — press send when ready.` };
    case "duplicate":
      return { tone: "info", text: `This node is referenced in ${where} already.` };
    case "unrun":
      return { tone: "error", text: `${where} did not take the reference — try again.` };
  }
}
