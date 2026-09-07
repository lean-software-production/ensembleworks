// THE HANDS. Every decision this file acts on was made somewhere a test can
// reach it: canvas/pages/page-menu.ts (the row model, the filter, the rename
// validation, the open/closed machine), canvas/pages/page-tabs-fit.ts (whether
// the tab bar is drawn), canvas/pages/page-intents.ts (every mutation),
// canvas/pages/page-delete-confirm.ts (whether a delete asks first, and what
// it asks), canvas/pages/tab-drag.ts (the whole click-and-hold reorder: the
// arm distance, which button starts it, what a release and a cancel mean,
// where the drop lands, what is painted, and whether a context menu may open
// over it), canvas/pages/page-tab-menu.ts (that context menu: which items a tab
// offers, whether each is enabled, what opens and closes it, which key raises
// it, where focus lands and where it goes back to), and
// canvas/dock/popover-place.ts (where both <body> boxes go). There
// is no threshold, no pixel comparison and no behavioural `if` below that is
// not a call into one of those — this project has no jsdom and may not gain
// one, so a branch written here is a branch nothing can ever check.
//
// That claim was FALSE until 2026-09-05: `remove`'s confirmation dialog was an
// inline `if (!window.confirm(...))`, the one decision in this file nothing
// could reach. tests/page-delete-confirm.test.ts now guards it from the
// outside, reading this file's CODE (comments stripped) rather than its prose.
//
// Task C1a of docs/plans/2026-09-05-bb-canvas-multi-page-design.md, D-2:
// THREE SURFACES, ONE SET OF INTENTS. As of the owner's 2026-09-06 changes:
//   1. bb's quick palette, via canvas/pages/page-door.ts — zero pixels, and now
//      the ONLY way to open the popover.
//   2. The POPOVER list, portalled to <body>. It no longer has a button: "Lets
//      remove the page selector from the control bar" (owner, 2026-09-06). It
//      stays for two reasons, and the second is the load-bearing one — it is
//      the type-a-name-to-jump fast path, and it is the only KEYBOARD path to
//      REORDERING, since reordering became a pointer drag (canvas/pages/
//      tab-drag.ts) with no keyboard equivalent. Deleting it would be a
//      straight accessibility regression, not a simplification.
//   3. The TAB STRIP ported from client/src/canvas-v2/PageSwitcher.tsx, drawn
//      only when the canvas column is wide enough to spare it — and now the
//      primary pointer surface, since each tab carries its own RENAME/DELETE
//      context menu (right-click, long press, or the keyboard context-menu
//      key; canvas/pages/page-tab-menu.ts decides all of it).
//
// WHAT LEFT WITH THE BUTTON, said plainly because it is a cost and not a
// tidy-up: on a column too narrow for the strip (canvas/pages/page-tabs-fit.ts)
// the canvas chrome names the current page NOWHERE. `pageMenuButtonLabel` was
// deleted with it — page-menu.ts records why, and where the name still appears.
//
// WHERE THE PIECES SIT. The TOOLBAR floats, bottom-centred over a full-bleed
// canvas (canvas/pages/chrome-dock.ts owns every number that took;
// CanvasPanel.tsx's `data-canvas-chrome-dock` places it), and holds the tools
// and the self-name chip — no page control at all. The TAB STRIP does not float
// at all: it is in the canvas column's vertical flow, as the column's FIRST
// child, directly ABOVE `data-canvas-viewport` (CanvasPanel.tsx's
// `data-canvas-page-tab-row`). It is joined to the CANVAS below it — see
// `tabBarStyle`'s `marginBottom` — which is what lets the tabs be tab-SHAPED
// rather than a row of pills: a tab needs a surface to be a tab OF. (Between
// 2026-09-05 and 2026-09-06 the strip floated too, sitting on the toolbar card;
// that is where several of the notes below came from, and they have been
// corrected in place rather than left to rot.)
//
// WHY A HOOK RETURNING TWO NODES rather than a component. The strip is a row at
// the top of the column and the two <body> overlays are mounted separately, so
// there are two different parents with one piece of state between them. A hook
// hands both nodes back to CanvasPanel.tsx to place, and keeps the open/close
// state, the refs and the listeners in one file instead of lifting them into
// the panel where they would be one more thing the panel has to get right.
//
// COLOURS AND FONTS ARE DECLARED HERE, NEVER INHERITED OR READ FROM bb. The
// popover is portalled to <body> (see below), so it inherits nothing from the
// panel it belongs to — the exact trap the presence popover fell into when it
// was re-parented and silently lost its font. The palette is the canvas's own
// document palette (the same literals the upstream tab bar carries), because
// this control is chrome ON the canvas rather than part of bb's shell.
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import type { Editor } from "@ensembleworks/canvas-editor";
import {
  NO_POPOVER_ANCHOR,
  POPOVER_EDGE_MARGIN_PX,
  POPOVER_Z_INDEX,
  placePopoverBox,
  type PopoverAnchor,
  type PopoverRect,
} from "../dock/popover-place.js";
import {
  CHROME_ACCENT,
  CHROME_FAINT,
  CHROME_FIELD,
  CHROME_FONT,
  CHROME_HAIRLINE,
  CHROME_INK,
  CHROME_MUTED,
  CHROME_PAPER,
  CHROME_POPOVER_SHADOW,
  CHROME_RECESS,
} from "./chrome-dock.js";
import {
  deletePageIntents,
  dropPageIntents,
  movePageIntents,
  newPageIntents,
  type MoveDir,
} from "./page-intents.js";
import {
  IDLE_TAB_DRAG,
  TAB_DROP_LINE_PAINT,
  dropIndexAt,
  nextTabDrag,
  showsDropLineAt,
  tabDragBlocksContextMenu,
  tabDragIsActive,
  tabDragPaint,
  tabDragPresentation,
  tabDragTakesMeasurement,
  type TabBox,
  type TabDragEffect,
  type TabDragEvent,
  type TabDragState,
} from "./tab-drag.js";
import {
  filterPageRows,
  nextPageMenuOpen,
  pageMenuEnterTarget,
  pageMenuRows,
  renamePageIntents,
  switchPageIntents,
  type PageMenuEvent,
  type PageMenuRow,
} from "./page-menu.js";
import {
  CLOSED_PAGE_TAB_MENU,
  decideTabContextMenuKey,
  nextPageTabMenu,
  pageTabMenuFocusItem,
  pageTabMenuFocusReturn,
  pageTabMenuItems,
  pageTabMenuLabel,
  pageTabMenuTarget,
  type PageTabMenuEvent,
  type PageTabMenuItemId,
  type PageTabMenuState,
} from "./page-tab-menu.js";
import { pageDeletePrompt } from "./page-delete-confirm.js";
import { choosePageTabsVisible, nextPageTabsVisible } from "./page-tabs-fit.js";
import { pageDoor } from "./page-door.js";

