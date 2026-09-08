// WHICH ARMS THE AGENT AFFORDANCE OFFERS, and on what.
//
// Task 2a of the launch-or-attach work: the single "Run as agent" button
// becomes one affordance with two arms — launch a NEW bb thread on this note's
// text, or attach this shape to a thread that already exists in bb.
//
// THE TWO ARMS ARE NOT THE SAME SHAPE, and that asymmetry is the whole reason
// this module exists. Launching turns the note's body into a prompt, so it can
// only be offered where there is a body: notes. Attaching sends nothing but two
// ids, so it is offered on ANY shape — a frame, a rectangle, an image can all
// usefully carry a badge that opens the conversation about it.
//
// WHY NOT AN INLINE TERNARY. It was one — `doc.byId.get(selected)?.kind ===
// "note" ? selected : null` in agents-ui.tsx — and this project has no jsdom
// and may not gain one, so a rule written inline in a component is a rule no
// test can reach. Same split canvas/pages/page-menu.ts and canvas/dock/
// squeeze.ts already make, and stated in those files' headers for the same
// reason.

/** The kind of shape the launch arm can read a prompt out of.
 *
 * ONE KIND, DELIBERATELY, and not `TEXT_CAPABLE_KINDS` (which also holds
 * "text" and "geo"). Widening the launch arm to every shape that happens to
 * carry editable text is a product decision nobody has made — the affordance
 * shipped as notes-only and Task 2a says it stays that way — and a spike is the
 * wrong place to widen it silently. A `text` shape's body is a label, not a
 * brief. */
export const LAUNCHABLE_KIND = "note";

/** The shape the affordance is offered on. */
export interface AgentTarget {
  readonly shapeId: string;
  /** The shape's kind, as the document reports it. A plain string rather than
   * canvas-model's `ShapeKind` union: the caller reads it off a `Shape` it
   * already has, and narrowing here would make an unknown future kind a type
   * error in a spike that only ever compares it to one literal. */
  readonly kind: string;
}

export const AGENT_ARM_IDS = ["launch", "attach"] as const;
export type AgentArmId = (typeof AGENT_ARM_IDS)[number];

export interface AgentArm {
  readonly id: AgentArmId;
  readonly label: string;
  /** False renders the item greyed and inert, NOT absent — see `agentArmsFor`. */
  readonly enabled: boolean;
}

/**
 * The one shape the agent menu hangs off, or null when there is not exactly
 * one.
 *
 * EXACTLY ONE, for two separate reasons that happen to agree. A menu is
 * anchored to a shape's screen box, and "the" box of a two-shape selection is
 * not a thing; and the link store is keyed by a single shape id, so "attach
 * both of these to one thread" is not a state `AgentLinks` can hold. A create
 * tool mid-drag also has a selection, which is why an id the document does not
 * know is no target either — its `kind` would be undefined and every arm's
 * enablement would be a guess about a shape that does not exist yet.
 *
 * NOTE THE WIDENING. This used to answer null for every non-note, because the
 * only arm was launch. It now answers a target for any shape in the document;
 * the notes-only rule moved down into `agentArmsFor`, where it belongs, because
 * it was never a fact about the SELECTION.
 */
export function agentTargetFor(input: {
  readonly selection: ReadonlySet<string>;
  readonly kindOf: (shapeId: string) => string | undefined;
}): AgentTarget | null {
  if (input.selection.size !== 1) return null;
  const shapeId = [...input.selection][0] as string;
  const kind = input.kindOf(shapeId);
  if (kind === undefined) return null;
  return { shapeId, kind };
}

/**
 * The menu's items, in the order they are drawn.
 *
 * LAUNCH FIRST because it is the arm that already existed and the one a single
 * click used to perform; putting the new arm on top would move the old
 * behaviour out from under everybody's muscle memory.
 *
 * DISABLED, NEVER HIDDEN, for the launch arm on a non-note. The same call
 * canvas/pages/PageSwitcher.tsx's tab menu already makes and for the same
 * stated reason: a greyed item says why it cannot be used, whereas a menu that
 * silently has one item on a rectangle and two on a note reads as a bug.
 *
 * `linked` CHANGES ONE WORD AND NOTHING ELSE. It renames the launch arm to
 * "again", exactly as the old button did, and deliberately does NOT touch the
 * attach arm: re-attaching an already-linked shape is legal — `AgentLinks.
 * record` replaces a shape's link by design — so disabling or renaming attach
 * there would refuse something the store supports.
 */
export function agentArmsFor(target: AgentTarget, linked: boolean): AgentArm[] {
  return [
    {
      id: "launch",
      label: linked ? "Run again as new thread" : "Run as new thread",
      enabled: target.kind === LAUNCHABLE_KIND,
    },
    {
      id: "attach",
      // The ellipsis is the standard "this opens something you must choose
      // from" marker, and it is load-bearing next to an arm that acts
      // immediately.
      label: "Attach to existing thread…",
      enabled: true,
    },
  ];
}
