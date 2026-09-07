// EVERYTHING THE PAGE SWITCHER DECIDES. No DOM, no React, no editor writes.
//
// Task C1a of docs/plans/2026-09-05-bb-canvas-multi-page-design.md (D-2). The
// switcher has three surfaces — the quick-palette row, the button-and-popover
// in the canvas panel, and the wide-viewport-only tab bar — and they all draw
// the SAME list with the SAME affordances. That is what this module is: one
// row model, so the popover and the tab bar cannot drift into disagreeing
// about whether a page can be deleted, plus the popover's filter and its
// open/closed state machine.
//
// WHY NONE OF IT LIVES IN THE .tsx. This project has no jsdom and may not gain
// one, so a rule written inline in a component is a rule no test can ever
// reach — the same split canvas/dock/expand.ts and canvas/dock/squeeze.ts
// make, stated in those files' headers, and the reason canvas/pages/
// page-intents.ts returns intents instead of applying them.
import { orderedPages, type Page } from "@ensembleworks/canvas-model";

/** One page, as every surface draws it. */
export interface PageMenuRow {
  readonly id: string;
  readonly name: string;
  /** Is this the page being rendered right now? */
  readonly current: boolean;
  /** Is there a page to its left to swap past? */
  readonly canMoveLeft: boolean;
  readonly canMoveRight: boolean;
  /** False for the doc's only page — the same refusal `deletePageIntents`
   * makes, hoisted to the affordance so the control is disabled rather than
   * dead. tests/page-menu.test.ts checks the two agree against a real editor,
   * because an enabled button that produces no intents is the failure this
   * duplication could otherwise introduce. */
  readonly canDelete: boolean;
}

/**
 * The list, in the order the user sees it.
 *
 * ORDERED BY FRACTIONAL INDEX, not by whatever `doc.listPages()` hands back:
 * that order is a CRDT detail and it is not stable across peers, whereas
 * `orderedPages` is `(index, id)` and is the ordering `movePageIntents`
 * computes against. Two different orders here would make "move right" move a
 * tab somewhere else.
 *
 * `currentPageId` NAMING NO PAGE IS A REAL STATE, not a bug to throw on: it is
 * what the doc looks like for one render between a page-removing undo and the
 * clamp in canvas/pages/history-repair.ts, and a switcher that threw there
 * would take the whole panel down with it. No row is marked current; the
 * switcher just draws no highlight.
 */
export function pageMenuRows(pages: readonly Page[], currentPageId: string): PageMenuRow[] {
  const ordered = orderedPages(pages);
  const deletable = ordered.length > 1;
  return ordered.map((page, i) => ({
    id: page.id,
    name: page.name,
    current: page.id === currentPageId,
    canMoveLeft: i > 0,
    canMoveRight: i < ordered.length - 1,
    canDelete: deletable,
  }));
}

/**
 * What clicking a row is worth.
 *
 * A SWITCH TO THE PAGE YOU ARE ALREADY ON IS NOTHING, and that refusal used to
 * be an `if` in PageSwitcher.tsx's click handler where no test could reach it —
 * this project has no jsdom, so deleting or inverting that condition broke
 * nothing. It is a decision, so it is here.
 *
 * It is not free to get wrong in either direction. A same-value SetCurrentPage
 * still notifies every editor subscriber, so every surface re-renders to draw
 * exactly what it was already drawing — on the tab bar, where the current page
 * is the easiest target to click, that is a re-render per idle click. And the
 * intent list is deliberately ONLY ever SetCurrentPage: switching is a VIEW
 * change (canvas-editor/src/editor.ts:927 — no doc write, no undo entry), so
 * anything else smuggled in here would put a page change on the undo stack,
 * which is the exact mess canvas/pages/history-repair.ts exists to clean up
 * after.
 */
export function switchPageIntents(
  row: PageMenuRow,
): Array<{ readonly type: "SetCurrentPage"; readonly pageId: string }> {
  if (row.current) return [];
  return [{ type: "SetCurrentPage", pageId: row.id }];
}

// `pageMenuButtonLabel` USED TO LIVE HERE and was deleted on 2026-09-06, with
// the toolbar's "Pages: <name>" button it existed for (owner request: "Lets
// remove the page selector from the control bar"). It is recorded rather than
// silently dropped because its fallback — naming the page COUNT when
// `currentPageId` names no page — was a real answer to a real state, and a
// future surface that wants to name the current page should re-derive it from
// `pageMenuRows` rather than assume the fallback was an oversight. Nothing
// renders it today, and an export nothing renders is a rule that can rot
// unnoticed while its own unit tests stay green.
//
// WHAT THE REMOVAL COSTS, stated so it is a choice: on a column too narrow for
// the tab strip (canvas/pages/page-tabs-fit.ts) the canvas chrome no longer
// names the current page anywhere. The page name is still published to the
// document title and the roster by canvas/pages/page-title.ts, so it is not
// gone from the app — only from the canvas's own chrome.

