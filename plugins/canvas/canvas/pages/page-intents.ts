// THE PAGE-SWITCHER'S DECISIONS, WITH NO DOM ANYWHERE NEAR THEM.
//
// A port of client/src/canvas-v2/page-switcher-dom.ts (Task U1 of
// docs/plans/2026-07-22-canvas-v2-pages.md, D-6) into this spike, per Task 1
// of docs/plans/2026-09-05-bb-canvas-multi-page-design.md. Behaviour is
// deliberately unchanged from upstream — this is a port, not a redesign; the
// only divergences are the file's location, its formatting, and these
// comments. The engine half of multi-page (CreatePage/DeletePage/
// ReorderPage/SetCurrentPage intents, the page-scoped render filter) already
// landed upstream on 2026-07-22; the spike was only ever missing this and the
// UI that calls it.
//
// The shape upstream chose, and the reason it survives the port intact: each
// function READS the editor and RETURNS an Intent[]. It never calls
// applyAll itself — the caller does. That keeps every decision in this file
// reachable from a plain unit test, which matters more here than upstream:
// this project has no jsdom and may not gain one, so a branch written inline
// in CanvasPanel.tsx would be a branch no test could ever reach.
//
// RenamePage has no helper here, matching upstream: its math is a bare
// pass-through (`{ type: "RenamePage", id, name }`, no editor read needed),
// so a helper would only add indirection.
import {
  canonicalPageId,
  generateKeyBetween,
  orderedPages,
  type Page,
  type PageId,
} from "@ensembleworks/canvas-model";
import type { Editor, Intent } from "@ensembleworks/canvas-editor";

/** Mint a page id from the editor's INJECTED randomness rather than from
 * `crypto` directly, so the mint is deterministic under a fixed `random` in
 * tests — the same convention canvas-editor's own intent-builders use
 * (clipboard-intents.ts's mintShapeId/mintBindingId). */
function mintPageId(editor: Editor): PageId {
  return `page:${Math.floor(editor.random() * 1e9).toString(36)}`;
}

/** "+ new page": mint a page whose fractional `index` sorts AFTER every
 * existing page (`generateKeyBetween(maxIndex, null)` — the append-at-the-end
 * idiom shared with reorder-intents.ts's `toFront`), then batch CreatePage +
 * SetCurrentPage into ONE array so the caller's single applyAll makes
 * create-and-switch one commit (and, since SetCurrentPage contributes no
 * undo inverse, one undo entry). */
export function newPageIntents(editor: Editor): Intent[] {
  const ordered = orderedPages(editor.doc.listPages());
  const maxIndex = ordered.length > 0 ? (ordered[ordered.length - 1]!.index ?? null) : null;
  const page: Page = {
    id: mintPageId(editor),
    name: `Page ${ordered.length + 1}`,
    index: generateKeyBetween(maxIndex, null),
  };
  return [
    { type: "CreatePage", page },
    { type: "SetCurrentPage", pageId: page.id },
  ];
}

/** Delete a page.
 *
 * Refuses the doc's ONLY page here rather than relying on DeletePage to
 * refuse it downstream: refusing at this level means the caller never emits a
 * doomed intent, and it is the level a unit test can pin.
 *
 * An unknown id is a tolerant no-op, never a throw (canvas-editor's applyAll
 * tolerance contract).
 *
 * When the deleted page IS the current page, batches a follow-up
 * SetCurrentPage onto an adjacent page — the NEXT page in orderedPages,
 * falling back to the PREVIOUS one when deleting the last page — so
 * currentPageId never dangles even before clampCurrentPageIntents would
 * catch it. */
export function deletePageIntents(editor: Editor, id: string): Intent[] {
  const pages = editor.doc.listPages();
  if (pages.length <= 1) return [];
  const ordered = orderedPages(pages);
  const i = ordered.findIndex((p) => p.id === id);
  if (i === -1) return [];

  const intents: Intent[] = [{ type: "DeletePage", id }];
  if (editor.get().currentPageId === id) {
    const adjacent = ordered[i + 1] ?? ordered[i - 1];
    if (adjacent) intents.push({ type: "SetCurrentPage", pageId: adjacent.id });
  }
  return intents;
}

export type MoveDir = "left" | "right";

/** Reorder one slot: recompute `id`'s fractional index so it sits between its
 * NEW neighbours. Moving left inserts between the page two-before and the
 * page immediately-before (the one `id` is swapping past); moving right is
 * the mirror. A no-op at either end of orderedPages, and on an unknown id —
 * never throws. */
