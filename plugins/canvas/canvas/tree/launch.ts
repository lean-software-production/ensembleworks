// W12 — STARTING A THREAD ON ONE NODE: the outbound leg of "hand this piece of
// the tree to somebody".
//
// W8 carries a node INTO a conversation a human is already having. This carries
// a node into a conversation that does not exist yet: a human selects a node,
// presses one control, and a bb thread is spawned to work on it and bound to
// that node — the same link, the same badge, the same lifecycle events and the
// same canvas-gc sweep the note-launch path has had since the first spike.
// NOTHING here is a second link store; `AgentLinks` is the one store and the
// rpc handler records through it exactly as `canvas_run_note` does.
//
// FOUR DECISIONS.
//
// 1. WHAT THE PROMPT CARRIES, AND WHY IT IS NOT REDUNDANT WITH W7. The per-turn
//    brief (instructions.ts) already gives a tree thread its node, its path to
//    root, its blockers and the tree outline — so a launch prompt repeating
//    them looks like duplication. It is not, for two separate reasons.
//
//    THE ORDERING. `AgentLinks.record` cannot run until `threads.spawn`
//    RESOLVES, and spawn is what starts turn 1. So while the first turn is
//    being constructed `linkedShapeId(threadId)` is still null, which means
//    `selectTreeTools` returns [] and `treeInstructions` returns null: turn 1
//    of a launched thread has NO tree tools and NO brief. From turn 2 on
//    (`configure` re-runs at turn submit) it has both. The prompt is what turn
//    1 has, so the prompt has to stand on its own.
//    tests/tree-launch-rpc.test.ts reads the link store from inside spawn and
//    pins that ordering, rather than leaving it as a belief about bb.
//
//    THE CONTEXT NOTE. W7 deliberately never carries it — the brief is a
//    per-turn tax and a node's context note can be 8,000 characters. It is
//    also the ONE thing that says why this node exists and what done means, so
//    it is exactly what a thread being handed the node needs, once, up front.
//    That is the content this prompt adds that no other surface ever gives.
//
// 2. THE ORIENTATION IS W7'S OWN LINES, IMPORTED, NOT RE-DERIVED.
//    `orientationLines` is exported from instructions.ts for this. Two
//    renderings of "what node is this and what blocks it" would drift, and the
//    drift would be invisible: a human comparing a launch prompt with a
//    per-turn brief would see two descriptions of one node and have no way to
//    tell which is stale.
//
// 3. CONTEXT OUTRANKS ORIENTATION HERE — the exact inverse of W7's ranking, on
//    purpose. W7 ranks orientation above the digest because a model that does
//    not know which node it is on cannot use the tree. Here the orientation is
//    the part that comes back every turn anyway, and the context note is the
//    part that never does. So the orientation is capped at a third and the
//    note gets what is left.
//
// 4. AN EMPTY CONTEXT NOTE LAUNCHES ANYWAY, AND SAYS SO. See `NO_CONTEXT`.
//
// PURE: W5's service in, text out. No bb SDK import, no DOM — the arm rule
// below is read by the panel and the brief by the server, and neither needs
// the other's environment.
import { threadTitleFor } from "../agents.js";
import { titleOf } from "./answers.js";
import type { TreeGestureArm, TreeGestureTarget } from "./gestures.js";
import { orientationLines } from "./instructions.js";
import { fitLines, type TreeService } from "./service.js";

/**
 * Hard ceiling on the spawned prompt.
 *
 * The same number `MAX_ANSWER_CHARS` uses, for the same reason: this lands in
 * the model's context window as the first user message and stays there for the
 * life of the thread. A node's context note alone may be 8,000 characters
 * (`MAX_CONTEXT_LENGTH`), so something has to give — and it gives HERE, with a
 * marker, rather than by handing a model a message it will silently carry
 * forever.
 */
export const LAUNCH_PROMPT_MAX_CHARS = 4_000;

/** The most of the budget the node's orientation may take — decision 3. */
const ORIENTATION_SHARE = 3;

/** The shortest note worth quoting. Below this the note is not shown at all
 * and the closing sentence says where to read it — a three-word fragment of
 * somebody's definition of done is worse than an honest pointer. */
const MIN_NOTE_CHARS = 80;

const LEAD =
  "Work on one node of a discovery tree on the canvas. Everything below was read off that tree at launch.";

const CONTEXT_LEAD = "context, as the human wrote it on this node:";

/**
 * Said when the node has no context note.
 *
 * LAUNCH ANYWAY, DO NOT REFUSE — and this line is why that is defensible. The
 * yak-mapping method is right that a node nobody has written anything on is
 * not ready to be picked up; the question is who gets to say so. Refusing at
 * the button makes this plugin the judge of whether a human's title is enough,
 * and the failure mode is a human who knows exactly what they mean and cannot
 * start. Launching hands the same judgement to the thread, WITH the fact that
 * nothing was written and an instruction not to invent it: the pick-up is
 * still blocked, by a question a human can answer in one sentence rather than
 * by a greyed control that cannot be argued with.
 */
const NO_CONTEXT =
  "context: NONE — no context note was written on this node. Do not guess what it means: say what you would need to know, or ask, before doing any work.";

/** Said when the note was there but did not fit. */
const CONTEXT_CUT =
  "context: written, but too long to quote here — read the whole note with canvas_tree_node.";

