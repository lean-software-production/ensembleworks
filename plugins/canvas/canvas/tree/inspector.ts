// W18 — THE NODE INSPECTOR's decisions: what a human is looking at, what the
// controls say, and — the part that actually needed thinking — WHAT HAPPENS
// WHEN THE DOCUMENT MOVES UNDER AN OPEN EDITOR.
//
// PURE, and free of the bb SDK and the DOM, the same split `gestures.ts` and
// `discuss.ts` make: this project has no jsdom, so anything decided inside the
// .tsx is decided where no test can reach it.
//
// NOTHING HERE WRITES. Every edit goes to the SERVER — `canvas_tree_set_state`
// / `canvas_tree_set_approached` / `canvas_tree_write_context` over rpc, into
// W10's engine — for the reasons rpc-contract.ts gives beside W4's two gesture
// methods: one definition of a legal write, one place that re-reads the
// invariants afterwards, one durable commit. A panel that edited its own copy
// of the document would be a second write path, and the two would drift.
//
// THE SUBJECT IS NOT RE-DECIDED HERE. `treeGestureTargetFor` already answers
// "which single shape is this chrome about", and the inspector takes ITS
// answer rather than computing a second one from the selection — two rules for
// one question is how a panel ends up inspecting a different node than the one
// the buttons act on.
import type { Shape } from "@ensembleworks/canvas-model";
import { shapeText, type LiveText } from "../shape-text.js";
import { MAX_CONTEXT_LENGTH, readTreeNode, NODE_STATES, type NodeState } from "./encoding.js";
import type { TreeGestureTarget } from "./gestures.js";

// ---------------------------------------------------------------------------
// What is being inspected
// ---------------------------------------------------------------------------

/** The node as the inspector shows it: the three fields the agent reads and
 * writes, plus what the node is called. No second vocabulary — these are
 * `meta.state`, `meta.approached` and `meta.context` verbatim. */
export interface InspectorSubject {
  readonly nodeId: string;
  readonly treeId: string;
  /** Resolved by the plugin's one rule for it (`canvas/shape-text.ts`) — the
   * string on the human's screen, not `props.richText` on its own. */
  readonly title: string;
  readonly state: NodeState;
  readonly approached: boolean;
  readonly context: string;
}

/**
 * One node, read for the inspector — or null when that id is not a readable
 * node of a tree right now.
 *
 * NULL RATHER THAN AN "EMPTY" VIEW WITH A SENTENCE IN IT, and that is a
 * decision, not a shortcut. The first draft of this module had a three-case
 * view — `none` ("select a node"), `not-a-node`, `node` — and the panel
 * rendered a column for all three. Two things were wrong with it. A 320px
 * column permanently taking width from the drawing surface to say "select
 * something" is a bad trade on a spatial canvas; and the sentence it would
 * show for a shape that is not a tree node is ALREADY on screen, on W4's
 * greyed "Add a blocker…" arm, anchored to the very shape the human clicked.
 * A second copy of it in a second place is how two surfaces start disagreeing
 * about one selection.
 *
 * So the inspector is present exactly when there is something to inspect, and
 * this function has no unreachable branch to mistake for coverage — W17's
 * lesson, applied while the code is being written rather than after.
 */
export function subjectFor(
  nodeId: string,
  shapeOf: (shapeId: string) => Shape | undefined,
  textOf: LiveText,
): InspectorSubject | null {
  const shape = shapeOf(nodeId);
  if (shape === undefined) return null;
  const read = readTreeNode(shape);
  // `invalid` and `absent` collapse here: either way this is not a node a
  // human can edit as one. WHY a malformed node is malformed is W1's to
  // report through `checkTreeInvariants`, which names the offending key —
  // not a sentence in a side panel.
  if (read.status !== "ok") return null;
  return {
    nodeId: shape.id,
    treeId: read.value.tree,
    title: shapeText(shape, textOf(shape.id)).trim(),
    state: read.value.state,
    approached: read.value.approached,
    context: read.value.context,
  };
}

/**
 * The subject for the chrome's own target — `treeGestureTargetFor`'s answer,
 * taken rather than recomputed, so the inspector can never be looking at a
 * different node than the buttons act on.
 */
