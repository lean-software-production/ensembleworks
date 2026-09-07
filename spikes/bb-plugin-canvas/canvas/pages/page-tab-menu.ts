// THE TAB'S OWN CONTEXT MENU — which items it offers, whether each is live,
// what opens and closes it, which key raises it, and where focus goes when it
// shuts. No DOM, no React, no editor writes.
//
// Owner request, 2026-09-06: "Lets remove the page selector from the control
// bar. […] Lets add a context menu to the tabs themselves to contain the
// rename & delete options."
//
// WHY A MODULE AND NOT HANDLERS IN THE .tsx — the same reason canvas/pages/
// page-menu.ts, canvas/pages/tab-drag.ts and canvas/pages/chrome-dock.ts give
// in their own headers: this project has no jsdom and may not gain one, so a
// menu-item rule, a dismissal rule or a key comparison written inline in a
// component is a decision NO TEST CAN EVER READ, and a mutation can move it in
// either direction with the whole suite green. tests/page-tab-menu.test.ts
// holds every rule below.
//
// WHAT THIS MODULE IS NOT. It does not delete anything and it does not rename
// anything. `pageTabMenuItems` reports whether DELETE is offered as a live
// control; whether the delete then ASKS is canvas/pages/page-delete-confirm.ts,
// and what it costs the document is canvas/pages/page-intents.ts's
// `deletePageIntents`. Those two already agree with each other and are already
// tested together; duplicating either here would give the spike a second place
// to change when it moves. What this reads is `PageMenuRow.canDelete`, which is
// `pageMenuRows`' own hoist of that same refusal — one source, three surfaces.
//
// IT IS THE FIFTH GESTURE ON ONE TAB, and the seam with the other four is
// tab-drag.ts's, not this module's: `tabDragBlocksContextMenu` says whether a
// reorder is in flight, and the component asks it before it ever gets here. The
// long-press collision is resolved there too (that module arms on MOVEMENT and
// has no timer, so a stationary long press stays merely `pressed` and the
// platform's context-menu gesture is uncontested). Nothing below re-litigates
// either.
//
// NOTHING HERE WAS SEEN IN A BROWSER. There is none in this spike. Every claim
// about what the user observes is an inference from this source plus the
// documented semantics of pointer, keyboard and focus events, and is marked as
// such where it is made.
import type { PageMenuRow } from "./page-menu.js";

/** The two things a tab's menu can do. A union rather than a string so the
 * component's interpreter is exhaustive at the type level — a third item added
 * here fails to compile until it is handled. */
export type PageTabMenuItemId = "rename" | "delete";

export interface PageTabMenuItem {
  readonly id: PageTabMenuItemId;
  readonly label: string;
  /** False draws the item DISABLED, not absent — see `pageTabMenuItems`. */
  readonly enabled: boolean;
}

/**
 * The menu for one tab.
 *
 * ORDER IS PART OF THE DECISION. Rename first, delete last: the destructive
 * item is the one furthest from where the pointer lands and from where focus
 * opens (`pageTabMenuFocusItem`), which is the ordinary arrangement for a
 * context menu and the only one that does not put "delete this page" under an
 * accidental Enter.
 *
 * DISABLED, NEVER ABSENT. `canDelete` is false for the document's only page —
 * the refusal `deletePageIntents` makes, hoisted into the row model by
 * `pageMenuRows`. Dropping the item instead would make the menu change LENGTH
 * with the document, moving the remaining item under the pointer, and would
 * tell a screen reader nothing at all about why the action went away. It is the
 * same call the Pages popover's micro-buttons already make.
 *
 * RENAME IS NEVER GATED. Renaming the only page is a perfectly good thing to
 * do, and a rule that disabled both items together would pass a "delete is
 * disabled" assertion on its own while silently taking rename away from every
 * single-page document.
 *
 * NOTHING ELSE ON THE ROW MAY MOVE AN ITEM. `current` and the two move flags
 * are deliberately unread: a tab's own menu that disagreed with the popover's
 * row for the same page would be two answers to one question.
 */
export function pageTabMenuItems(row: PageMenuRow): readonly PageTabMenuItem[] {
  return [
    { id: "rename", label: "Rename", enabled: true },
    { id: "delete", label: "Delete", enabled: row.canDelete },
  ];
}

