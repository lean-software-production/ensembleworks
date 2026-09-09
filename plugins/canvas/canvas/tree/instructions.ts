// W7 — the PER-TURN BRIEF: what an agent is told about its tree before it has
// asked anything.
//
// W6 gave a thread six tools. This is the surface it gets WITHOUT a tool call:
// bb resolves `contributeInstructions` when a thread's runtime config is built
// (thread start / turn submit) and appends the returned text to the thread's
// instructions. A model launched on a node therefore arrives knowing which
// node, what it is for, and what is in its way — instead of spending its first
// turn finding out.
//
// FOUR THINGS THIS FILE DECIDES.
//
// 1. SILENCE IS THE DEFAULT. This provider runs for EVERY thread in the
//    project, most of which have nothing to do with a canvas. A thread with no
//    tree node gets `null` — not a "this project has a canvas" paragraph,
//    which would be a permanent tax on every unrelated thread's context. The
//    subject is resolved by W6's `treeThreadSubject`, which follows the
//    DOCUMENT rather than the link, so a thread linked to a plain note or to a
//    node the human has since deleted is silent too.
//
// 2. THE CEILING IS OURS TO ENFORCE, NOT bb'S. bb truncates output over 4096
//    characters, with no marker. A brief that let bb do the cutting would lose
//    its own "this is incomplete" sentence off the end — which is exactly the
//    defect C1 found inside the digest, one level up. So this module bounds
//    itself to `INSTRUCTIONS_MAX_CHARS` and bb's cut is never reached.
//
// 3. ORIENTATION OUTRANKS THE TREE. Plan risk 1 is that the digest is the
//    ambient context and a big tree degrades it silently. What must survive
//    that degradation is not the tree — it is the THREAD'S OWN NODE, its path
//    to root and its immediate blockers, because without those a model does
//    not know what the digest is a digest OF. So those lines are ranked above
//    the digest, capped so they cannot starve it either, and the digest gets
//    whatever room is left.
//
// 4. THERE IS NO "WHAT CHANGED SINCE THE LAST TURN" LINE, AND THE ABSENCE IS
//    DELIBERATE. The plan asked for one. It cannot be made accurate here: the
//    provider is handed `{threadId, projectId}` and nothing else, and bb only
//    applies a contribution when the provider session is next CONSTRUCTED — a
//    live session keeps the instructions it started with. Any per-thread
//    baseline this module wrote would therefore advance on resolutions whose
//    text the model never reads, and the next diff would silently skip the
//    changes in between. A "nothing changed" that is sometimes wrong is worse
//    than no line: it is the one sentence a model would trust without
//    checking. The state each node is in IS carried, per node, every turn —
//    that is a true snapshot, and a diff is a tool call away. See
//    artifacts/harness/c89c66dd/w7-per-turn-digest.md.
//
// Pure, like the rest of the read spine: the input is W5's `TreeService` and a
// subject resolver, the output is text. No bb SDK type is imported here — the
// registration lives in agent-tools.ts, which is what keeps this module free
// of a cycle with it.
import { oneLine } from "./answers.js";
import { NODE_DIRECTIVE_SYNTAX } from "./node-reference.js";
import { fitLines, type TreeNodeView, type TreeService } from "./service.js";

/**
 * The host's ceiling on a contribution, enforced HERE.
 *
 * bb documents "output longer than 4096 characters is truncated" and says
 * nothing about a marker, so a brief that overshot would be cut mid-sentence
 * with its own honesty line — the last thing in the text — gone.
 */
export const INSTRUCTIONS_MAX_CHARS = 4_096;

/**
 * The most blockers the brief spells out before it counts the rest.
 *
 * A node with fifty blockers is a real tree; fifty lines ranked above the
 * digest would leave the model reading one node's queue and nothing about the
 * tree it sits in. Ten is enough to choose from, and `canvas_tree_children`
 * answers with the whole list the moment the model wants it.
 */
const BLOCKERS_IN_BRIEF = 10;