export function inspectorSubjectFor(input: {
  readonly target: TreeGestureTarget | null;
  readonly shapeOf: (shapeId: string) => Shape | undefined;
  readonly textOf: LiveText;
}): InspectorSubject | null {
  if (input.target === null) return null;
  return subjectFor(input.target.shapeId, input.shapeOf, input.textOf);
}

// ---------------------------------------------------------------------------
// The controls
// ---------------------------------------------------------------------------

export interface StateArm {
  readonly state: NodeState;
  readonly label: string;
  /** True for the state the node is in now. The control is still pressable —
   * the engine answers "was already done; nothing changed", which is a
   * truthful and cheap answer, and disabling it would make the current state
   * the one thing a human cannot click on. */
  readonly selected: boolean;
}

/** All three states, always, in the order encoding.ts declares them — so the
 * control reads as one axis rather than as three unrelated buttons. */
export function stateArmsFor(subject: InspectorSubject): readonly StateArm[] {
  return NODE_STATES.map((state) => ({
    state,
    label: state === "wip" ? "in progress" : state,
    selected: subject.state === state,
  }));
}

export interface ApproachedArm {
  readonly label: string;
  readonly pressed: boolean;
  /** What a press will do, in words — the axis is not obvious from the name. */
  readonly hint: string;
}

/**
 * The `approached` toggle.
 *
 * The label names the AXIS and the hint names the MOVE, rather than the label
 * naming the move: a toggle whose label changes to its own inverse is the
 * control every reader misreads at least once.
 */
export function approachedArmFor(subject: InspectorSubject): ApproachedArm {
  return subject.approached
    ? {
        label: "Looked at it — nothing came up",
        pressed: true,
        hint: "Press to take that back.",
      }
    : {
        label: "Not looked at yet",
        pressed: false,
        hint: "Press to record that you looked at this and nothing came up.",
      };
}

// ---------------------------------------------------------------------------
// The context note, and the multiplayer problem
// ---------------------------------------------------------------------------

export type ContextSubmission =
  | { readonly ok: true; readonly context: string }
  | { readonly ok: false; readonly why: string };

/**
 * Is this note sendable?
 *
 * AN EMPTY NOTE IS LEGAL — clearing a context note is a real edit, unlike an
 * empty title, which `treeTitleSubmission` refuses because a nameless node is
 * unreadable on the canvas. The cap is `encoding.ts`'s own, restated at the
 * screen for `treeTitleSubmission`'s reason: to keep a doomed round trip off
 * the wire, not as the guarantee (the engine refuses over it regardless).
 */
export function contextSubmission(draft: string): ContextSubmission {
  if (draft.length > MAX_CONTEXT_LENGTH) {
    return {
      ok: false,
      why: `That note is ${draft.length} characters; the limit is ${MAX_CONTEXT_LENGTH}.`,
    };
  }
  return { ok: true, context: draft };
}

/**
 * An open context editor.
 *
 * `base` is WHAT THE DOCUMENT HELD when this draft started, and it is the
 * value the save states as its expectation (`writeContext`'s `expected`), so
 * the engine can refuse a save that would overwrite somebody else's note.
 * `theirs` is a value that arrived while the draft was dirty — held, never
 * applied. `waiting` is a subject the selection moved to while the draft was
 * dirty — also held, never applied.
 */
export interface ContextEditor {
  readonly nodeId: string | null;
  readonly base: string;
  readonly draft: string;
  readonly theirs: string | null;
  readonly waiting: { readonly nodeId: string | null; readonly context: string } | null;
}

export const NO_CONTEXT_EDITOR: ContextEditor = {
  nodeId: null,
  base: "",
  draft: "",
  theirs: null,
  waiting: null,
};

export type ContextEditorEvent =
  /** What the DOCUMENT says right now: the selected node and its note. Fired
   * on every render, so it covers both "the selection moved" and "a peer
   * rewrote this note" — they are the same event because they are the same
   * fact, and telling them apart is this module's job, not the panel's. */
  | { readonly type: "subject"; readonly nodeId: string | null; readonly context: string }
  | { readonly type: "typed"; readonly draft: string }
  /** The human chose the other value, losing their draft. */
  | { readonly type: "take-theirs" }
  /** The human chose their draft, knowing it will overwrite the other value. */
  | { readonly type: "keep-mine" }
  /** The human threw their draft away. */
  | { readonly type: "discarded" }
  /** The server accepted a save, and this is what is now stored. */
  | { readonly type: "saved"; readonly context: string };