export function movePageIntents(editor: Editor, id: string, dir: MoveDir): Intent[] {
  const ordered = orderedPages(editor.doc.listPages());
  const i = ordered.findIndex((p) => p.id === id);
  if (i === -1) return [];

  if (dir === "left") {
    if (i === 0) return [];
    const prev = ordered[i - 1]!;
    const prevPrev = ordered[i - 2];
    const index = generateKeyBetween(prevPrev?.index ?? null, prev.index ?? null);
    return [{ type: "ReorderPage", id, index }];
  }

  if (i === ordered.length - 1) return [];
  const next = ordered[i + 1]!;
  const nextNext = ordered[i + 2];
  const index = generateKeyBetween(next.index ?? null, nextNext?.index ?? null);
  return [{ type: "ReorderPage", id, index }];
}

/**
 * Reorder to an ARBITRARY position — the tab strip's click-and-hold drag
 * (canvas/pages/tab-drag.ts), 2026-09-05.
 *
 * WHY movePageIntents COULD NOT BE REUSED. It moves exactly ONE slot, which is
 * the right shape for the popover's ◂ / ▸ buttons and the wrong one for a
 * gesture that can cross the whole strip in a single drag: expressing that as a
 * loop of one-slot moves would emit N ReorderPage writes, N sync frames and N
 * undo entries for one thing the user did. This emits exactly one.
 *
 * `target` IS AN INDEX INTO THE LIST AS IT WILL BE — i.e. into the ordering with
 * the dragged page ALREADY REMOVED, which is what `dropIndexAt` returns. Taking
 * the new neighbours from the original list instead is an off-by-one that puts
 * the page back where it started for every rightward drop; tests/
 * page-intents.test.ts's four-page case is there specifically to catch it.
 *
 * ACCEPTS `null`, because that is what `dropIndexAt` returns for a drop onto
 * self, an unmeasured pointer and a single-tab strip alike. Taking it here means
 * the panel never writes that `if` itself — this project has no jsdom, so an
 * `if` in the component is an unreachable branch.
 *
 * A DOC WRITE AND NOTHING ELSE. No SetCurrentPage: which page you are LOOKING at
 * does not change when you drag a tab past another one, and a view intent
 * smuggled in here would put a page switch on the undo stack — the exact mess
 * canvas/pages/history-repair.ts exists to clean up after.
 *
 * REFUSES RATHER THAN THROWING when the drop site's two neighbours share an
 * index: `generateKeyBetween` throws on `a >= b` (canvas-model/src/
 * fractional-index.ts:164), and two pages CAN share one — `orderedPages` breaks
 * the tie on id, so a tie is a legal document rather than a corrupt one.
 * Refusing loses a drag; throwing takes the whole panel down mid-gesture.
 * (`movePageIntents` above has the same hazard and does not guard it — observed
 * by reading that code, not fixed here.)
 */
export function dropPageIntents(editor: Editor, id: string, target: number | null): Intent[] {
  if (target === null || !Number.isInteger(target)) return [];
  const ordered = orderedPages(editor.doc.listPages());
  const from = ordered.findIndex((p) => p.id === id);
  if (from === -1) return [];
  if (target === from) return [];

  const rest = ordered.filter((p) => p.id !== id);
  if (target < 0 || target > rest.length) return [];

  const before = rest[target - 1]?.index ?? null;
  const after = rest[target]?.index ?? null;
  if (before !== null && after !== null && before >= after) return [];

  return [{ type: "ReorderPage", id, index: generateKeyBetween(before, after) }];
}

/** The undo/redo safety net (design doc R-1).
 *
 * SetCurrentPage is a VIEW intent with no undo inverse
 * (canvas-editor/src/editor.ts:927), so undoing a CreatePage+SetCurrentPage
 * batch removes the page while currentPageId still names it — and the render
 * filter (canvas-react ShapeLayer/EmbedLayer) then paints NOTHING. Redo can
 * strand it the same way by reintroducing a DeletePage.
 *
 * Reads currentPageId LIVE and emits a SetCurrentPage onto the canonical page
 * (canonicalPageId — the lexicographically smallest live page id, canvas-
 * model repair.ts's convergent choice, reused rather than inventing a second
 * "pick a fallback page" rule) ONLY when currentPageId names no live page.
 * Returns [] otherwise: the caller runs this after EVERY undo and redo, so a
 * same-value SetCurrentPage on every keystroke would be pure churn. */
export function clampCurrentPageIntents(editor: Editor): Intent[] {
  const pages = editor.doc.listPages();
  const current = editor.get().currentPageId;
  if (pages.some((p) => p.id === current)) return [];
  const canonical = canonicalPageId(pages);
  if (canonical === undefined) return [];
  return [{ type: "SetCurrentPage", pageId: canonical }];
}
