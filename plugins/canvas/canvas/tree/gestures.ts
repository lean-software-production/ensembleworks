// W4 — THE NODE GESTURES, as decisions rather than as JSX.
//
// Two gestures: "add a goal" (a root node, and the page mark that makes the
// page a tree) and "add a blocker under this node". Everything here is what
// the component would otherwise have written inline — which shape a gesture
// acts on, whether the arm is offered, whether a typed title is worth sending,
// and which composer is open. This project has no jsdom and may not gain one,
// so a rule inside a component is a rule no test can drive; canvas/
// agent-arms.ts and canvas/agent-menu.ts make the same split for the same
// reason and this module is deliberately shaped like both.
//
// NOTHING HERE WRITES. The gesture's write goes to the SERVER — the panel
// calls `canvas_tree_add_goal` / `canvas_tree_add_blocker`, which run W10's
// write engine against the room's own document. That is the single most
// consequential choice in this node and it is argued in full in
// canvas/rpc-contract.ts, next to the two methods.
//
// PURE, and free of the bb SDK and the DOM, so it is importable from the
// browser bundle and testable without one.
import type { Page, Shape } from "@ensembleworks/canvas-model";
import { readTreeNode, readTreePage } from "./encoding.js";

/** The two gestures, in the order a reader meets them. */
export const TREE_GESTURE_IDS = ["add-goal", "add-blocker"] as const;
export type TreeGestureId = (typeof TREE_GESTURE_IDS)[number];

/**
 * Ceiling on a title typed into a gesture.
 *
 * The same number `writes.ts`'s `MAX_TITLE_LENGTH` enforces, RESTATED rather
 * than imported: `writes.ts` is the server's write engine (canvas-model,
 * A1 order keys, the whole refusal vocabulary) and importing it here to read
 * one integer would pull all of it into the browser bundle. The wire schema in
 * rpc-contract.ts caps the same value, and the engine refuses over it whatever
 * this says — this is the half that keeps a doomed round trip off the screen,
 * not the guarantee.
 */
export const MAX_GESTURE_TITLE = 500;

/** The shape a tree gesture is offered on. `treeId` is null when the shape is
 * not a usable tree node — the affordance still appears and says why, which is
 * agent-arms.ts's "disabled, never hidden" call. */
export interface TreeGestureTarget {
  readonly shapeId: string;
  readonly treeId: string | null;
}

/**
 * The one shape the gesture menu hangs off, or null when there is not exactly
 * one.
 *
 * EXACTLY ONE, for agent-arms.ts's reason: the menu is anchored to a shape's
 * screen box and a two-shape selection has no such box. An id the document
 * does not resolve is no target either — a create tool mid-drag has a
 * selection, and a shape nobody can read is not something to hang a menu on.
 *
 * WHETHER IT IS A NODE IS `readTreeNode`'S ANSWER, not a `kind === "note"`
 * check written here. An EDGE is tree-marked too, and "add a blocker under
 * this arrow" is not a write the engine has; asking the encoding keeps one
 * reading of W0's contract instead of a second one that would rot apart from
 * it.
 */
export function treeGestureTargetFor(input: {
  readonly selection: ReadonlySet<string>;
  readonly shapeOf: (shapeId: string) => Shape | undefined;
}): TreeGestureTarget | null {
  if (input.selection.size !== 1) return null;
  const shapeId = [...input.selection][0] as string;
  const shape = input.shapeOf(shapeId);
  if (shape === undefined) return null;
  const read = readTreeNode(shape);
  return { shapeId, treeId: read.status === "ok" ? read.value.tree : null };
}

/** One arm, with the reason it cannot be used when it cannot. */
export interface TreeGestureArm {
  readonly label: string;
  readonly enabled: boolean;
  /** Empty when enabled. Shown as the disabled item's own explanation, so a
   * greyed control never leaves a human guessing. */
  readonly reason: string;
}

/**
 * The "add a blocker" arm for this target.
 *
 * DISABLED, NEVER HIDDEN, on a shape that is not a tree node — the call
 * agent-arms.ts makes and states: a greyed item says why it cannot be used,
 * whereas an affordance that silently appears on one note and not on the next
 * reads as a bug.
 *
 * Adopting a loose note INTO a tree is deliberately not offered. It is a write
 * the engine does not have, and inventing one behind a gesture would be a
 * write path nobody reviewed.
 */
export function blockerArmFor(target: TreeGestureTarget): TreeGestureArm {
  if (target.treeId === null) {
    return {
      label: "Add a blocker…",
      enabled: false,
      reason: "This shape is not a node of a tree — start one with “Add a goal”.",
    };
  }
  return { label: "Add a blocker…", enabled: true, reason: "" };
}

/**
 * What the tree-mark of the page you are looking at is, as much of it as this
 * decision needs.
 *
 * A THREE-STATE FACT, not a boolean, because `addGoal` treats the three
 * differently and a boolean would collapse the two that matter: an ABSENT mark
 * is written by the gesture (that is how a tree starts), an INVALID one is
 * REFUSED (`broken-tree` — restamping would destroy the evidence of how it
 * broke, which is W11's to look at). Structurally `encoding.ts`'s
 * `readTreePage` result, narrowed to the two fields, so this module stays a
 * pure rule over values a caller already has.
 */
export interface TreePageMarkState {
  readonly status: "ok" | "absent" | "invalid";
  /** Why the mark could not be read. Present only on `invalid`. */
  readonly error?: string;
}

