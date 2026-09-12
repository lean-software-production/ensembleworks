// W18 — WHAT A NODE'S STATE LOOKS LIKE ON THE NODE, decided here rather than
// in a component.
//
// THE DEFECT THIS CLOSES (plan.md follow-up 1, C3's "F1 in mirror image").
// `meta.state`, `meta.approached` and `meta.context` have been readable and
// writable by an agent since W6/W10, and NOTHING on the canvas rendered any of
// them. An agent could mark a node done and the board showed exactly what it
// showed before. The agent saw strictly more of the tree than the person who
// drew it — which is the same class of bug as W14's F1 (agent and human
// writing different channels), seen from the other side.
//
// THE MARK IS THE MORE IMPORTANT HALF OF THIS NODE, and it is separate from
// the inspector on purpose: an inspector answers "what is THIS node", one node
// at a time, and the question a human actually walks up to a tree with is
// "what is DONE". That question has to be answerable by looking, with nothing
// selected.
//
// ADDITIVE OVERLAY CHROME, NOT A SHAPE PROP. The mark is drawn OVER the note
// canvas-react already draws, exactly as W2's quarantine marker is drawn over
// the arrow canvas-react already routes (D5). Nothing here writes to the
// document, nothing changes `props`, and `canvas-react` is untouched — a state
// baked into a shape's fill would be a second encoding of `meta.state` that
// every write would have to keep in step.
//
// DOM-FREE AND REACT-FREE, the split `agents-view.ts`/`agents-ui.tsx` and
// `edge-view.ts`/`quarantine-layer.tsx` both make, for the reason this project
// keeps re-stating: there is no jsdom here, so a rule inside a component is a
// rule no test can drive.
import type { Camera } from "@ensembleworks/canvas-editor";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import type { ViewportSize } from "@ensembleworks/canvas-react";
import { screenBoxFor } from "../agents-view.js";
import { readTreeNode, type NodeState } from "./encoding.js";

/**
 * What each state is CALLED on the canvas.
 *
 * Words, not colour alone — the same call `edge-view.ts` made about the
 * quarantine marker, and for the same reason: colour is the axis a
 * colour-blind reader is least likely to get, and it is also the axis that
 * collides with whatever theme bb is wearing. `wip` is spelled out because
 * "wip" is jargon a human reading someone else's board should not have to
 * decode, while the agent-facing vocabulary (`todo` / `wip` / `done`, in
 * encoding.ts) stays exactly as it is — this is a label, not a second
 * vocabulary.
 */
export const STATE_LABELS: Readonly<Record<NodeState, string>> = {
  todo: "todo",
  wip: "in progress",
  done: "done",
};

/** The ink each state's chip is drawn in. Reinforces the word; never carries
 * the message on its own. */
export const STATE_INK: Readonly<Record<NodeState, string>> = {
  todo: "#6b7280",
  wip: "#b45309",
  done: "#15803d",
};

/** What "approached" is called where a human reads it. `meta.approached` means
 * "we looked at this and nothing came up" (encoding.ts), which is a fact about
 * a `todo` and NOT a fourth state — so it is a separate word on the chip
 * rather than a fourth label above. */
export const APPROACHED_LABEL = "looked";

/** How far above the node's top edge the chip's baseline sits, in screen
 * pixels. Above rather than inside: the note's own text starts at its top-left
 * corner, and a chip drawn over it would cover the title. */
export const MARK_OFFSET_PX = 6;

/** One node's mark, ready to draw: everything in VIEWPORT-RELATIVE SCREEN
 * pixels, so the component that consumes it holds no geometry. */
export interface NodeStateMark {
  readonly nodeId: string;
  /** The node's own top-left corner, on screen. */
  readonly left: number;
  readonly top: number;
  readonly label: string;
  readonly ink: string;
  /** Whether to also say `looked`. */
  readonly approached: boolean;
}

/**
 * Every tree node currently worth marking, in document order.
 *
 * A pure function of the same `snapshot` and `camera` the shapes render from,
 * so a mark tracks its node through pan, zoom, drag and remote edits without
 * subscribing to anything — `screenBoxFor`'s property, which also does the
 * page filtering and the off-screen cull.
 *
 * A SHAPE WHOSE TREE META DOES NOT PARSE GETS NO MARK, rather than a default
 * one. `readTreeNode` distinguishes `absent` from `invalid` (encoding.ts's
 * decision 1) and a chip reading `todo` over a node whose `state` is garbage
 * would state a fact the document does not hold — the same call `edge-view.ts`
 * makes for an unreadable quarantine record. `checkTreeInvariants` is what
 * reports the damage; this layer's job is not to invent a rendering for it.
 */
export function nodeStateMarks(
  doc: CanvasDocument,
  camera: Camera,
  viewportSize: ViewportSize,
  currentPageId: string,
): readonly NodeStateMark[] {
  const marks: NodeStateMark[] = [];
  for (const shape of doc.shapes) {
    const read = readTreeNode(shape);
    if (read.status !== "ok") continue;
    const box = screenBoxFor(doc, camera, viewportSize, shape.id, currentPageId);
    if (box === null) continue;
    marks.push({
      nodeId: shape.id,
      left: box.left,
      top: box.top,
      label: STATE_LABELS[read.value.state],
      ink: STATE_INK[read.value.state],
      approached: read.value.approached,
    });
  }
  return marks;
}