/**
 * What the menu tells a reader it is about.
 *
 * IT NAMES THE PAGE. On a strip of eight tabs, which tab a menu belongs to is
 * obvious from where it is drawn and completely unavailable to somebody who
 * cannot see it — so the one fact the pointer carries implicitly is the one
 * this label has to carry explicitly. The plain `"` quotes match
 * page-delete-confirm.ts's wording rather than being "improved" here, so the
 * two strings a user meets one after the other read as one voice.
 */
export function pageTabMenuLabel(row: PageMenuRow): string {
  return `Page "${row.name}"`;
}

/**
 * Which item focus lands on when the menu opens, or null if none can be used.
 *
 * THE FIRST ITEM THAT IS ACTUALLY LIVE. Parking focus on a disabled control is
 * how a keyboard user meets a menu that appears to do nothing: the first press
 * of Enter is swallowed, and nothing says why. Null is the honest answer for a
 * menu with no usable item — the caller then leaves focus where it was rather
 * than moving it somewhere useless. (That state is not reachable from
 * `pageTabMenuItems` today, since rename is always enabled; the function is
 * total rather than relying on that staying true.)
 */
export function pageTabMenuFocusItem(
  items: readonly PageTabMenuItem[],
): PageTabMenuItemId | null {
  return items.find((item) => item.enabled)?.id ?? null;
}

/**
 * The menu's whole state: the id of the tab it is open on, or null for closed.
 *
 * AN ID RATHER THAN A BOOLEAN, because "open" and "open on WHICH tab" are the
 * same fact here — a second field would let the two drift, and a menu that
 * believed it was open on a tab that had been closed is exactly the drift that
 * costs a crash.
 */
export type PageTabMenuState = string | null;

export const CLOSED_PAGE_TAB_MENU: PageTabMenuState = null;

export type PageTabMenuEvent =
  /** A right-click, a long press, or the keyboard context-menu affordance
   * landed on the tab with this id. */
  | { readonly type: "open"; readonly id: string }
  /** Escape, anywhere in the window. */
  | { readonly type: "escape" }
  /** A pointerdown landed somewhere. `insideMenu` is the caller's containment
   * answer — see the note on the "pointerdown" case below. */
  | { readonly type: "pointerdown"; readonly insideMenu: boolean }
  /** One of the menu's items was run. */
  | { readonly type: "acted" };

/**
 * One transition. Returns the SAME value when nothing moved, so a render can be
 * skipped — Escape and pointerdowns arrive constantly for reasons that have
 * nothing to do with this menu.
 *
 * The shape `nextPageMenuOpen` and `nextTabDrag` already use in this plugin.
 */
export function nextPageTabMenu(
  state: PageTabMenuState,
  event: PageTabMenuEvent,
): PageTabMenuState {
  switch (event.type) {
    case "open":
      // A REQUEST, NEVER A TOGGLE — the opposite call from the Pages BUTTON's
      // `button-click`, and for the opposite reason. That button is one control
      // with one menu, so pressing it again means "put it away". This arrives
      // from a right-click on a particular TAB: right-clicking tab B while A's
      // menu is open is a request for B's menu, and a toggle would answer it by
      // leaving nothing open. Re-opening the same tab keeps it open for the
      // same reason — the pointerdown before a second right-click has already
      // dismissed it (it is outside the menu), so an `open` arriving here means
      // the user asked, and a toggle would make the menu flicker shut.
      return event.id;
    case "escape":
      return CLOSED_PAGE_TAB_MENU;
    case "pointerdown":
      // THE LESSON canvas/dock/dock.ts's `insideWidget` RECORDS, carried over
      // rather than re-learned: the menu is portalled to <body>, so a
      // containment check that knew only about the tab would read every press
      // on the menu's own buttons as "outside" and dismiss on the way DOWN,
      // before the click that operates the item ever arrived. `insideMenu` is
      // the caller's answer, which is why it is a boolean here and not a Node.
      return event.insideMenu ? state : CLOSED_PAGE_TAB_MENU;
    case "acted":
      // CLOSES — the OPPOSITE call from `nextPageMenuOpen`'s, deliberately.
      // The Pages popover stays open through rename and delete because it is a
      // management LIST, worked several rows at a time, and closing would make
      // the second edit cost a re-open. This is a context menu on ONE tab: both
      // its items are one-shot, and after a delete the tab it hangs off does
      // not exist any more.
      return CLOSED_PAGE_TAB_MENU;
  }
}