// THE PALETTE IS canvas/pages/chrome-dock.ts's, NOT THIS FILE'S. It used to be
// six literals declared here, which was correct while this widget's two nodes
// were the only things wearing them. They are not any more: the floating
// toolbar and the tab strip are drawn by two different parents now, and a tab
// whose paper is a shade off the chrome it shares a screen with does not read
// as part of one control at all. One palette, one file, imported by both.
// tests/page-switcher-tabs.test.ts refuses any colour literal below.

const buttonStyle: CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: "transparent",
  color: CHROME_INK,
  font: CHROME_FONT,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const popoverStyle: CSSProperties = {
  position: "fixed",
  // THE SHARED LAYER, not a number of this file's own. canvas/dock/
  // popover-place.ts's POPOVER_Z_INDEX carries the argument in full; the short
  // version is that it deliberately sits UNDER bb's dialogs and command
  // palette, because this popover cannot be dismissed by a bb surface opened
  // from the keyboard, and an overlay you cannot dismiss painted over the thing
  // you just opened is a trap. Portalling to <body> (see the render below) is
  // what makes this number mean anything at all: only in the root stacking
  // context is it compared against bb's own layers rather than against
  // whatever context an ancestor happened to open.
  zIndex: POPOVER_Z_INDEX,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  // Wide enough for a name and its four controls, capped against a phone.
  // `min()` rather than a media query: the popover is portalled to <body>, so
  // the only width it can honestly reason about is the window's.
  width: "min(320px, 80vw)",
  maxHeight: "min(60vh, 420px)",
  overflowY: "auto",
  padding: 6,
  borderRadius: 8,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_PAPER,
  color: CHROME_INK,
  font: CHROME_FONT,
  boxShadow: CHROME_POPOVER_SHADOW,
};

const filterStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "4px 6px",
  borderRadius: 4,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_FIELD,
  color: CHROME_INK,
  font: CHROME_FONT,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
};

function nameButtonStyle(current: boolean): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    textAlign: "left",
    padding: "4px 8px",
    borderRadius: 4,
    border: "none",
    background: current ? CHROME_ACCENT : "transparent",
    color: current ? CHROME_PAPER : CHROME_INK,
    font: CHROME_FONT,
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

function microButtonStyle(enabled: boolean): CSSProperties {
  return {
    padding: "4px 6px",
    border: "none",
    background: "transparent",
    color: enabled ? CHROME_INK : CHROME_MUTED,
    font: CHROME_FONT,
    lineHeight: 1,
    cursor: enabled ? "pointer" : "default",
  };
}

const emptyStyle: CSSProperties = { padding: "6px 8px", color: CHROME_MUTED, font: CHROME_FONT };

// ---- the tab strip ---------------------------------------------------------
//
// A STRIP OF REAL TABS, sitting at the TOP OF THE CANVAS COLUMN and joined to
// the canvas directly beneath it (CanvasPanel.tsx's `data-canvas-page-tab-row`,
// the column's first child, above `data-canvas-viewport`) — file-folder tabs on
// a folder, which is why the strip itself has no background or border of its
// own and no bottom edge: the CANVAS below IS the surface the current tab
// belongs to, and drawing a line between them is exactly what stops a tab
// reading as a tab.
//
// WHY THE STRIP SCROLLS RATHER THAN WRAPPING, unlike the floating toolbar which
// wraps (canvas/pages/chrome-dock.ts's CHROME_DOCK_TOOLBAR_OVERFLOW): pages are
// unbounded and the toolbar's controls are not. A wrapped strip would grow
// without limit, eating the canvas column's height — the drawing surface it is
// supposed to be chrome for. Unchanged across both of this row's homes: it was
// already the behaviour when the strip floated on the toolbar card, and it is
// still the answer now that the row is back in the column's flow.
const tabBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 2,
  padding: "0 4px",
  overflowX: "auto",
  flexShrink: 0,
  // THE JOIN. The strip overlaps its row's bottom border by exactly that
  // border, so the current tab's paper meets the CANVAS below with no line
  // between them — the whole of what makes a tab look attached to the thing it
  // shows rather than stacked above it. (Owner request 2026-09-06 moved this
  // row from the floating card at the bottom to the top of the column; the
  // join is the same trick, now pointing at the canvas instead of the card.)
  marginBottom: -1,
  // …and `position: relative` is what puts the strip's pixels ON TOP of that
  // border instead of under it. A POSITIONED box (even at `z-index: auto`)
  // paints after the in-flow, non-positioned content of its parent — so no
  // z-index is needed, and none may be written here: layering is
  // canvas/pages/chrome-dock.ts's and canvas/dock/popover-place.ts's, and
  // tests/page-switcher-layering.test.ts refuses a numeric one in this file.
  // READ OFF THE CSS PAINT ORDER, NOT OBSERVED — there is no browser here.
  position: "relative",
};

/**
 * One tab.
 *
 * The CURRENT tab is JOINED to the canvas below: same paper, rounded only at
 * the top, and its bottom border is that surface's own colour rather than a
 * line — so the seam between tab and canvas disappears and the two read as one
 * shape. Every OTHER tab is RECESSED: a translucent ink wash over whatever the
 * canvas is showing, its own hairline all the way round the top, and pushed
 * down by a pixel of extra top padding so it sits behind the front tab's
 * plane.
 *
 * A STYLE FUNCTION OF `current`, WHICH IS NOT A BEHAVIOURAL BRANCH — the same
 * shape `nameButtonStyle` above has had all along. What the tab DOES is
 * identical either way; only its paint differs, and `aria-pressed` carries the
 * same fact to a reader who cannot see paint.
 */