/** Has this editor got unsaved typing in it? */
export const isDirty = (editor: ContextEditor): boolean => editor.draft !== editor.base;

/** What to tell the human about a collision, or null when there is none. */
export function conflictNoticeFor(editor: ContextEditor): string | null {
  if (editor.theirs === null) return null;
  return `Someone else rewrote this note while you were typing (${editor.theirs.length} characters). Nothing has been overwritten — choose which one to keep.`;
}

/** What is being held back, or null. Rendered so a human is never quietly
 * looking at a node other than the one they selected. */
export function waitingNoticeFor(editor: ContextEditor): string | null {
  if (editor.waiting === null) return null;
  return "You have unsaved changes to this note, so the inspector is still on this node. Save or discard to follow the selection.";
}

export interface SaveArm {
  readonly enabled: boolean;
  readonly label: string;
  /** Empty when enabled. */
  readonly reason: string;
}

export function saveArmFor(editor: ContextEditor): SaveArm {
  const verdict = contextSubmission(editor.draft);
  if (!verdict.ok) return { enabled: false, label: "Save note", reason: verdict.why };
  if (!isDirty(editor)) {
    return { enabled: false, label: "Save note", reason: "This note has not been changed." };
  }
  return { enabled: true, label: "Save note", reason: "" };
}

/** Take a subject wholesale — the clean case, and the only one that ever
 * replaces a draft. */
const adopt = (nodeId: string | null, context: string): ContextEditor => ({
  nodeId,
  base: context,
  draft: context,
  theirs: null,
  waiting: null,
});

/**
 * One transition.
 *
 * THE RULE, and it is one rule applied three times: A DIRTY DRAFT IS NEVER
 * REPLACED BY ANYTHING BUT THE HUMAN WHO TYPED IT. A clean editor follows the
 * document (there is nothing to lose, and following is what makes the panel
 * live); a dirty one holds whatever arrives beside itself and names it. This
 * run has repeatedly chosen a visible refusal over a silent loss, and a
 * context note — up to 8000 characters of somebody's thinking — is the most
 * expensive thing in this feature to lose.
 */
export function nextContextEditor(
  editor: ContextEditor,
  event: ContextEditorEvent,
): ContextEditor {
  switch (event.type) {
    case "subject": {
      if (editor.nodeId === null) return adopt(event.nodeId, event.context);
      if (!isDirty(editor) && editor.theirs === null) {
        return event.nodeId === editor.nodeId && event.context === editor.base
          ? editor
          : adopt(event.nodeId, event.context);
      }
      if (event.nodeId === editor.nodeId) {
        // Same node, dirty draft: only a CHANGE to the stored note is news.
        if (event.context === editor.base) return editor;
        if (event.context === editor.theirs) return editor;
        return { ...editor, theirs: event.context };
      }
      // The selection moved. Hold the new subject rather than the draft.
      if (
        editor.waiting?.nodeId === event.nodeId &&
        editor.waiting.context === event.context
      ) {
        return editor;
      }
      return { ...editor, waiting: { nodeId: event.nodeId, context: event.context } };
    }
    case "typed":
      return { ...editor, draft: event.draft };
    case "take-theirs": {
      const theirs = editor.theirs ?? editor.base;
      const resolved: ContextEditor = { ...editor, base: theirs, draft: theirs, theirs: null };
      return released(resolved);
    }
    case "keep-mine":
      // The draft stays; the EXPECTATION moves to what is actually stored, so
      // the save the human asked for is the one the server accepts. The
      // overwrite is now something they chose while looking at both values.
      return { ...editor, base: editor.theirs ?? editor.base, theirs: null };
    case "discarded":
      return released({ ...editor, draft: editor.base, theirs: null });
    case "saved":
      return released({ ...editor, base: event.context, draft: event.context, theirs: null });
  }
}

/** A draft that is no longer dirty stops holding the selection back. */
function released(editor: ContextEditor): ContextEditor {
  if (editor.waiting === null) return editor;
  return adopt(editor.waiting.nodeId, editor.waiting.context);
}