/**
 * The most of the budget the node's own orientation may take.
 *
 * The same argument as the digest's `LINE_SHARE`, one level up: without a
 * ceiling, one node with a very long path and a wide blocker list spends the
 * whole brief and the tree disappears from it. Half, because the two halves
 * answer different questions — "what am I doing" and "what is this part of" —
 * and losing either one entirely is the failure.
 */
const ORIENTATION_SHARE = 2;

/** Said when the brief showed everything it had. */
const WHOLE =
  "This brief is the tree in outline. It never carries a node's context note — read one with canvas_tree_node, and use canvas_tree_children, canvas_tree_path, canvas_tree_subtree or canvas_tree_ready for anything else.";

/** Said when it did not. Named tools map 1:1 onto what got dropped (W6). */
const PARTIAL =
  "This brief is INCOMPLETE — parts of this tree are not shown. Read them with canvas_tree_subtree (a branch), canvas_tree_children (one node's blockers), canvas_tree_ready (the whole ready list), canvas_tree_node (a node's context), canvas_tree_digest (the outline again).";

/**
 * How to point a human at a node from inside a reply (W9).
 *
 * THE ONE THING NO TOOL CAN TEACH, which is why it is here rather than in a
 * tool description. Every `canvas_tree_*` tool answers a question about the
 * tree; none of them is about how bb renders a message, and a description that
 * explained an unrelated rendering syntax would be teaching in the wrong place
 * (and only to a model that happened to call that tool). The brief is the
 * ambient surface a tree thread already has, and this is ambient knowledge: a
 * model that does not know the syntax simply never emits it, and the return
 * leg of D2 never runs.
 *
 * Reserved with the closing sentence rather than ranked with the tree lines,
 * for the same reason: on a big tree the outline is the first thing to go, and
 * a model on a big tree is the one MOST likely to need to point at one node in
 * particular.
 *
 * IT STILL RANKS BELOW THE CLOSING SENTENCE. If the budget cannot hold both
 * and leave a line of tree, this one goes. A brief that dropped "this is
 * INCOMPLETE" in order to keep a syntax lesson would be lying about itself to
 * teach a courtesy — and at that budget there is barely a tree to point INTO.
 * At the real ceiling (4096) both fit with room to spare; the ranking only
 * decides what a pathological budget loses first.
 */
const REFERENCE = `To point at one node in a reply, write ${NODE_DIRECTIVE_SYNTAX} — it renders as a card that takes the reader to that node on the canvas. Use a node's real id; a reference to anything else renders as a dead link.`;

/** Room reserved for whichever closing sentence turns out to be true, plus its
 * newline. Reserved against the WIDER of the two before a single line is kept,
 * for the reason `fitLines` reserves its own marker: the sentence that admits
 * an omission must not be the thing the omission removes. */
const CLOSING_RESERVE = Math.max(WHOLE.length, PARTIAL.length) + 1;

/** Room the reference sentence needs, taken only when what is left still holds
 * some tree — see REFERENCE's ranking note. */
const REFERENCE_RESERVE = REFERENCE.length + 1;

/** What the brief needs, and nothing else. */
export interface TreeInstructionDeps {
  /** W5's query surface, over the live room document. */
  readonly service: TreeService;
  /**
   * The tree node this thread is about, or null.
   *
   * Injected rather than resolved here: W6's `treeThreadSubject` is the ONE
   * rule for which threads are about a tree, and re-deriving it would be a
   * second scope rule to drift. Passing it in also keeps this module out of an
   * import cycle with `agent-tools.ts`, which registers it.
   */
  subject(threadId: string): TreeNodeView | null;
}

/**
 * The brief for one thread, or `null` when the thread is not about a tree.
 *
 * Synchronous and allocation-cheap on purpose: bb resolves this on the
 * thread-start path.
 */