function pageTabStyle(current: boolean): CSSProperties {
  return {
    padding: current ? "5px 12px 6px" : "6px 12px 5px",
    borderStyle: "solid",
    borderWidth: "1px 1px 0",
    borderColor: current ? CHROME_HAIRLINE : CHROME_FAINT,
    borderTopLeftRadius: 7,
    borderTopRightRadius: 7,
    background: current ? CHROME_PAPER : CHROME_RECESS,
    color: CHROME_INK,
    fontWeight: current ? 600 : 400,
    font: CHROME_FONT,
    cursor: "pointer",
    whiteSpace: "nowrap",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

/**
 * The insertion mark that says where a dragged tab would land.
 *
 * WHETHER it is drawn, and in WHICH gap, is canvas/pages/tab-drag.ts's
 * `showsDropLineAt`. ITS GEOMETRY IS THAT MODULE'S TOO, spread in whole rather
 * than re-stated here: how wide the mark is, and that it may not shrink, is the
 * difference between "the drop position is indicated" and a drag aimed blind —
 * a decision, and this file is one no test can read. Naming the constant HERE
 * was not enough: on 2026-09-06 `width: 0` and `width: TAB_DRAGGED_OPACITY`
 * (0.7px, a sub-pixel hairline) both shipped with the whole suite green,
 * because the constant was pinned and its use was not.
 *
 * WHAT IS LEFT IS PAINT, and it is genuinely this file's: the accent colour and
 * the rounded end are the canvas's own palette (canvas/pages/chrome-dock.ts),
 * not a fact about the gesture.
 *
 * A REAL FLEX ITEM, NOT AN OVERLAY, AND THAT HAS A COST: inserting it pushes
 * the tabs after it right by its width plus one of the strip's 2px gaps, so the
 * row shifts by about four pixels the moment the mark appears. The alternative
 * (an absolutely-positioned line) would need the strip's own rect and its
 * scroll offset, i.e. more measurement and more arithmetic, to buy back four
 * pixels. THE SHIFT CANNOT FEED BACK INTO THE DECISION — the boxes the drop is
 * computed against are measured once, at the press, before any of this exists.
 * INFERRED FROM THE FLEX LAYOUT, NOT OBSERVED; there is no browser here.
 */
const dropLineStyle: CSSProperties = {
  ...TAB_DROP_LINE_PAINT,
  borderRadius: 1,
  background: CHROME_ACCENT,
};

/** The ＋ at the end of the strip. Deliberately NOT a tab shape: it opens
 * nothing and selects nothing, so giving it the folder-tab silhouette would
 * claim it is a page. A plain, quiet control instead. */
const newTabStyle: CSSProperties = {
  padding: "4px 8px",
  border: "none",
  background: "transparent",
  color: CHROME_INK,
  font: CHROME_FONT,
  lineHeight: 1,
  cursor: "pointer",
  alignSelf: "center",
};

// ---- the tab's context menu ------------------------------------------------
//
// RENAME AND DELETE, ON THE TAB ITSELF (owner request 2026-09-06). Which items
// exist, whether each is enabled, what opens and closes it, which key raises it
// and where focus goes afterwards are all canvas/pages/page-tab-menu.ts's;
// whether it may open over a reorder in flight is canvas/pages/tab-drag.ts's.
// What is left here is paint and hands.
//
// A PLAIN LIST OF BUTTONS, not a roving-tabindex composite. `role="menu"` with
// full ARIA keyboard semantics wants arrow-key navigation between items and a
// focus manager to go with it — a decision surface with real behaviour that,
// in a project with no jsdom, nothing could check. Two real <button>s in DOM
// order are reachable with Tab, operable with Enter and Space by the browser's
// own rules, and disabled-not-hidden tells a reader why an item cannot be used.
// STATED AS A LIMIT RATHER THAN A FEATURE: arrow keys do not move between these
// two items.
const tabMenuStyle: CSSProperties = {
  position: "fixed",
  // The shared layer, for the reason popover-place.ts's POPOVER_Z_INDEX gives
  // in full — under bb's dialogs and palette, over this plugin's own chrome.
  zIndex: POPOVER_Z_INDEX,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 140,
  padding: 4,
  borderRadius: 8,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_PAPER,
  color: CHROME_INK,
  font: CHROME_FONT,
  boxShadow: CHROME_POPOVER_SHADOW,
};

/** One item. A style FUNCTION of `enabled`, which is not a behavioural branch —
 * the same shape `pageTabStyle(row.current)` and `microButtonStyle(enabled)`
 * already have. What the item DOES when disabled is the browser's business;
 * only its paint is decided here. */
function tabMenuItemStyle(enabled: boolean): CSSProperties {
  return {
    textAlign: "left",
    padding: "5px 10px",
    borderRadius: 4,
    border: "none",
    background: "transparent",
    color: enabled ? CHROME_INK : CHROME_MUTED,
    font: CHROME_FONT,
    cursor: enabled ? "pointer" : "default",
    whiteSpace: "nowrap",
  };
}

/**
 * An element's rect as an anchor — or the module's anchorless value when there
 * is no element.
 *
 * TWO CALLERS, ONE ANSWER. The Pages popover hangs off the TAB STRIP (its own
 * anchor, the "Pages" button, left the toolbar on 2026-09-06) and a tab's
 * context menu hangs off THAT TAB; both of those elements can legitimately be
 * absent — the strip is width-gated, and a tab can be deleted by a peer while
 * its menu is open. Neither case is "leave the box where it was": that is not a
 * position, it is whatever a previous open happened to compute, and it is
 * unreadable by any test in a project with no jsdom.
 *
 * NO_POPOVER_ANCHOR routes both into canvas/dock/popover-place.ts's own,
 * already-tested fallback — the safe corner — so the decision is one a test can
 * drive rather than an `if (!anchor) return;` written here.
 */
function anchorOf(element: Element | null): PopoverAnchor {
  if (element === null) return NO_POPOVER_ANCHOR;
  // NAMED `element`, NOT `node`, and NOT destructured into `rect.left` /
  // `rect.right`: tests/tab-drag.test.ts pins that the strip is measured in
  // exactly ONE place (`measureTabs`, once per gesture, because a re-measure
  // mid-drag reads a layout that has already moved) by counting
  // `node.getBoundingClientRect()` and `rect.left` in this file. A second
  // measurement wearing the same names would satisfy that count while the real
  // one had gone.
  const anchor = element.getBoundingClientRect();
  return {
    anchorLeft: anchor.left,
    anchorRight: anchor.right,
    anchorTop: anchor.top,
    anchorBottom: anchor.bottom,
  };
}

export interface PageSwitcherNodes {
  /** Goes at the TOP OF THE CANVAS COLUMN, in the flow, directly above the
   * viewport and joined to it. `null` on a narrow column
   * (canvas/pages/page-tabs-fit.ts). */
  readonly tabs: ReactNode;
  /**
   * Both <body>-portalled surfaces — the Pages popover and a tab's context
   * menu — bundled so the panel has ONE thing to mount rather than two.
   *
   * WHERE THE PANEL PUTS THIS DOES NOT MATTER, and that is the point: every
   * node inside is a `createPortal` onto <body>, so this occupies no space and
   * inherits no layout wherever it is rendered. What DOES matter is that it is
   * rendered UNCONDITIONALLY, i.e. not inside the width gate `tabs` is behind:
   * the popover is still opened by bb's command palette on a column too narrow
   * to draw a single tab, and a surface that only exists at desktop widths is a
   * surface that is missing exactly when it is most needed.
   *
   * THIS REPLACES `button`. The "Pages: <name>" toolbar button was removed at
   * the owner's request on 2026-09-06 ("Lets remove the page selector from the
   * control bar"), and it used to be what carried the popover into the tree.
   */
  readonly overlays: ReactNode;
}

export function usePageSwitcher(input: {
  readonly editor: Editor;
  readonly snapshot: CanvasDocument;
  readonly currentPageId: string;
  /** The canvas column's measured width — see page-tabs-fit.ts on what is
   * being measured and why it cannot feed back into itself. */
  readonly containerWidth: number;
}): PageSwitcherNodes {
  const { editor, snapshot, currentPageId, containerWidth } = input;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  // EVERY DRAWN TAB, BY PAGE ID. Two things need to reach a tab ELEMENT and
  // neither can do it by traversal: the context menu has to be placed against
  // the tab it hangs off, and focus has to be handed back to that tab when the
  // menu closes (`pageTabMenuFocusReturn`). A map keyed by id rather than by
  // index, because a reorder changes every index and the id is the thing the
  // menu is actually about.
  //
  // ENTRIES ARE DELETED ON UNMOUNT, not left to rot: a stale node for a page
  // that has been deleted would be focused into nowhere, and `get` returning
  // undefined is already the same answer as "do not move focus".
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const holdTabRef = useCallback((id: string, node: HTMLButtonElement | null): void => {
    if (node === null) tabRefs.current.delete(id);
    else tabRefs.current.set(id, node);
  }, []);

  const dispatchMenu = useCallback((event: PageMenuEvent) => {
    setOpen((current) => nextPageMenuOpen(current, event));
  }, []);

  const rows = useMemo(
    () => pageMenuRows(snapshot.pages, currentPageId),
    [snapshot.pages, currentPageId],
  );
  const visibleRows = useMemo(() => filterPageRows(rows, query), [rows, query]);

  // ---- mutations. Each one is helper -> applyAll -> tell the menu ----------

  const switchTo = useCallback(
    (row: PageMenuRow) => {
      // Whether clicking this row is worth an intent at all is page-menu.ts's
      // call (`switchPageIntents`), not this file's — same helper-then-guard
      // shape as rename/delete/move below.
      const intents = switchPageIntents(row);
      if (intents.length > 0) editor.applyAll(intents);
      dispatchMenu({ type: "acted", action: "switch" });
    },
    [editor, dispatchMenu],
  );

  const addPage = useCallback(() => {
    editor.applyAll(newPageIntents(editor));
    dispatchMenu({ type: "acted", action: "create" });
  }, [editor, dispatchMenu]);

  const rename = useCallback(
    (row: PageMenuRow) => {
      // window.prompt, as upstream's switcher does. Crude, and deliberately
      // the same crude thing: an inline-editing affordance is a second focus
      // and commit-on-blur problem, and this spike has no way to test one.
      const intents = renamePageIntents(row, window.prompt("Rename page", row.name));
      if (intents.length > 0) editor.applyAll(intents);
      dispatchMenu({ type: "acted", action: "rename" });
    },
    [editor, dispatchMenu],
  );

  const remove = useCallback(
    (row: PageMenuRow) => {
      // Intents FIRST, then the dialog. `deletePageIntents` refuses the doc's
      // only page (returns []), and page-delete-confirm.ts turns that refusal
      // into "do not ask" — so the user is never made to authorise a delete
      // that could not have happened. Asking the intents up front is what
      // makes that possible; it is a pure read of doc state, not a mutation.
      const intents = deletePageIntents(editor, row.id);
      const prompt = pageDeletePrompt(row.name, intents.length > 0);
      if (prompt.kind === "ask" && !window.confirm(prompt.message)) return;
      if (intents.length > 0) editor.applyAll(intents);
      dispatchMenu({ type: "acted", action: "delete" });
    },
    [editor, dispatchMenu],
  );

  const move = useCallback(
    (row: PageMenuRow, dir: MoveDir) => {
      const intents = movePageIntents(editor, row.id, dir);
      if (intents.length > 0) editor.applyAll(intents);
      dispatchMenu({ type: "acted", action: "move" });
    },
    [editor, dispatchMenu],
  );

  // ---- the tab strip's click-and-hold reorder ------------------------------
  //
  // EVERY RULE OF THIS GESTURE IS canvas/pages/tab-drag.ts's: the arm distance,
  // which button may start it, what a release means, what a cancel restores,
  // where the drop lands, what is painted, and whether a context menu may open
  // over it. What is left here is genuinely hands — read the pointer, measure
  // the boxes, run the effect the machine returned.
  //
  // THE STATE IS KEPT TWICE, IN A REF AND IN STATE, ON PURPOSE. The ref is what
  // the next event transitions from: pointer events arrive faster than React
  // re-renders, and a handler closing over a stale `useState` value would drop
  // moves. The state exists so the strip repaints. They are written together,
  // in that order, and nothing else writes either.

  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<TabDragState>(IDLE_TAB_DRAG);
  const [dragState, setDragState] = useState<TabDragState>(IDLE_TAB_DRAG);

  // THE TABS AS THEY WERE WHEN THE FINGER LANDED. See `measureTabs` below for
  // why they are taken once and never refreshed mid-gesture.
  const boxesRef = useRef<readonly TabBox[]>([]);

  /**
   * Every drawn tab's horizontal extent, in client pixels — the same space the
   * pointer's `clientX` is in, which is what makes them comparable without any
   * scroll arithmetic.
   *
   * CALLED ONCE PER GESTURE, from the one press the machine ACCEPTED — see
   * `beginTabDrag` below, which is where the gate lives. That is the decision
   * the rest rests on. The strip is `overflowX: auto`, so a re-measure mid-drag
   * could see a scrolled strip; the dragged tab carries a `transform`, which
   * `getBoundingClientRect` includes; and the drop line is a real flex item that
   * shifts its neighbours. All three would move the target under the pointer
   * while the user was aiming at it.
   *
   * THAT CLAIM WAS FALSE UNTIL 2026-09-06: this ran on every pointerdown on any
   * tab, ahead of the machine's refusals, so a second finger or a right-click
   * mid-drag re-measured the mid-drag layout — and the drop the user was aiming
   * at then computed to `null`, emitting nothing and erasing the drop line. The
   * gate is `tab-drag.ts`'s `tabDragTakesMeasurement`, so it is a rule a test
   * can drive rather than an `if` written here.
   *
   * ...WHICH IS ALSO WHY THIS GESTURE NEVER SCROLLS THE STRIP. Edge
   * auto-scroll during a drag is the obvious companion feature and it is
   * deliberately absent: it needs a timer and a re-measure, and it would put
   * the boxes back in motion. A page whose drop site is scrolled off the end is
   * still reachable — the Pages popover's ◂ / ▸ buttons move a page a slot at a
   * time, and are the keyboard path besides. Owner-visible consequence, stated
   * rather than discovered: on a strip too narrow to show every tab, a drag can
   * only reorder among the tabs you can see.
   */
  const measureTabs = useCallback((): readonly TabBox[] => {
    const strip = stripRef.current;
    if (strip === null) return [];
    return Array.from(strip.querySelectorAll("[data-canvas-page-tab]"), (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
  }, []);

  /**
   * What the machine's verdict costs the document.
   *
   * A `switch` ON A DECIDED EFFECT IS NOT A DECISION — the choice between
   * switching and dropping was already made in tab-drag.ts, against a state
   * machine a test can drive. This is the interpreter, the same shape as
   * `if (prompt.kind === "ask")` in `remove` above.
   */
  const runDragEffect = useCallback(
    (effect: TabDragEffect): void => {
      if (effect.kind === "switch") {
        // Resolved back to a row because `switchPageIntents` is the thing that
        // refuses a switch to the page you are already on, and it reads
        // `row.current`. A row that has vanished between the press and the
        // click is a no-op, not a throw.
        const row = rows.find((candidate) => candidate.id === effect.id);
        if (row !== undefined) switchTo(row);
        return;
      }
      if (effect.kind === "drop") {
        const intents = dropPageIntents(
          editor,
          effect.id,
          dropIndexAt(boxesRef.current, effect.pointerX, effect.index),
        );
        if (intents.length > 0) editor.applyAll(intents);
      }
    },
    [editor, rows, switchTo],
  );

  const dispatchDrag = useCallback(
    (event: TabDragEvent): void => {
      const step = nextTabDrag(dragRef.current, event);
      dragRef.current = step.state;
      setDragState(step.state);
      runDragEffect(step.effect);
    },
    [runDragEffect],
  );

  /**
   * The press.
   *
   * POINTER CAPTURE IS TAKEN HERE, unconditionally — including for the
   * secondary button the machine is about to refuse. Capturing is what keeps
   * the moves and the release coming to THIS tab once the finger leaves it;
   * without it the gesture would go deaf the moment it crossed onto a sibling,
   * and a release outside the strip would never arrive at all, stranding a
   * lifted tab. Capturing on a refused press is harmless: the machine ignores
   * every event that follows, and the implicit release at pointerup fires
   * `lostpointercapture`, which is a no-op on an idle machine (tab-drag.ts's
   * cancel case, pinned in tests/tab-drag.test.ts). Doing it unconditionally
   * also keeps a second `if` about buttons out of this file, where nothing
   * could read it.
   *
   * THE MEASUREMENT IS NOT UNCONDITIONAL, AND THAT IS THE DIFFERENCE. Capture
   * is cheap to take and harmless to hold; a measurement is neither, because
   * every drop index for the rest of the gesture is computed against it. So the
   * boxes are refreshed only when `tabDragTakesMeasurement` says this press
   * actually STARTED something — never on the second finger or the right-click
   * the machine just refused, which would otherwise re-measure the mid-drag
   * layout out from under a gesture already in flight.
   *
   * MEASURING AFTER THE DISPATCH IS SAFE, and deliberately so rather than
   * incidentally: React has not committed the new state yet, and even if it
   * had, `pressed` paints nothing — `tabDragPresentation` returns the
   * not-dragging presentation for it, so no tab is transformed and no drop line
   * exists to shift anything. INFERRED FROM THAT RULE (which its own tests
   * pin), NOT OBSERVED; there is no browser here.
   */
  const beginTabDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, index: number, id: string): void => {
      event.currentTarget.setPointerCapture(event.pointerId);
      const before = dragRef.current;
      dispatchDrag({
        type: "down",
        index,
        id,
        pointerId: event.pointerId,
        button: event.button,
        x: event.clientX,
      });
      if (tabDragTakesMeasurement(before, dragRef.current)) {
        boxesRef.current = measureTabs();
      }
    },
    [dispatchDrag, measureTabs],
  );

  // TOTAL CANCELLATION, the third and fourth ways a gesture can die (the tab's
  // own `pointercancel` and `lostpointercapture` are the first two). Escape is
  // the deliberate one; a lost window is the accidental one — alt-tabbing away
  // mid-drag must not leave a tab lifted forever, waiting for a pointerup that
  // is never coming.
  //
  // ONLY WHILE A GESTURE IS IN FLIGHT, which is `tabDragIsActive`'s call and
  // not this file's: `suppress` is deliberately NOT active (it holds no
  // pointer, it is only waiting to eat one click), so these come down as soon
  // as the drag is released.
  useEffect(() => {
    if (!tabDragIsActive(dragState)) return;
    function onDragKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      dispatchDrag({ type: "cancel" });
    }
    function onDragBlur(): void {
      dispatchDrag({ type: "cancel" });
    }
    window.addEventListener("keydown", onDragKeyDown);
    window.addEventListener("blur", onDragBlur);
    return () => {
      window.removeEventListener("keydown", onDragKeyDown);
      window.removeEventListener("blur", onDragBlur);
    };
  }, [dragState, dispatchDrag]);

  const presentation = tabDragPresentation(dragState, boxesRef.current);

  // ---- the tab's context menu ---------------------------------------------
  //
  // THE STATE IS KEPT TWICE, IN A REF AND IN STATE, for the same reason the
  // drag's is: `dispatchTabMenu` is called from document-level listeners that
  // close over their render's values, and a stale `useState` read would let a
  // dismissal transition from the wrong state. They are written together, in
  // that order, and nothing else writes either.

  const menuRef = useRef<HTMLDivElement | null>(null);
  const tabMenuRef = useRef<PageTabMenuState>(CLOSED_PAGE_TAB_MENU);
  const [tabMenuOpenId, setTabMenuOpenId] = useState<PageTabMenuState>(CLOSED_PAGE_TAB_MENU);

  const dispatchTabMenu = useCallback((event: PageTabMenuEvent): void => {
    const before = tabMenuRef.current;
    const next = nextPageTabMenu(before, event);
    tabMenuRef.current = next;
    setTabMenuOpenId(next);
    // WHETHER THIS DISMISSAL MAY TAKE FOCUS BACK, and to which tab, is
    // page-tab-menu.ts's `pageTabMenuFocusReturn` — an outside click has
    // already put focus where the user chose, and yanking it back is the one
    // restore that would be dishonest. Looking the element up is hands; a tab
    // that has since been deleted is simply not in the map.
    const back = pageTabMenuFocusReturn(before, next, event);
    if (back !== null) tabRefs.current.get(back)?.focus();
  }, []);

  /**
   * A right-click, a long press, or the keyboard context-menu key landed on a
   * tab.
   *
   * TWO THINGS HAPPEN BEFORE THE MENU OPENS, and both are the drag's rules
   * rather than this file's:
   *
   *   * `tabDragBlocksContextMenu` refuses outright while a reorder is in
   *     flight — a menu over a tab that is currently following the pointer is
   *     both a broken-looking overlay and a second, unasked-for effect from one
   *     gesture. Read from the REF, not from `dragState`: pointer events arrive
   *     faster than React re-renders.
   *   * the machine is told `context-menu`, which is NOT `cancel`. On touch the
   *     press that raised this menu is still live and still owes a pointerup —
   *     and, on some engines, a `click` — and letting that click through would
   *     switch the page underneath the menu the same gesture just opened. The
   *     machine parks in `suppress` to eat it. Nothing has been written to the
   *     document either way: a drag only reaches the doc at its drop.
   */
  const openTabMenu = useCallback(
    (id: string): void => {
      if (tabDragBlocksContextMenu(dragRef.current)) return;
      dispatchDrag({ type: "context-menu" });
      dispatchTabMenu({ type: "open", id });
    },
    [dispatchDrag, dispatchTabMenu],
  );

  const tabMenuRow = pageTabMenuTarget(rows, tabMenuOpenId);
  const tabMenuItems = useMemo(
    () => (tabMenuRow === null ? [] : pageTabMenuItems(tabMenuRow)),
    [tabMenuRow],
  );

  /**
   * What an item does. A `switch`-shaped read of an id the module already
   * decided on — the interpreter, not the decision, the same shape
   * `runDragEffect` and `if (prompt.kind === "ask")` above already have.
   *
   * BOTH ARMS CALL THE POPOVER'S OWN HANDLERS. That is the point: `remove` is
   * the one that asks `deletePageIntents` first and hands its EMPTINESS to
   * `pageDeletePrompt`, which is what stops a single-page document being asked
   * to authorise a delete that was already refused. A second delete path here
   * would reopen that bug on the surface most people will now use.
   */
  const runTabMenuItem = useCallback(
    (row: PageMenuRow, id: PageTabMenuItemId): void => {
      if (id === "rename") rename(row);
      if (id === "delete") remove(row);
      dispatchTabMenu({ type: "acted" });
    },
    [rename, remove, dispatchTabMenu],
  );

  // Focus lands on the first item that can actually be used
  // (`pageTabMenuFocusItem` — parking it on a disabled control is how a
  // keyboard user meets a menu that appears to do nothing). Queried out of the
  // menu rather than ref-held: there are two items and the id is already in
  // the DOM as the attribute a test hook uses.
  useLayoutEffect(() => {
    if (tabMenuOpenId === null) return;
    const first = pageTabMenuFocusItem(tabMenuItems);
    if (first === null) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>(`[data-canvas-page-tab-menu-item="${first}"]`)
      ?.focus();
  }, [tabMenuOpenId, tabMenuItems]);

  // Dismissal. Same two ways out as the popover's, and the same containment
  // lesson: the menu is portalled to <body>, so the check has to name the menu
  // element ITSELF as well as its descendants or every press on one of its own
  // buttons dismisses on the way DOWN.
  useEffect(() => {
    if (tabMenuOpenId === null) return;

    function insideMenu(node: Node): boolean {
      const menu = menuRef.current;
      return menu !== null && (node === menu || menu.contains(node));
    }

    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      dispatchTabMenu({
        type: "pointerdown",
        insideMenu: target instanceof Node && insideMenu(target),
      });
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      dispatchTabMenu({ type: "escape" });
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [tabMenuOpenId, dispatchTabMenu]);

  // Placement, against the TAB the menu hangs off. The strip is at the top of
  // the column, so `placePopoverBox`'s resting position — below the anchor by
  // POPOVER_ANCHOR_GAP_PX — is the direction this wants, and its flip only
  // runs when below genuinely does not fit. No second clamp is written here;
  // tests/page-tab-menu.test.ts pins the downward case with absolute numbers.
  const [tabMenuBox, setTabMenuBox] = useState<PopoverRect>({
    left: POPOVER_EDGE_MARGIN_PX,
    top: POPOVER_EDGE_MARGIN_PX,
  });

  useLayoutEffect(() => {
    if (tabMenuOpenId === null) return;
    const place = (): void => {
      const menu = menuRef.current?.getBoundingClientRect();
      if (!menu) return;
      setTabMenuBox(
        placePopoverBox({
          ...anchorOf(tabRefs.current.get(tabMenuOpenId) ?? null),
          popoverWidth: menu.width,
          popoverHeight: menu.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    place();
    window.addEventListener("resize", place);
    // Capture, so a scroll in any ancestor is seen — including the strip's own
    // horizontal scroll, which moves the tab this box is pinned to.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [tabMenuOpenId, tabMenuItems.length]);

  // ---- the palette door ---------------------------------------------------

  useEffect(() => {
    // Published for as long as this panel is mounted; the palette row hides
    // itself when it is not (canvas/pages/page-door.ts).
    return pageDoor.setOpener(() => {
      dispatchMenu({ type: "palette" });
    });
  }, [dispatchMenu]);

  // ---- dismissal ----------------------------------------------------------

  useEffect(() => {
    if (!open) return;

    /**
     * Is this node inside the widget?
     *
     * ONE ROOT NOW, AND IT USED TO BE TWO. While the "Pages" button existed it
     * had to be checked too, because the popover is portalled to <body> and is
     * not a descendant of it — a containment check that knew only about the
     * button would read every press on a control INSIDE the popover as
     * "outside" and dismiss on the way DOWN, before the click that operates the
     * control ever arrived. That is canvas/dock/dock.ts's `insideWidget`
     * lesson, and it is still why this asks about the popover ITSELF (`node ===
     * popover`) as well as its descendants. The button left the toolbar on
     * 2026-09-06, so there is one root to ask about; the lesson is unchanged.
     *
     * NOTHING TESTS THE CONTAINMENT ITSELF — there is no jsdom here. What IS
     * tested is what each answer means (page-menu.ts's `nextPageMenuOpen`,
     * both branches).
     */
    function insideWidget(node: Node): boolean {
      const popover = popoverRef.current;
      return popover !== null && (node === popover || popover.contains(node));
    }

    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      dispatchMenu({
        type: "pointerdown",
        insideWidget: target instanceof Node && insideWidget(target),
      });
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      dispatchMenu({ type: "escape" });
      // Focus goes back to the CURRENT PAGE'S TAB — the nearest thing to
      // "where the gesture started" now that the Pages button is gone. Escape
      // is the one dismissal that can restore focus honestly: an outside click
      // has already put it somewhere the user chose.
      //
      // OFTEN THERE IS NOWHERE TO SEND IT, and that is deliberate rather than
      // unhandled: on a column too narrow for the strip no tab is drawn, and
      // the popover's other way in is bb's command palette, which restores
      // focus itself before `run` even fires (page-door.ts quotes the SDK on
      // this). An absent entry in the map is the same answer as "leave focus
      // alone".
      tabRefs.current.get(currentPageId)?.focus();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, dispatchMenu, currentPageId]);

  // ---- placement ----------------------------------------------------------

  const [box, setBox] = useState<PopoverRect>({
    left: POPOVER_EDGE_MARGIN_PX,
    top: POPOVER_EDGE_MARGIN_PX,
  });

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const popover = popoverRef.current?.getBoundingClientRect();
      if (!popover) return;
      setBox(
        placePopoverBox({
          ...anchorOf(stripRef.current),
          popoverWidth: popover.width,
          popoverHeight: popover.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    place();
    window.addEventListener("resize", place);
    // Capture, so a scroll in any ancestor container is seen: a fixed box does
    // not move with the anchor, and a popover left behind by a scrolled panel
    // is worse than one that is merely misplaced. Only while open, so this is
    // not a listener on every scroll in the app.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
    // The popover's own height changes as the filter narrows the list, so a
    // re-place is owed on every change to what it draws.
  }, [open, visibleRows.length, query]);

  // Every open starts from an empty box, with the caret in it. Emptying it
  // here rather than at each of the two ways in (the button and the palette)
  // keeps them from drifting apart, and a stale filter from ten minutes ago
  // would hide most of the list the user just asked to see. The focus is what
  // makes "type the page's name" the fast path the palette row promises, and
  // it is where a keyboard user expects to land in a list they asked to
  // search.
  useLayoutEffect(() => {
    if (!open) return;
    setQuery("");
    filterRef.current?.focus();
  }, [open]);

  // ---- the tab bar's visibility ------------------------------------------

  const [tabsVisible, setTabsVisible] = useState(() => choosePageTabsVisible(containerWidth));
  useEffect(() => {
    setTabsVisible((visible) => nextPageTabsVisible(visible, containerWidth));
  }, [containerWidth]);

  // ---- render -------------------------------------------------------------

  const popover = !open
    ? null
    : createPortal(
        // PORTALLED TO <body> so the box escapes every ancestor's overflow and
        // any transformed ancestor in bb's shell (a transform makes `position:
        // fixed` resolve against that ancestor instead of the viewport, which
        // would put this box inside the pane it is trying to hang out of).
        // The presence dock's popover lives on <body> for the same reason.
        <div
          ref={popoverRef}
          data-canvas-page-menu
          role="dialog"
          aria-label="Pages"
          style={{ ...popoverStyle, left: box.left, top: box.top }}
        >
          <input
            ref={filterRef}
            type="text"
            value={query}
            aria-label="Filter pages"
            placeholder="Filter pages…"
            data-canvas-page-filter
            style={filterStyle}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const target = pageMenuEnterTarget(visibleRows);
              if (target !== null) switchTo(target);
            }}
          />
          {visibleRows.length === 0 ? (
            <div style={emptyStyle}>No page matches “{query.trim()}”.</div>
          ) : (
            visibleRows.map((row) => (
              <div key={row.id} style={rowStyle}>
                <button
                  type="button"
                  data-canvas-page={row.id}
                  aria-pressed={row.current}
                  title="Click to switch pages, double-click to rename"
                  onClick={() => switchTo(row)}
                  onDoubleClick={() => rename(row)}
                  style={nameButtonStyle(row.current)}
                >
                  {row.name}
                </button>
                <button
                  type="button"
                  aria-label={`Rename ${row.name}`}
                  onClick={() => rename(row)}
                  style={microButtonStyle(true)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  aria-label={`Move ${row.name} left`}
                  disabled={!row.canMoveLeft}
                  onClick={() => move(row, "left")}
                  style={microButtonStyle(row.canMoveLeft)}
                >
                  ◂
                </button>
                <button
                  type="button"
                  aria-label={`Move ${row.name} right`}
                  disabled={!row.canMoveRight}
                  onClick={() => move(row, "right")}
                  style={microButtonStyle(row.canMoveRight)}
                >
                  ▸
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${row.name}`}
                  disabled={!row.canDelete}
                  onClick={() => remove(row)}
                  style={microButtonStyle(row.canDelete)}
                >
                  ×
                </button>
              </div>
            ))
          )}
          <button
            type="button"
            data-canvas-new-page
            onClick={addPage}
            style={{ ...buttonStyle, marginTop: 2 }}
          >
            ＋ New page
          </button>
        </div>,
        document.body,
      );

  const tabMenu =
    tabMenuRow === null
      ? null
      : createPortal(
          // PORTALLED TO <body> for exactly the reasons the popover above is:
          // out of every ancestor's overflow and out of any transformed
          // ancestor in bb's shell, which is also the only place its z-index
          // means anything.
          <div
            ref={menuRef}
            data-canvas-page-tab-menu
            role="menu"
            aria-label={pageTabMenuLabel(tabMenuRow)}
            style={{ ...tabMenuStyle, left: tabMenuBox.left, top: tabMenuBox.top }}
          >
            {tabMenuItems.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-canvas-page-tab-menu-item={item.id}
                disabled={!item.enabled}
                onClick={() => runTabMenuItem(tabMenuRow, item.id)}
                style={tabMenuItemStyle(item.enabled)}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        );

  // BOTH <body> SURFACES, HANDED OVER AS ONE NODE — see PageSwitcherNodes. Each
  // is already a portal, so this occupies no space wherever the panel renders
  // it; what matters is only that the panel renders it UNCONDITIONALLY.
  const overlays = (
    <>
      {popover}
      {tabMenu}
    </>
  );

  // THE NAME AND NOTHING ELSE. The ◂ / ▸ / × micro-buttons that used to ride
  // in every tab are gone at the owner's request ("just make the page name look
  // like a tab") — four controls per tab is a management console, not a tab
  // strip, and it was what made the strip need ~136px per page.
  //
  // NOTHING WAS LOST WITH THEM, AND THAT IS LOAD-BEARING RATHER THAN
  // REASSURING: the popover above still carries rename, both moves and delete,
  // and it is the KEYBOARD path to all four. Reordering IS a pointer drag on
  // these tabs as of 2026-09-06; a drag is unreachable by keyboard, so if the
  // popover's move buttons went too, page reordering would be pointer-only —
  // an accessibility regression, not a simplification. tests/
  // page-switcher-tabs.test.ts pins both halves of that split.
  //
  // FIVE GESTURES NOW SHARE ONE TAB, and only one of them is decided here (the
  // rename, on double-click). Click-to-switch and drag-to-reorder are
  // canvas/pages/tab-drag.ts's, routed through `dispatchDrag` — which is why
  // this file never calls `switchTo` from a tab's `onClick`. Right-click,
  // long-press and the keyboard context-menu key all land in `openTabMenu`,
  // where tab-drag.ts is asked whether a reorder is in flight before anything
  // opens; what the menu then contains is canvas/pages/page-tab-menu.ts's.
  const tabs = !tabsVisible ? null : (
    <div ref={stripRef} style={tabBarStyle} data-canvas-page-tabs>
      {rows.map((row, index) => (
        <Fragment key={row.id}>
          {showsDropLineAt(presentation, index) ? (
            <span data-canvas-page-drop-line style={dropLineStyle} />
          ) : null}
          <button
            ref={(node) => holdTabRef(row.id, node)}
            type="button"
            data-canvas-page-tab={row.id}
            aria-pressed={row.current}
            title="Click to switch pages, drag to reorder, double-click to rename, right-click for more"
            onPointerDown={(event) => beginTabDrag(event, index, row.id)}
            onPointerMove={(event) =>
              dispatchDrag({ type: "move", pointerId: event.pointerId, x: event.clientX })
            }
            onPointerUp={(event) =>
              dispatchDrag({ type: "up", pointerId: event.pointerId, x: event.clientX })
            }
            onPointerCancel={() => dispatchDrag({ type: "cancel" })}
            onLostPointerCapture={() => dispatchDrag({ type: "cancel" })}
            onContextMenu={(event) => {
              // ALWAYS SUPPRESS THE BROWSER'S MENU — ours replaces it, and two
              // menus over one tab is not a thing anybody asked for. WHETHER
              // OURS OPENS is a different question, and `openTabMenu` asks
              // canvas/pages/tab-drag.ts. Keeping the two statements apart is
              // what stops a reorder in flight from being handed the browser's
              // menu as a consolation prize.
              event.preventDefault();
              openTabMenu(row.id);
            }}
            onKeyDown={(event) => {
              // THE KEYBOARD WAY IN, so the menu is not pointer-only. Which
              // keystroke asks for it is page-tab-menu.ts's
              // `decideTabContextMenuKey`; a `"F10"` written here would be a
              // decision no test in this jsdom-free project could read.
              if (!decideTabContextMenuKey(event)) return;
              event.preventDefault();
              openTabMenu(row.id);
            }}
            onClick={() => dispatchDrag({ type: "click", index, id: row.id })}
            onDoubleClick={() => rename(row)}
            style={{ ...pageTabStyle(row.current), ...tabDragPaint(presentation, index) }}
          >
            {row.name}
          </button>
        </Fragment>
      ))}
      {showsDropLineAt(presentation, rows.length) ? (
        <span data-canvas-page-drop-line style={dropLineStyle} />
      ) : null}
      <button
        type="button"
        data-canvas-new-page-tab
        aria-label="New page"
        title="New page"
        onClick={addPage}
        style={newTabStyle}
      >
        ＋
      </button>
    </div>
  );

  return { tabs, overlays };
}