/**
 * The row an open menu is about, or null.
 *
 * A MENU OPEN ON A PAGE THAT NO LONGER EXISTS IS A REAL STATE, not a bug to
 * throw on: a peer can delete that page while the menu is open, and the same
 * one-render window exists between a page-removing undo and the clamp in
 * canvas/pages/history-repair.ts. Answering null lets the component draw
 * nothing instead of taking the whole panel down — the same judgement
 * `pageMenuRows` makes for a `currentPageId` that names no page.
 */
export function pageTabMenuTarget(
  rows: readonly PageMenuRow[],
  state: PageTabMenuState,
): PageMenuRow | null {
  if (state === null) return null;
  return rows.find((row) => row.id === state) ?? null;
}

/**
 * Which tab, if any, should get focus back now that the menu has closed.
 *
 * ONLY WHEN THE MENU ACTUALLY CLOSED, and only for the two dismissals the user
 * performed FROM the menu:
 *
 *   * `escape` — the deliberate "put this away"; focus belongs back on the tab
 *     the menu hung off, which is where the gesture started.
 *   * `acted` — rename and delete both go through a `window.prompt` /
 *     `window.confirm`, which hands focus back to the document rather than to
 *     anything of ours, so without this the keyboard user is dumped at the top
 *     of the page. INFERRED FROM THE MODAL-DIALOG SEMANTICS, NOT OBSERVED.
 *
 * AN OUTSIDE CLICK DELIBERATELY DOES NOT RESTORE. It has already put focus
 * somewhere the user chose, and yanking it back to a tab they were leaving is
 * the one dismissal that cannot restore focus honestly. That is the same call
 * the Pages popover's own Escape handler already makes, and it is stated here
 * rather than left as a coincidence between two files.
 *
 * RETURNS THE ID RATHER THAN DOING THE FOCUSING, because focusing is hands and
 * this is the rule. The component looks the element up; a tab that has since
 * been deleted simply is not in its map, which is the same answer as "do not
 * move focus".
 */
export function pageTabMenuFocusReturn(
  before: PageTabMenuState,
  after: PageTabMenuState,
  event: PageTabMenuEvent,
): string | null {
  if (before === null || after !== null) return null;
  if (event.type !== "escape" && event.type !== "acted") return null;
  return before;
}

/**
 * The dedicated context-menu key.
 *
 * Named rather than compared inline so the comparison below is one a test can
 * invert. Its value is the `KeyboardEvent.key` the spec assigns to the
 * "menu"/"application" key on a PC keyboard.
 */
export const TAB_CONTEXT_MENU_KEY = "ContextMenu";

/**
 * The key that stands in for it where there is no such key at all — Shift+F10,
 * which is the platform convention on Windows and Linux and what a Mac keyboard
 * user's remapping tools target. Named as a pair with its modifier so neither
 * half can be dropped silently.
 */
export const TAB_CONTEXT_MENU_FALLBACK_KEY = "F10";

/**
 * Does this keystroke ask for the tab's context menu?
 *
 * THE MENU MUST NOT BE POINTER-ONLY — that is the whole reason this exists.
 * Right-click and long-press are both pointer gestures; a keyboard user who has
 * reached a tab with Tab needs the same two items, and with the Pages BUTTON
 * gone from the toolbar there is no other control on the strip to reach them
 * through.
 *
 * SHIFT IS LOAD-BEARING ON F10 AND IRRELEVANT ON ContextMenu. A bare F10 is the
 * platform's menu-BAR key and belongs to the host, so claiming it would take a
 * key from bb on every focused tab; the dedicated key means only one thing, so
 * a stray modifier held with it is not a different request. Both halves are
 * pinned in the tests, because "drop the `shiftKey` test" is exactly the
 * simplification this invites.
 *
 * A PLAIN OBJECT, NOT A KeyboardEvent, so this module stays free of the DOM —
 * the component passes the two fields the rule reads.
 */
export function decideTabContextMenuKey(input: {
  readonly key: string;
  readonly shiftKey: boolean;
}): boolean {
  if (input.key === TAB_CONTEXT_MENU_KEY) return true;
  return input.key === TAB_CONTEXT_MENU_FALLBACK_KEY && input.shiftKey;
}