/**
 * Narrow the list to what the user typed.
 *
 * NAME ONLY, NEVER THE ID. Every page id starts with `page:`, so matching ids
 * would make the query "page" — a word anybody typing a page name will type —
 * match everything, and would surface a mint detail (`page:k3f9…`) the user
 * never chose. The design doc's D-3 already flags that id as the ugly part of
 * the URL; it has no business being a search key too.
 *
 * Case-insensitive substring, and ORDER-PRESERVING: no relevance ranking, so
 * the filtered list is still the page order the tab bar and the popover draw,
 * and the row under the cursor does not jump between keystrokes. An empty or
 * whitespace-only query is "no filter", which is what makes the filter input
 * safe to focus on open.
 */
export function filterPageRows(
  rows: readonly PageMenuRow[],
  query: string,
): PageMenuRow[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...rows];
  return rows.filter((row) => row.name.toLowerCase().includes(needle));
}

/**
 * What Enter in the filter box goes to: the top match, or nothing.
 *
 * A one-line rule that is here rather than inline because it is the difference
 * between "Enter is the fast path" and "Enter does something surprising when
 * the filter matched nothing".
 */
export function pageMenuEnterTarget(rows: readonly PageMenuRow[]): PageMenuRow | null {
  return rows[0] ?? null;
}

/**
 * What a rename prompt's answer means.
 *
 * WHY THIS LIVES HERE AND NOT IN page-intents.ts. That module deliberately has
 * no RenamePage helper, and its header says why: the intent's math is a bare
 * `{ id, name }` pass-through with no editor read, so a helper would be pure
 * indirection. What needed a home is not the math, it is the VALIDATION of an
 * answer typed into a `window.prompt` — three refusals, each of which is a
 * decision, and all three unreachable by any test if written inline in the
 * switcher's click handler.
 *
 * `null` (Cancel) and `""` (an emptied box) are deliberately NOT told apart:
 * neither is a request to rename, and a page with an empty name is
 * unclickable in every surface that draws it. An unchanged name is refused
 * too — a same-value RenamePage is a doc write, a sync frame to every peer,
 * and an undo entry that undoes nothing anybody can see.
 */
export function renamePageIntents(
  row: PageMenuRow,
  typed: string | null,
): Array<{ readonly type: "RenamePage"; readonly id: string; readonly name: string }> {
  if (typed === null) return [];
  const name = typed.trim();
  if (name.length === 0 || name === row.name) return [];
  return [{ type: "RenamePage", id: row.id, name }];
}

/** What the user just did to a page, for the fold decision below. */
export type PageMenuAction = "switch" | "create" | "rename" | "delete" | "move";

export type PageMenuEvent =
  /** The Pages button was clicked — the toggle. */
  | { readonly type: "button-click" }
  /** The quick-palette command asked for the list. */
  | { readonly type: "palette" }
  /** Escape, anywhere in the window. */
  | { readonly type: "escape" }
  /** A pointerdown landed somewhere. `insideWidget` covers BOTH the button and
   * the popover — see the note on the "pointerdown" case below. */
  | { readonly type: "pointerdown"; readonly insideWidget: boolean }
  | { readonly type: "acted"; readonly action: PageMenuAction };

/**
 * One transition of the popover's open/closed state. Returns the SAME boolean
 * when nothing moved, so a render can be skipped — Escape and pointerdowns
 * arrive constantly for reasons that have nothing to do with this menu.
 *
 * Modelled on canvas/dock/expand.ts's `nextExpanded`, which is the same shape
 * of decision for the presence popover, and which exists for the same reason:
 * written as branches in the DOM file, "only these events dismiss" was
 * untestable.
 */
export function nextPageMenuOpen(open: boolean, event: PageMenuEvent): boolean {
  switch (event.type) {
    case "button-click":
      return !open;
    case "palette":
      // A REQUEST, NEVER A TOGGLE. Somebody who typed "Canvas: go to page" and
      // got the menu closed would conclude the command was broken; there is no
      // reading of that command under which "close it" is the answer.
      return true;
    case "escape":
      return false;
    case "pointerdown":
      // THE LESSON canvas/dock/dock.ts's `insideWidget` RECORDS, carried over
      // rather than re-learned: the popover is not a descendant of the button,
      // so a containment check that knows only about the button reads every
      // press on a control INSIDE the popover as "outside" and dismisses on
      // the way down — before the click that operates the control arrives.
      // `insideWidget` is the caller's answer for BOTH roots, which is why it
      // is a boolean here and not a Node.
      return event.insideWidget ? open : false;
    case "acted":
      // SWITCHING CLOSES, MANAGING DOES NOT. A switch (and "+ new page", which
      // batches a SetCurrentPage onto the page it mints, so it IS a switch)
      // moves the view to the thing you asked to look at; leaving a popover
      // hanging over it is the one outcome nobody wants — the same call
      // expand.ts makes for "pan" and "jump". Rename, delete and reorder are
      // page MANAGEMENT: they are done several at a time, each one re-renders
      // the list being worked in, and closing would make the second one cost a
      // re-open.
      return event.action === "switch" || event.action === "create" ? false : open;
  }
}