/** Said when the brief showed everything it had. */
const WHOLE =
  "Re-read the tree live with canvas_tree_node and canvas_tree_children before you act, record what you learn with canvas_tree_write_context, and move this node with canvas_tree_set_state only when the work is really done.";

/** Said when it did not — the same honesty rule W5's digest and W7's brief
 * follow, and the same reason: bb never marks a cut, so a brief that let a
 * budget do the cutting would lose its own admission off the end. */
const PARTIAL =
  "This brief is INCOMPLETE — it was cut to fit. Read the whole node, context note included, with canvas_tree_node, and the rest of the tree with canvas_tree_children or canvas_tree_subtree. Record what you learn with canvas_tree_write_context, and move this node with canvas_tree_set_state only when the work is really done.";

/** Reserved against the WIDER closing before a single line is kept. */
const CLOSING_RESERVE = Math.max(WHOLE.length, PARTIAL.length);

/** The blocks are joined by a blank line. */
const JOIN = "\n\n";

// ---------------------------------------------------------------------------
// The brief

export interface LaunchBrief {
  /** The spawned thread's title, as bb's sidebar will show it. */
  readonly title: string;
  /** The spawned thread's first message. */
  readonly prompt: string;
}

export type LaunchRead =
  | { readonly ok: true; readonly value: LaunchBrief }
  | { readonly ok: false; readonly why: string };

/**
 * What to spawn for this node, or the reason there is nothing to spawn.
 *
 * The refusal is W5's OWN sentence, unedited: it names the node and says
 * whether it is missing, on no tree, or unreadable — which is what a human
 * needs to work out what happened to a node they can see on their screen.
 */
export function launchBrief(
  nodeId: string,
  service: TreeService,
  maxChars: number = LAUNCH_PROMPT_MAX_CHARS,
): LaunchRead {
  const found = service.node(nodeId);
  if (!found.ok) return { ok: false, why: found.detail };
  const node = found.value;

  const room = maxChars - LEAD.length - CLOSING_RESERVE - JOIN.length * 3;
  const orientation = fitLines(
    orientationLines(node, service),
    Math.max(MIN_NOTE_CHARS, Math.floor(room / ORIENTATION_SHARE)),
  );
  const context = contextBlock(node.context, room - orientation.text.length);
  const partial = orientation.truncated || context.truncated;

  return {
    ok: true,
    value: {
      // The title comes from the NODE, not from the prompt: `threadTitleFor`
      // takes the head of what it is given, and the head of this prompt is
      // LEAD — every thread would be called "Canvas: Work on one node of a".
      // Reusing the function rather than the argument is the point.
      title: threadTitleFor(titleOf(node)),
      prompt: [LEAD, orientation.text, context.text, partial ? PARTIAL : WHOLE].join(JOIN),
    },
  };
}

/** The context note as a block, cut to what is left. */
function contextBlock(context: string, budget: number): { text: string; truncated: boolean } {
  const note = context.trim();
  if (note === "") return { text: NO_CONTEXT, truncated: false };
  const room = budget - CONTEXT_LEAD.length - 1;
  if (room < MIN_NOTE_CHARS) return { text: CONTEXT_CUT, truncated: true };
  if (note.length <= room) return { text: `${CONTEXT_LEAD}\n${note}`, truncated: false };
  return { text: `${CONTEXT_LEAD}\n${note.slice(0, room - 1)}…`, truncated: true };
}

// ---------------------------------------------------------------------------
// The arm

/**
 * The "work on this node" arm for this selection.
 *
 * IT SITS BESIDE THE NOTES-ONLY LAUNCH ARM RATHER THAN WIDENING IT, and that
 * is decision 2 of this node. `agent-arms.ts` offers "Run as new thread" on
 * any `note`, spawning on the note's RAW BODY TEXT; a tree node is a note, so
 * it already gets that arm. But the difference between the two is not the
 * shape's kind — it is what the prompt IS. This one is a server-side read of
 * the tree (path, blockers, context note) that the panel does not even have
 * the service to build; that one is the text the human typed. Widening
 * `LAUNCHABLE_KIND` would not have produced this prompt, and teaching
 * `agentArmsFor` about trees would put a tree rule in the module whose header
 * says it is deliberately free of them.
 *
 * So a tree node carries both, in the two places the human already looks: the
 * agent affordance's "Run as new thread" at the shape's corner, and this one
 * in W4's anchored group under the node, beside "Add a blocker…" and "Discuss
 * this node". The cost is stated rather than hidden — two ways to start a
 * thread on one shape, and because both record through the same `AgentLinks`
 * key, the second REPLACES the first shape's link. W14 rules on whether that
 * is confusing on a real canvas.
 *
 * NULL WITH NO TARGET, disabled-never-hidden otherwise: W4's rule for the
 * whole anchored group, not a new one.
 */
export function workArmFor(
  target: TreeGestureTarget | null,
  linked: boolean,
): TreeGestureArm | null {
  if (target === null) return null;
  // "Again" rather than a refusal, mirroring `agentArmsFor`'s launch arm:
  // `AgentLinks.record` replaces a shape's link by design, so refusing here
  // would forbid something the store supports.
  const label = linked ? "Work on this node again" : "Work on this node";
  if (target.treeId === null) {
    return {
      label,
      enabled: false,
      reason: "This shape is not a node of a tree — start one with “Add a goal”.",
    };
  }
  return { label, enabled: true, reason: "" };
}
