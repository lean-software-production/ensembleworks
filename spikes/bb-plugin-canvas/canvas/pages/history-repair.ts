// WHAT AN UNDO OR A REDO LEAVES BEHIND, AND HOW TO PUT IT BACK.
//
// Task C1b of docs/plans/2026-09-05-bb-canvas-multi-page-design.md (risk R-1),
// mirroring client/src/canvas-v2/CanvasV2App.tsx:806-820, which discovered and
// solved this upstream.
//
// TWO VIEW INTENTS HAVE NO UNDO INVERSE, and both of them name things the doc
// can stop having:
//
//   * `SetSelection` names shape ids. Undoing the batch that created those
//     shapes leaves the selection pointing at ids that no longer resolve.
//     canvas/tool-loop.ts's `pruneDanglingSelectionIntents` has handled this
//     since before pages existed.
//   * `SetCurrentPage` names a page id (canvas-editor/src/editor.ts:927 — a
//     VIEW intent: no doc write, no undo entry). Undoing the switcher's
//     "+ new page" batch removes the page while `currentPageId` still names
//     it, and canvas-react's ShapeLayer/EmbedLayer paint only shapes whose
//     page IS `currentPageId` — so the canvas goes BLANK while the document
//     is perfectly intact. That is the worst failure this feature can have,
//     which is why the repair is here rather than in the panel.
//
// ONE FUNCTION FOR BOTH, deliberately. They are two independent repairs of the
// same root cause, run at the same two moments, and the panel calling one and
// forgetting the other is the mistake this file exists to make impossible.
// tests/page-history-repair.test.ts pins both directions of both.
//
// COMPUTED TOGETHER, APPLIED TOGETHER, which is safe because neither repair
// can change the other's input: the selection prune reads shapes and emits
// `SetSelection`, the page clamp reads pages and emits `SetCurrentPage`, and
// neither intent writes to the doc at all.
//
// Returns an Intent[] rather than applying anything, exactly as
// canvas/pages/page-intents.ts does and for the same reason: this project has
// no jsdom, so a decision made inside CanvasPanel.tsx is a decision no test
// can reach.
import type { Editor, Intent } from "@ensembleworks/canvas-editor";
import { pruneDanglingSelectionIntents } from "../tool-loop.js";
import { clampCurrentPageIntents } from "./page-intents.js";

/**
 * Every repair the editor's state needs after an `undo()` or a `redo()`.
 *
 * EMPTY IS THE COMMON CASE and it matters: the caller runs this after EVERY
 * undo and redo keystroke, and both `SetSelection` and `SetCurrentPage` notify
 * every subscriber even when the value is unchanged. So each half returns []
 * when nothing dangled, and the panel applies the result only when it is
 * non-empty — the same shape the panel's existing prune call already had.
 *
 * BOTH DIRECTIONS NEED IT, which is the half that is easy to miss. Undo
 * strands the page by removing a just-created one. Redo strands it by
 * re-applying a `DeletePage` — reachable whenever the user switched pages
 * between the undo and the redo, because a `SetCurrentPage` is a view intent
 * and so does not clear the redo stack.
 */
export function historyRepairIntents(editor: Editor): Intent[] {
  return [...pruneDanglingSelectionIntents(editor), ...clampCurrentPageIntents(editor)];
}

/**
 * `editor.undo()` and `editor.redo()`, each with its repair attached.
 *
 * WHY THE MOVE AND THE REPAIR ARE ONE CALL. Until 2026-09-05 the panel spelled
 * the composition out itself — `editor.undo()`, then compute, then apply-if-
 * non-empty — twice, once per branch. That is three lines of sequencing in a
 * .tsx this project has no jsdom to render, and mutation showed exactly what
 * that costs: deleting the two repair lines from the redo branch, and
 * separately from the undo branch, each left `npx tsc --noEmit` at exit 0 and
 * the whole spike suite at 39 files / 843 tests passed. The behavioural test
 * that looked like it covered this was driving its own hand-written copy of
 * those three lines, not the panel's.
 *
 * So the sequence lives here, where tests/page-history-repair.test.ts calls
 * the same function the panel calls. What is left in the panel is a name, and
 * a source guard can state the remaining property honestly: the panel contains
 * no bare `editor.undo()`/`editor.redo()` at all, so no keystroke can move
 * history without the repair travelling with it.
 *
 * APPLIED ONLY WHEN NON-EMPTY, unchanged from what the panel did: both
 * `SetSelection` and `SetCurrentPage` notify every subscriber even when the
 * value has not changed, and this runs on every undo/redo keystroke.
 */
function applyHistoryRepair(editor: Editor): void {
  const repair = historyRepairIntents(editor);
  if (repair.length > 0) editor.applyAll(repair);
}

/** Undo, then put back what the undo stranded. See `applyHistoryRepair`. */
export function undoWithRepair(editor: Editor): void {
  editor.undo();
  applyHistoryRepair(editor);
}

/**
 * Redo, then put back what the redo stranded. See `applyHistoryRepair`.
 *
 * A SEPARATE FUNCTION rather than a `direction` parameter: the panel's two
 * branches are two call sites, and a boolean would make wiring the wrong
 * direction into a branch a thing that typechecks. With two names, the guard
 * on each branch is a different string.
 */
export function redoWithRepair(editor: Editor): void {
  editor.redo();
  applyHistoryRepair(editor);
}