export function treeInstructions(
  threadId: string,
  deps: TreeInstructionDeps,
  maxChars: number = INSTRUCTIONS_MAX_CHARS,
): string | null {
  const node = deps.subject(threadId);
  if (node === null) return null;

  const closingRoom = maxChars - CLOSING_RESERVE;
  if (closingRoom <= 0) return null;
  // The reference sentence is taken out of the budget only if doing so still
  // leaves something to say; otherwise it is dropped whole rather than cut.
  const carriesReference = closingRoom - REFERENCE_RESERVE > 0;
  const room = carriesReference ? closingRoom - REFERENCE_RESERVE : closingRoom;

  const orientation = fitLines(
    orientationLines(node, deps.service),
    Math.floor(room / ORIENTATION_SHARE),
  );

  // Whatever the orientation did not spend, minus the newline that will join
  // the two. The digest bounds itself to it — this is the same seam W5 built
  // `maxChars` for.
  const digestBudget = room - orientation.text.length - 1;
  const digest =
    digestBudget > 0 ? deps.service.digest(node.treeId, { maxChars: digestBudget }) : null;

  const blockersCut = node.childIds.length > BLOCKERS_IN_BRIEF;
  const partial =
    orientation.truncated ||
    blockersCut ||
    digest === null ||
    !digest.ok ||
    digest.value.truncated;

  const body = digest !== null && digest.ok ? [orientation.text, digest.value.text] : [orientation.text];
  const tail = carriesReference ? [partial ? PARTIAL : WHOLE, REFERENCE] : [partial ? PARTIAL : WHOLE];
  return [...body, ...tail].join("\n");
}

/**
 * The thread's own node, ranked: what it is, what it is for, what is in its way.
 *
 * One line each rather than a labelled block, because `fitLines` drops WHOLE
 * lines from the back — so a line is the unit of what can be lost, and each of
 * these three is worth losing separately.
 */
function orientationLines(node: TreeNodeView, service: TreeService): readonly string[] {
  return [
    `node: ${oneLine(node)}`,
    pathLine(node, service),
    ...blockerLines(node, service),
  ];
}

/** `up to root: shape:api > shape:goal` — nearest first, each blocking the
 * next, which is the direction W0 fixed. Ids only: the titles are on the
 * outline below, and a path of full node lines is the one thing here that
 * grows without bound. */
function pathLine(node: TreeNodeView, service: TreeService): string {
  const path = service.pathToRoot(node.id);
  if (!path.ok) {
    // A cycle has no truthful path, and inventing one is worse than admitting
    // it — the digest's problems below name the nodes involved.
    return `up to root: unavailable — ${path.reason}: ${path.detail}`;
  }
  if (path.value.length <= 1) return `up to root: ${node.id} is a root — this is the goal itself`;
  return `up to root: ${path.value.map((step) => step.id).join(" > ")}`;
}

/**
 * The work this node is waiting on: a header naming the count, then ONE LINE
 * PER BLOCKER.
 *
 * One line each rather than a `;`-joined run — the mutation "blocker cap
 * removed" survived the first round and showed why. `fitLines` clamps a LINE
 * to a share of the budget (239 characters at the default), which binds long
 * before a ten-entry cap does, so a joined list arrived cut mid-title however
 * few entries it held: the cap was a dead bound and the blockers were
 * unreadable. Split into lines, both bounds do work — the cap decides how many
 * blockers, the clamp decides how much of each — and `fitLines` drops whole
 * blockers from the back rather than beheading the last one.
 *
 * THE COUNT AND THE RECOVERY GO IN THE HEADER, above the list, not after it. A
 * trailing "… and N more" is the first thing a clamp or a dropped line
 * removes — the same defect C1 found in the digest, one level down, and the
 * test `caps the blocker list rather than letting it starve the digest` caught
 * it here. Nothing below the header is promised, so a list cut short
 * under-delivers instead of lying.
 */
function blockerLines(node: TreeNodeView, service: TreeService): readonly string[] {
  const children = service.children(node.id);
  if (!children.ok) return [`blocked by: unavailable — ${children.reason}: ${children.detail}`];
  if (children.value.length === 0) {
    return [
      `blocked by: nothing — ${
        node.isReady ? "this node is ready to start" : "it is already done"
      }`,
    ];
  }
  return [
    `blocked by ${children.value.length} (canvas_tree_children lists them all):`,
    ...children.value.slice(0, BLOCKERS_IN_BRIEF).map((child) => `  - ${oneLine(child)}`),
  ];
}
