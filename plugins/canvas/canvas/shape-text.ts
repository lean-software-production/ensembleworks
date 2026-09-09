// W15 — THE ONE RULE FOR "WHAT DOES THIS SHAPE SAY".
//
// A shape's text lives in TWO places, and this module is the only thing in
// the plugin allowed to decide which of them is the answer:
//
//  1. The LIVE text container — `CanvasDoc.getText(id)` / `setText(id, …)`, a
//     per-shape LoroText keyed `text:<shapeId>`. This is where a human's
//     keystrokes land: the plain-text editing mount dispatches canvas-editor's
//     `SetText` intent, which calls `doc.setText` verbatim.
//  2. `props.richText`, which canvas-model's `plainText` reads. This is what
//     an IMPORTED document, a golden fixture and every pre-W15 agent write
//     carry, and it is the only channel a caller holding a bare
//     `CanvasDocument` (no doc handle) can see at all.
//
// THE RULE: live text wins whenever it is non-empty; otherwise `richText`.
//
// It is not an arbitrary tie-break — it is the order canvas-react's `labelOf`
// already resolves a label in, which is to say it is WHAT THE HUMAN SEES ON
// SCREEN. Any reader that picked the other order would answer a question
// about a canvas the human is not looking at, which is exactly the W14 F1
// defect: the tree read spine took titles from `richText` alone and reported
// `(untitled)` for text a human had plainly typed.
//
// ONE RULE, ONE PLACE. `canvas/agents-view.ts`'s `promptTextFor` had this
// resolution open-coded (with its own re-implemented richText flattener); it
// now delegates here. Two functions that each decide which channel wins is the
// same defect one level up — the run-note prompt and the tree title would
// disagree about one note the first time either was touched.
//
// EXTRACTION IS NOT REIMPLEMENTED: `plainText` is canvas-model's own and is
// called, never copied. This module adds the CHOICE and nothing else.
import { plainText, type Shape } from "@ensembleworks/canvas-model";

/** Read a shape's live text container. `CanvasDoc.getText`'s own signature,
 * narrowed to what a reader needs — so a pure module can take the live
 * channel as an injection rather than a `CanvasDoc`. */
export type LiveText = (id: string) => string;

/**
 * The live channel of a caller that HAS NO doc handle.
 *
 * Named rather than written as an inline `() => ""` at each default, because
 * an empty live channel is a real, honest state (a fixture document, a
 * `CanvasDocument` arriving over rpc) and a reader should see that it was
 * chosen. Every such caller degrades to `richText`, which is the only channel
 * a document value carries.
 */
export const NO_LIVE_TEXT: LiveText = () => "";

/**
 * What this shape says: live text if there is any, else its `richText`.
 *
 * NOT TRIMMED — the caller trims if it wants to. `shapeText` answers what the
 * text IS; whether trailing whitespace matters is the caller's question, and a
 * silent trim here would make a title read back different from the one that
 * was written.
 */
export function shapeText(shape: Shape | undefined, live: string): string {
  // `length`, NOT `trim().length` — deliberately `labelOf`'s exact test. A
  // note a human has blanked down to spaces RENDERS as blank, so a reader that
  // treated whitespace as "nothing here" would resurrect the imported title
  // and describe a note nobody can see. Blank on screen, blank in the answer;
  // callers that care turn that into their own word for empty ("(untitled)",
  // "this note is empty").
  if (live.length > 0) return live;
  return shape === undefined ? "" : plainText(shape);
}
