// RENAMING A PAGE IN PLACE — the inline editor's whole rule, with no DOM and
// no host dialog anywhere near it.
//
// WHY THIS EXISTS AT ALL. Rename used to be a `window.prompt` seeded with the
// page's current name (canvas/pages/switcher/actions.ts, and page-menu.ts's
// `renamePageIntents` still documents that prompt as the thing it validates
// the answer of). bb is an Electron app, and Electron does not implement
// `window.prompt` — the call shows nothing and yields no text, so
// `renamePageIntents` read it as "no rename was asked for", returned no
// intents, and every one of the three rename entry points (double-click a
// tab, the tab's context menu, the Pages popover's ✎) did nothing at all,
// silently. VERIFIED 2026-09-22: the shipped Electron framework under
// /Applications/bb.app carries the string "prompt() is not supported.";
// `window.confirm` IS supported, which is exactly why tab DELETE kept working
// and only rename looked broken.
//
// So the editor has to be ours. An `<input>` drawn in place of the tab (and
// in place of the popover row's name button) is the smallest thing that is
// also correct on touch, where there is no dialog to fall back to either.
//
// A DRAFT, NOT A LIVE WRITE — the one place this deliberately parts company
// with canvas-react's FrameNameEditor, which fires `onNameChange` on every
// keystroke. A page rename is a CRDT write, a sync frame to every peer and an
// undo entry; per-character ones would make a ten-letter name ten of each,
// and `renamePageIntents` already exists to refuse writes that change
// nothing. The draft lives here and ONE intent is built at the commit.
//
// WHAT THIS MODULE IS NOT. It does not build intents — `renamePageIntents`
// (canvas/pages/page-menu.ts) still owns every refusal about the text itself
// (cancel, emptied, unchanged), unchanged and still the only validation seam.
// This module owns only WHICH row is being edited and WHAT is in the box.

/** The open editor: the page being renamed, and the text currently typed. */
export interface TabRenameState {
  readonly id: string;
  readonly draft: string;
}

/** No row is being renamed. Named rather than written as a bare `null` at
 * each site, the same way CLOSED_PAGE_TAB_MENU is. */
export const NO_TAB_RENAME: TabRenameState | null = null;

export type TabRenameEvent =
  /** A rename was asked for — from a tab's double-click, the tab context
   * menu's Rename, or the popover's ✎. `name` seeds the box. */
  | { readonly type: "begin"; readonly id: string; readonly name: string }
  /** The box changed. Carries `id` so a change event from a row that is no
   * longer the edited one cannot write into another row's draft — see the
   * transition below. */
  | { readonly type: "type"; readonly id: string; readonly text: string }
  /** The edit is over, whichever way it ended. Committing vs. cancelling is
   * NOT a distinction this state holds: the caller either passes the draft to
   * `renamePageIntents` or does not, and either way the editor closes. */
  | { readonly type: "end" };

/**
 * One transition of the inline editor.
 *
 * RETURNS THE SAME STATE when nothing moved, so a render can be skipped —
 * same identity discipline `nextPageMenuOpen` keeps, and for the same reason:
 * these events arrive from the DOM constantly.
 *
 * A `type` FOR A ROW THAT IS NOT THE EDITED ONE IS IGNORED rather than
 * treated as an implicit `begin`. Two rows can hold a mounted input for a
 * frame — React unmounts the old one on the render that mounts the new — and
 * a blur/change racing out of the dying input must never resurrect it under
 * the new row's id. The guard is cheap; the bug it forbids is a page renamed
 * to another page's half-typed name.
 *
 * A `begin` WHILE ANOTHER ROW IS OPEN SWITCHES rather than refusing: the
 * previous draft is dropped, which is the honest reading of "the user went
 * and asked to rename a different page instead".
 */
export function nextTabRename(
  state: TabRenameState | null,
  event: TabRenameEvent,
): TabRenameState | null {
  switch (event.type) {
    case "begin":
      return { id: event.id, draft: event.name };
    case "type":
      if (state === null || state.id !== event.id) return state;
      if (state.draft === event.text) return state;
      return { id: state.id, draft: event.text };
    case "end":
      return state === null ? state : NO_TAB_RENAME;
  }
}

/**
 * The text to draw in this row's box, or `null` if this row is not the one
 * being renamed — i.e. "draw the ordinary tab/name button".
 *
 * A FUNCTION RATHER THAN AN `=== row.id` INLINE IN EACH VIEW, because there
 * are now two surfaces that draw the same row (the tab strip and the Pages
 * popover) and "which one is editing" has to be the same answer in both. An
 * empty draft is a perfectly good draft — hence `null` for absence, never
 * `""`, so a user who cleared the box is not silently kicked back to the tab.
 */
export function tabRenameDraft(state: TabRenameState | null, id: string): string | null {
  if (state === null || state.id !== id) return null;
  return state.draft;
}

/** What a keystroke in the box asks for; `null` for every key that is just
 * typing. Kept as a rule rather than two `if`s in a handler for the reason
 * every other decision in this directory gives: a comparison written inline
 * in a component is one no test can invert. */
export type TabRenameKeyAction = "commit" | "cancel" | null;

/**
 * Enter commits, Escape cancels, everything else types.
 *
 * ENTER ENDS THE EDIT rather than inserting anything, exactly as
 * canvas-react's `handleFrameNameKeyDown` decides for the frame-header input:
 * an `<input>` has no multi-line concept, so there is no other reading.
 *
 * ESCAPE CANCELS AND MUST NOT ALSO CLOSE SOMETHING ELSE. The tab strip's
 * drag machine and both popovers listen for Escape on `window`/`document`;
 * the box's own handler is what stops one Escape from cancelling the rename
 * AND dismissing the menu the rename was started from, by claiming the event
 * first (see the `stopPropagation` at the call site).
 */
export function decideTabRenameKey(key: string): TabRenameKeyAction {
  if (key === "Enter") return "commit";
  if (key === "Escape") return "cancel";
  return null;
}