/**
 * A page's mark, as `goalArmFor` needs it.
 *
 * ONE TRANSLATION, HERE. The component could call `readTreePage` itself, but
 * then the mapping from a read verdict to a button state would live in a .tsx
 * this project cannot test (no jsdom), which is the exact failure the whole
 * `gestures.ts` module exists to prevent. The `error` is carried through rather
 * than replaced with a house phrase: it names WHICH key is malformed, and a
 * human who has to repair a page mark needs that, not "something is wrong".
 */
export function markStateOf(page: Page): TreePageMarkState {
  const read = readTreePage(page);
  return read.status === "invalid"
    ? { status: "invalid", error: read.error }
    : { status: read.status };
}

/**
 * The "add a goal" arm for the page on screen.
 *
 * THE BUTTON USED TO BE UNCONDITIONAL AND ITS LABEL USED TO BE FALSE (C3's B2,
 * from W14's `03-otherpage-recheck.png`). `TreeGestureLayer` rendered "Add a
 * goal" in the corner of every page of every room the plugin serves, and on a
 * page that was not a tree, pressing it MARKED the page as one — a conversion
 * the label never mentioned. That is the defect: not that the control exists,
 * but that on most pages it did something other than what it said.
 *
 * IT IS NOT HIDDEN ON A NON-TREE PAGE, and that is a deliberate refusal of the
 * obvious fix. This gesture is the ONLY door to a FIRST tree in the whole
 * feature — there is no `canvas_tree_add_goal` agent tool, `bb canvas tree` has
 * no create verb, and every other write needs a node that is already on a
 * marked page. Gate it on `status === "ok"` and no tree can ever be started
 * from a cold room: the only pages that would offer the button are the ones
 * that are already trees. So the label states the consequence instead, which is
 * C3's own alternative ("an explicit 'start a tree here' intent that says so").
 *
 * INVALID IS GREYED WITH THE REASON, matching `blockerArmFor` and agent-arms.ts:
 * `addGoal` refuses a malformed mark outright, so an enabled button there is one
 * that can only ever produce a refusal toast.
 */
export function goalArmFor(mark: TreePageMarkState): TreeGestureArm {
  if (mark.status === "invalid") {
    return {
      label: "Add a goal",
      enabled: false,
      reason: `This page carries a malformed tree mark (${
        mark.error ?? "no detail"
      }), so a goal cannot be added to it until it is repaired.`,
    };
  }
  if (mark.status === "absent") {
    // The whole point of the sentence: pressing this turns the page into a
    // tree. Said in the LABEL rather than in a tooltip, because the label is
    // the only part a human reads before clicking.
    return { label: "Start a tree here", enabled: true, reason: "" };
  }
  return { label: "Add a goal", enabled: true, reason: "" };
}

/** A typed title, judged before it is sent. */
export type TreeTitleSubmission =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly why: string };

/**
 * Is this title worth a round trip?
 *
 * The write engine refuses a blank title (`empty-title`) and one over the cap
 * (`too-long`) whatever this says. This is the half that keeps a doomed
 * request — and the toast it would produce — off the screen, and it trims
 * exactly as the engine does so the two can never disagree about what was
 * sent.
 */
export function treeTitleSubmission(raw: string): TreeTitleSubmission {
  const title = raw.trim();
  if (title === "") {
    return { ok: false, why: "Type what this node is before adding it." };
  }
  if (title.length > MAX_GESTURE_TITLE) {
    return {
      ok: false,
      why: `That title is ${title.length} characters; the limit is ${MAX_GESTURE_TITLE}. Put the detail in the node's context note instead.`,
    };
  }
  return { ok: true, title };
}

/**
 * Which composer is on screen. Never two: one field is anchored to a node and
 * one is not, and both listen for Enter — a state with both open is one a
 * human cannot read.
 */
export type TreeComposerState = "closed" | "goal" | "blocker";

export type TreeComposerEvent =
  /** A gesture's own button was pressed — the toggle. */
  | { readonly type: "open"; readonly gesture: TreeGestureId }
  /** Escape, anywhere in the window. */
  | { readonly type: "escape" }
  /** A title was sent. */
  | { readonly type: "submitted" }
  /** The selection moved to a different shape (or to none). */
  | { readonly type: "target-changed" }
  /** A pointerdown landed somewhere. `insideWidget` covers the buttons AND the
   * composer — see the case. */
  | { readonly type: "pointerdown"; readonly insideWidget: boolean };

/**
 * One transition. Returns the SAME state when nothing moved, so a render can
 * be skipped: Escape and pointerdowns arrive constantly for reasons that have
 * nothing to do with this widget.
 */
export function nextTreeComposer(
  state: TreeComposerState,
  event: TreeComposerEvent,
): TreeComposerState {
  switch (event.type) {
    case "open": {
      const wanted = event.gesture === "add-goal" ? "goal" : "blocker";
      // A second press of the thing that opened this means shut; a press of
      // the OTHER one swaps, rather than stacking a second field.
      return state === wanted ? "closed" : wanted;
    }
    case "escape":
      return "closed";
    case "submitted":
      return "closed";
    case "target-changed":
      // ONLY THE BLOCKER COMPOSER. It is anchored to the selected node and its
      // Enter acts on that node, so a selection change would leave it acting
      // on a shape the human is no longer looking at (agent-menu.ts's
      // "the anchor went"). A goal has no anchor and no subject — closing it
      // because a click landed on a note would throw away typing for nothing.
      return state === "blocker" ? "closed" : state;
    case "pointerdown":
      // canvas/dock/dock.ts's `insideWidget` lesson, carried over rather than
      // re-learned: containment is the CALLER's answer for every root, so a
      // press on the field itself is not read as "outside" and does not
      // dismiss the field on the way down, before the click arrives.
      return event.insideWidget ? state : "closed";
  }
}
