// Run: npx vitest run tests/page-tab-menu.test.ts
//
// THE TAB'S OWN CONTEXT MENU — rename and delete, on the tab itself.
//
// Owner request, 2026-09-06: "Lets remove the page selector from the control
// bar. […] Lets add a context menu to the tabs themselves to contain the
// rename & delete options."
//
// TWO HALVES, AND THEY FAIL DIFFERENTLY.
//
//   1. The DECISIONS — which items a tab offers, whether each is enabled, what
//      opens and closes the menu, which key raises it from a keyboard, and
//      where focus goes when it shuts. Those are `canvas/pages/page-tab-menu.ts`
//      and they are driven directly below, with no DOM anywhere near them.
//
//   2. The WIRING — that `canvas/pages/PageSwitcher.tsx` calls those decisions
//      rather than re-making them inline. This project has no jsdom and may not
//      gain one, so the strongest honest statement about the component is a
//      source-text one, read through `stripComments` (never raw: this file's
//      own prose would otherwise satisfy half of it) and bounded to one region
//      per surface.
//
// WHAT THIS FILE DOES NOT CLAIM. Nothing here has been seen in a browser —
// there is none in this spike. Every statement about what the user observes is
// an inference from this source plus the documented semantics of pointer,
// keyboard and focus events.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
} from "../canvas/pages/page-tab-menu.js";
import {
  NO_POPOVER_ANCHOR,
  POPOVER_ANCHOR_GAP_PX,
  POPOVER_EDGE_MARGIN_PX,
  placePopoverBox,
} from "../canvas/dock/popover-place.js";
import { pageMenuRows, type PageMenuRow } from "../canvas/pages/page-menu.js";
import {
  bodyStatements,
  callArguments,
  callsTo,
  countInCode,
  effectStatements,
  initializerText,
  jsxAttributes,
  stripComments,
  topLevelEffectIn,
} from "./lib/source.js";

/** A row as `pageMenuRows` builds them, with only the fields under test moved. */
function row(over: Partial<PageMenuRow> = {}): PageMenuRow {
  return {
    id: "page:a",
    name: "Canvas",
    current: true,
    canMoveLeft: false,
    canMoveRight: true,
    canDelete: true,
    ...over,
  };
}

describe("pageTabMenuItems — which items a tab offers, and whether each is live", () => {
  it("offers exactly rename then delete, in that order", () => {
    // ORDER IS A DECISION, not an accident of how the .tsx happens to spell the
    // JSX: the destructive item goes LAST, so the first thing under the pointer
    // (and the first thing focus lands on) is never the one that deletes a
    // page. Pinned as a whole list rather than by membership so that an extra
    // item — or a swap — has to come through this test.
    expect(pageTabMenuItems(row()).map((item) => item.id)).toEqual(["rename", "delete"]);
  });

  it("labels them for a reader, not for a developer", () => {
    const items = pageTabMenuItems(row({ name: "Sprint 14" }));
    expect(items.map((item) => item.label)).toEqual(["Rename", "Delete"]);
  });

  it("enables both on a page that can be deleted", () => {
    const items = pageTabMenuItems(row({ canDelete: true }));
    expect(items.map((item) => item.enabled)).toEqual([true, true]);
  });

  it("disables ONLY delete on the doc's last page — rename still works", () => {
    // THE REFUSAL THAT ALREADY EXISTS, hoisted to the affordance. Deleting the
    // only page is refused by `deletePageIntents` and
    // `page-delete-confirm.ts` turns that refusal into "do not even ask" — so
    // an ENABLED delete here would put up a dialog whose two answers are
    // indistinguishable, which is the exact bug that module's header records.
    //
    // The pairing matters as much as the value: a rule that disabled both would
    // pass a `delete is disabled` assertion on its own and would silently take
    // rename away from every single-page document.
    const items = pageTabMenuItems(row({ canDelete: false }));
    expect(items).toEqual([
      { id: "rename", label: "Rename", enabled: true },
      { id: "delete", label: "Delete", enabled: false },
    ]);
  });

  it("keeps the item present rather than dropping it when it cannot be used", () => {
    // `disabled`, not hidden — the same call the popover's micro-buttons make
    // (tests/page-switcher-tabs.test.ts pins it there). A menu whose length
    // changes with the document is a menu whose items move under the pointer,
    // and a screen reader is told nothing about WHY the action went away.
    expect(pageTabMenuItems(row({ canDelete: false })).map((item) => item.id)).toEqual([
      "rename",
      "delete",
    ]);
  });

  it("does not care which page is current, or where it sits in the order", () => {
    // Only `canDelete` may move an item. Reading `current` or the move flags
    // here would make a tab's own menu disagree with the popover's row for the
    // same page.
    const anywhere = pageTabMenuItems(
      row({ current: false, canMoveLeft: true, canMoveRight: false }),
    );
    expect(anywhere).toEqual(pageTabMenuItems(row()));
  });

  it("agrees with the row model a real document produces", () => {
    // The join between this module and `pageMenuRows`: a one-page doc's row is
    // where `canDelete: false` actually comes from, so the two are checked
    // together rather than against a hand-written literal.
    const [only] = pageMenuRows([{ id: "page:a", name: "Canvas", index: "a0" }], "page:a");
    expect(only).toBeDefined();
    expect(pageTabMenuItems(only!).map((item) => item.enabled)).toEqual([true, false]);
  });
});

describe("pageTabMenuLabel — what the menu tells a screen reader it is about", () => {
  it("names the page the menu hangs off", () => {
    // A bare "Page menu" on a strip of eight tabs says nothing about WHICH tab
    // the menu belongs to, which is the one fact a reader without eyes cannot
    // recover from the pointer position.
    expect(pageTabMenuLabel(row({ name: "Sprint 14" }))).toBe('Page "Sprint 14"');
  });
});

describe("pageTabMenuFocusItem — where focus lands when the menu opens", () => {
  it("lands on the first item that can actually be used", () => {
    expect(pageTabMenuFocusItem(pageTabMenuItems(row()))).toBe("rename");
  });

  it("skips a disabled item rather than parking focus on a dead control", () => {
    expect(
      pageTabMenuFocusItem([
        { id: "rename", label: "Rename", enabled: false },
        { id: "delete", label: "Delete", enabled: true },
      ]),
    ).toBe("delete");
  });

  it("answers null when nothing is usable, rather than naming a dead item", () => {
    expect(
      pageTabMenuFocusItem([
        { id: "rename", label: "Rename", enabled: false },
        { id: "delete", label: "Delete", enabled: false },
      ]),
    ).toBeNull();
    expect(pageTabMenuFocusItem([])).toBeNull();
  });
});

describe("pageTabMenuTarget — the row the open menu is about", () => {
  const rows = pageMenuRows(
    [
      { id: "page:a", name: "One", index: "a0" },
      { id: "page:b", name: "Two", index: "a1" },
    ],
    "page:a",
  );

  it("finds the row the menu was opened on", () => {
    expect(pageTabMenuTarget(rows, "page:b")?.name).toBe("Two");
  });

  it("is null when the menu is closed", () => {
    expect(pageTabMenuTarget(rows, CLOSED_PAGE_TAB_MENU)).toBeNull();
  });

  it("is null when the page has been deleted out from under the open menu", () => {
    // A REAL STATE, not a defensive shrug: a peer can delete the page this menu
    // hangs off while it is open, and the same one-render window exists between
    // a page-removing undo and history-repair.ts's clamp. Answering null is
    // what lets the component draw nothing instead of throwing the panel down.
    expect(pageTabMenuTarget(rows, "page:gone")).toBeNull();
  });
});

describe("nextPageTabMenu — the open/closed machine", () => {
  it("starts closed", () => {
    expect(CLOSED_PAGE_TAB_MENU).toBeNull();
  });

  it("opens on the tab it was asked for", () => {
    expect(nextPageTabMenu(CLOSED_PAGE_TAB_MENU, { type: "open", id: "page:a" })).toBe("page:a");
  });

  it("MOVES to another tab rather than toggling shut", () => {
    // Right-clicking tab B while tab A's menu is open is a request for B's
    // menu. A toggle would answer it by closing A and leaving nothing open,
    // and the user would have to right-click B twice.
    expect(nextPageTabMenu("page:a", { type: "open", id: "page:b" })).toBe("page:b");
  });

  it("re-opening the SAME tab keeps it open rather than closing it", () => {
    // The pointerdown that precedes a second right-click on the same tab has
    // already dismissed the menu (it is outside), so an `open` arriving here
    // means the outside-click path did not run — a toggle would make the menu
    // flicker shut on a gesture that asked for it.
    expect(nextPageTabMenu("page:a", { type: "open", id: "page:a" })).toBe("page:a");
  });

  it("closes on Escape", () => {
    expect(nextPageTabMenu("page:a", { type: "escape" })).toBeNull();
  });

  it("stays closed on an Escape with nothing open", () => {
    // Escape arrives constantly for reasons that have nothing to do with this
    // menu; answering with the same value is what lets a render be skipped.
    expect(nextPageTabMenu(CLOSED_PAGE_TAB_MENU, { type: "escape" })).toBeNull();
  });

  it("closes on a pointerdown OUTSIDE the menu", () => {
    expect(nextPageTabMenu("page:a", { type: "pointerdown", insideMenu: false })).toBeNull();
  });

  it("survives a pointerdown INSIDE the menu", () => {
    // THE LESSON canvas/dock/dock.ts's `insideWidget` RECORDS, carried over
    // rather than re-learned: the menu is portalled to <body>, so a containment
    // check that knew only about the tab would read every press on the menu's
    // OWN buttons as "outside" and dismiss on the way DOWN, before the click
    // that operates the item ever arrived.
    expect(nextPageTabMenu("page:a", { type: "pointerdown", insideMenu: true })).toBe("page:a");
  });

  it("closes once an item has been run", () => {
    // THE OPPOSITE CALL FROM THE POPOVER'S, deliberately. `nextPageMenuOpen`
    // keeps the popover open through rename/delete because it is a management
    // LIST worked several rows at a time. This is a context menu on one tab:
    // both of its items are one-shot, and after a delete the tab it hangs off
    // does not exist any more.
    expect(nextPageTabMenu("page:a", { type: "acted" })).toBeNull();
  });
});

describe("pageTabMenuFocusReturn — where focus goes when the menu shuts", () => {
  const escape: PageTabMenuEvent = { type: "escape" };
  const acted: PageTabMenuEvent = { type: "acted" };
  const outside: PageTabMenuEvent = { type: "pointerdown", insideMenu: false };

  it("sends focus back to the tab when Escape closed the menu", () => {
    expect(pageTabMenuFocusReturn("page:a", null, escape)).toBe("page:a");
  });

  it("sends focus back to the tab when an item was run", () => {
    // Rename and delete both go through a `window.prompt`/`window.confirm`,
    // which returns focus to the document rather than to anything of ours.
    // INFERRED FROM THE MODAL-DIALOG SEMANTICS, NOT OBSERVED.
    expect(pageTabMenuFocusReturn("page:a", null, acted)).toBe("page:a");
  });

  it("does NOT steal focus back after an outside click", () => {
    // The same judgement the Pages popover already makes: an outside click has
    // already put focus somewhere the user chose, and yanking it back to a tab
    // they were leaving is the one dismissal that cannot restore focus
    // honestly.
    expect(pageTabMenuFocusReturn("page:a", null, outside)).toBeNull();
  });

  it("does not move focus when the menu did not actually close", () => {
    expect(pageTabMenuFocusReturn("page:a", "page:b", { type: "open", id: "page:b" })).toBeNull();
    expect(pageTabMenuFocusReturn("page:a", "page:a", { type: "pointerdown", insideMenu: true })).toBeNull();
  });

  it("does not move focus when nothing was open to begin with", () => {
    expect(pageTabMenuFocusReturn(null, null, escape)).toBeNull();
  });
});

describe("decideTabContextMenuKey — the keyboard way in", () => {
  it("accepts the dedicated context-menu key, with or without Shift", () => {
    // The menu must not be pointer-only: a keyboard user reaching a tab with
    // Tab has to be able to raise the same two items.
    expect(decideTabContextMenuKey({ key: "ContextMenu", shiftKey: false })).toBe(true);
    expect(decideTabContextMenuKey({ key: "ContextMenu", shiftKey: true })).toBe(true);
  });

  it("accepts Shift+F10, the keyboard the context-menu key stands in for", () => {
    expect(decideTabContextMenuKey({ key: "F10", shiftKey: true })).toBe(true);
  });

  it("REFUSES a bare F10 — that is the platform's menu-bar key, not ours", () => {
    // The negative half, and the one a mutation reaches for: dropping the
    // `shiftKey` test makes every F10 anywhere on a focused tab open this
    // menu.
    expect(decideTabContextMenuKey({ key: "F10", shiftKey: false })).toBe(false);
  });

  it("refuses every other key, shifted or not", () => {
    for (const key of ["Enter", " ", "Escape", "F9", "F11", "Delete", "M", "ArrowDown"]) {
      expect(decideTabContextMenuKey({ key, shiftKey: false })).toBe(false);
      expect(decideTabContextMenuKey({ key, shiftKey: true })).toBe(false);
    }
  });
});

describe("where the menu lands — placement is popover-place.ts's, not a second clamp", () => {
  it("opens DOWNWARD from a tab at the top of the column", () => {
    // THE ABSOLUTE ASSERTION, not a relative one: the tab strip moved to the
    // TOP of the canvas column on 2026-09-06, so "below the tab" is the
    // direction the menu has to take, and a rule expressed only against the
    // constants would not say whether the constants themselves put it there.
    //
    // A tab 28px tall sitting 8px down a 1200x800 viewport, with a 160x88 menu.
    const box = placePopoverBox({
      anchorLeft: 100,
      anchorRight: 200,
      anchorTop: 8,
      anchorBottom: 36,
      popoverWidth: 160,
      popoverHeight: 88,
      viewportWidth: 1200,
      viewportHeight: 800,
    });
    // Right-aligned to the tab (200 - 160), hung `POPOVER_ANCHOR_GAP_PX` below
    // its bottom edge (36 + 6). Both stated as the literal numbers a browser
    // would draw, so a change to either constant has to be argued here.
    expect(box).toEqual({ left: 40, top: 42 });
    // ...and, said as the fact it exists to establish: DOWN, not up.
    expect(box.top).toBeGreaterThan(36);
    expect(box.top).toBe(36 + POPOVER_ANCHOR_GAP_PX);
  });

  it("still clamps a tab near the right edge back inside the margin", () => {
    // Not a second clamp of this file's own — the same one, reached through
    // the same function. A tab at the far right of a narrow column would
    // otherwise hang the menu off the screen.
    const box = placePopoverBox({
      anchorLeft: 360,
      anchorRight: 396,
      anchorTop: 8,
      anchorBottom: 36,
      popoverWidth: 160,
      popoverHeight: 88,
      viewportWidth: 400,
      viewportHeight: 800,
    });
    expect(box.left).toBe(400 - POPOVER_EDGE_MARGIN_PX - 160);
    expect(box.left).toBe(232);
  });
});

describe("NO_POPOVER_ANCHOR — what an anchorless popover hangs from", () => {
  // WHY THIS EXISTS NOW. The Pages BUTTON left the toolbar in the same change
  // that added this menu (owner request 2026-09-06), and it was the popover's
  // anchor. On a column too narrow for the tab strip
  // (canvas/pages/page-tabs-fit.ts) there is now no anchor element at all, and
  // the popover is still reachable — the command palette's "Canvas: go to
  // page…" opens it. The component used to answer that case with an inline
  // `if (!anchor) return;`, which left the box wherever it was last placed:
  // a decision written where no test in this jsdom-free project could read it.
  it("is a rect of non-measurements, so the module's own fallback runs", () => {
    expect(Number.isFinite(NO_POPOVER_ANCHOR.anchorLeft)).toBe(false);
    expect(Number.isFinite(NO_POPOVER_ANCHOR.anchorRight)).toBe(false);
    expect(Number.isFinite(NO_POPOVER_ANCHOR.anchorTop)).toBe(false);
    expect(Number.isFinite(NO_POPOVER_ANCHOR.anchorBottom)).toBe(false);
  });

  it("places the box in the safe corner, on-screen and obviously detached", () => {
    // ABSOLUTE, not relative: (8, 8). The corner is not a good position — it is
    // the only one that is certainly visible, which makes an anchorless open a
    // visible oddity rather than an invisible disappearance.
    expect(
      placePopoverBox({
        ...NO_POPOVER_ANCHOR,
        popoverWidth: 320,
        popoverHeight: 420,
        viewportWidth: 1200,
        viewportHeight: 800,
      }),
    ).toEqual({ left: 8, top: 8 });
    expect(POPOVER_EDGE_MARGIN_PX).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING. Source text only, comment-stripped, bounded per region, and every
// positive paired with a negative so two constants cannot simply swap roles.

const SWITCHER = stripComments([
  "switcher/tab-menu-view.tsx",
  "switcher/tab-menu.ts",
  "switcher/page-tabs.tsx",
  "switcher/page-menu-view.tsx",
  "switcher/page-menu.tsx",
  "switcher/dom.ts",
  "switcher/use-page-switcher.tsx",
  "switcher/actions.ts",
  "switcher/styles.ts",
].map((file) => readFileSync(new URL(`../canvas/pages/${file}`, import.meta.url), "utf8")).join("\n"));
const PANEL = stripComments(
  readFileSync(new URL("../canvas/panel/session-view.tsx", import.meta.url), "utf8"),
);

/** The context menu's own JSX: from its marker to the tab strip that follows
 * it. Bounding here is what stops the Pages POPOVER's rename/delete buttons
 * from being what satisfies an assertion about THIS menu. */
function menuRegion(): string {
  const from = SWITCHER.indexOf("data-canvas-page-tab-menu\n");
  const to = SWITCHER.indexOf("data-canvas-page-tabs");
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return SWITCHER.slice(from, to);
}

/** One tab button's own props — the same slice tests/tab-drag.test.ts takes. */
function tabButtonRegion(): string {
  const from = SWITCHER.indexOf("data-canvas-page-tab={row.id}");
  const to = SWITCHER.indexOf("data-canvas-new-page-tab");
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return SWITCHER.slice(from, to);
}

/** The tab's own `onContextMenu` body, from its arrow to the handler that
 * follows it. BOUNDED, because the tab now carries TWO handlers that call
 * `event.preventDefault()` and a file-wide match cannot say which — deleting
 * the one in here (so a browser menu opens on top of ours) survived a
 * `toMatch(/event\.preventDefault\(\);/)` on the whole tab on 2026-09-06. */
function contextMenuHandler(): string {
  const tab = SWITCHER.indexOf("data-canvas-page-tab={row.id}");
  expect(tab).toBeGreaterThan(-1);
  const from = SWITCHER.indexOf("onContextMenu={(event) => {", tab);
  expect(from).toBeGreaterThan(-1);
  const to = SWITCHER.indexOf("onKeyDown=", from);
  expect(from).toBeGreaterThan(tab);
  expect(to).toBeGreaterThan(from);
  return SWITCHER.slice(from, to);
}

/** The TAB's own `onKeyDown` body — the keyboard way in.
 *
 * SEARCHED FROM INSIDE THE TAB, NOT FROM THE TOP OF THE FILE: the Pages
 * popover's FILTER INPUT also has an `onKeyDown={(event) => {`, it comes first,
 * and a guard that landed on it would be asserting things about Enter-to-jump
 * while the tab had no keyboard path at all. */
function keyDownHandler(): string {
  const tab = SWITCHER.indexOf("data-canvas-page-tab={row.id}");
  expect(tab).toBeGreaterThan(-1);
  const from = SWITCHER.indexOf("onKeyDown={(event) => {", tab);
  expect(from).toBeGreaterThan(tab);
  const to = SWITCHER.indexOf("onClick=", from);
  expect(to).toBeGreaterThan(from);
  return SWITCHER.slice(from, to);
}

/** The `openTabMenu` handler, from its declaration to its dependency array. */
function openHandler(): string {
  const from = SWITCHER.indexOf("const openTabMenu = useCallback(");
  expect(from).toBeGreaterThan(-1);
  const to = SWITCHER.indexOf("[dispatchDrag, dispatchTabMenu]", from);
  expect(to).toBeGreaterThan(from);
  return SWITCHER.slice(from, to);
}

describe("the toolbar no longer carries a Pages button", () => {
  it("is gone from the panel entirely", () => {
    // Owner request 2026-09-06: "Lets remove the page selector from the control
    // bar." The toolbar is the tool buttons and the self-name chip.
    expect(countInCode(PANEL, "{pageSwitcher.button}")).toBe(0);
    expect(countInCode(PANEL, "pageSwitcher.button")).toBe(0);
  });

  it("takes its own button node away too, rather than rendering it out of sight", () => {
    // A node that is built and never placed is a control that still owns focus
    // order and still has to be kept correct. The hook hands back the strip and
    // the <body> overlays, and nothing else.
    expect(countInCode(SWITCHER, "data-canvas-page-menu-button")).toBe(0);
    expect(countInCode(SWITCHER, "pageMenuButtonLabel(")).toBe(0);
    expect(SWITCHER).toMatch(/return\s*\{\s*tabs,\s*overlays\s*\}/);
  });

  it("keeps the popover itself, and the palette door that opens it", () => {
    // TWO REASONS, and the second is the load-bearing one.
    //   1. Typing a name to jump is the fast path tabs cannot offer once there
    //      are many pages.
    //   2. It is the KEYBOARD path to REORDERING. Task 1 made reordering a
    //      pointer drag with no keyboard equivalent; the popover's ◂ / ▸
    //      buttons are the only way to reorder without a pointer, so deleting
    //      it would be a straight accessibility regression.
    expect(countInCode(SWITCHER, "data-canvas-page-menu")).toBeGreaterThan(0);
    expect(countInCode(SWITCHER, "pageDoor.setOpener(")).toBe(1);
    expect(countInCode(PANEL, "{pageSwitcher.overlays}")).toBe(1);
  });

  it("places the popover against the module's anchorless rule when no anchor exists", () => {
    // The `if (!anchor) return` that used to sit here is gone: with the button
    // removed the anchor is legitimately absent on a narrow column, and
    // "leave the box where it was" is not an answer a test could read.
    expect(countInCode(SWITCHER, "NO_POPOVER_ANCHOR")).toBeGreaterThan(0);
    expect(SWITCHER).not.toMatch(/if\s*\(!anchor\s*\|\|\s*!popover\)\s*return;/);
  });
});

describe("the tab strip raises the menu, and never decides it", () => {
  it("opens on a right-click, through the module's own gate", () => {
    // TWO STATEMENTS, BOUNDED TO THIS ONE HANDLER. Our menu replaces the
    // browser's, so the default is suppressed UNCONDITIONALLY — no `if`, no
    // guard, no early return above it — and WHETHER OURS OPENS is
    // `openTabMenu`'s question to ask (see the drag block below). A
    // `preventDefault` that went missing here would let a browser menu open on
    // top of ours, and one moved inside a guard would hand a reorder in flight
    // the browser's menu as a consolation prize.
    const handler = contextMenuHandler();
    const prevent = handler.indexOf("event.preventDefault();");
    const opens = handler.indexOf("openTabMenu(row.id)");
    expect(prevent).toBeGreaterThan(-1);
    expect(opens).toBeGreaterThan(prevent);
    // Nothing between the arrow and the suppression, and no branch around it.
    expect(handler.slice(0, prevent)).toMatch(/onContextMenu=\{\(event\)\s*=>\s*\{\s*$/);
    expect(handler).not.toMatch(/\bif\s*\(/);
    expect(handler).not.toMatch(/\breturn\b/);
    // The id, not the index: an index would name whichever page happens to sit
    // in that slot after a reorder.
    expect(handler).not.toMatch(/openTabMenu\(index/);
  });

  it("offers the keyboard way in, decided by the module", () => {
    const handler = keyDownHandler();
    // The gate is the module's answer, negated — every other keystroke on a
    // focused tab has to pass straight through to the browser and to bb.
    expect(handler).toMatch(/if\s*\(!decideTabContextMenuKey\(event\)\)\s*return;/);
    expect(handler).toMatch(/event\.preventDefault\(\);/);
    expect(handler).toMatch(/openTabMenu\(row\.id\)/);
    // NOT the un-negated form: `if (decideTabContextMenuKey(event)) return;`
    // typechecks, reads almost identically, and makes the one key that should
    // open the menu the only key that cannot.
    expect(handler).not.toMatch(/if\s*\(decideTabContextMenuKey\(event\)\)\s*return;/);
    // No inline key comparison: "which key" is the decision, and a `"F10"`
    // written here is one nothing in this project can read.
    const tab = tabButtonRegion();
    expect(tab).not.toMatch(/event\.key\s*===/);
    expect(tab).not.toMatch(/"ContextMenu"/);
    expect(tab).not.toMatch(/"F10"/);
  });

  it("keeps every gesture the tab already had", () => {
    // The menu is a FIFTH gesture on one control; none of the other four may
    // have been traded for it.
    const tab = tabButtonRegion();
    expect(tab).toMatch(/onDoubleClick=\{\(\)\s*=>\s*rename\(row\)\}/);
    expect(tab).toMatch(/onPointerDown=\{\(event\)\s*=>\s*beginTabDrag\(event,\s*index,\s*row\.id\)\}/);
    expect(tab).toMatch(/\{\s*type:\s*"click",\s*index,\s*id:\s*row\.id,?\s*\}/);
  });

  it("holds the tab elements so focus can be handed back to one", () => {
    // PINNED BY ADJACENCY rather than by region: the ref is written on the tab
    // button's opening tag, ABOVE the marker `tabButtonRegion` starts at, so
    // the slice cannot see it. Requiring the two to be within a few characters
    // of each other is what says the ref is on THIS element.
    const hold = SWITCHER.indexOf("ref={(node) => holdTabRef(row.id, node)}");
    const tab = SWITCHER.indexOf("data-canvas-page-tab={row.id}");
    expect(hold).toBeGreaterThan(-1);
    expect(tab).toBeGreaterThan(hold);
    expect(tab - hold).toBeLessThan(80);
    // Keyed by the page ID, never by the index: a reorder changes every index,
    // and a menu placed against "whatever is in slot 2 now" is placed against
    // the wrong tab.
    expect(SWITCHER).not.toMatch(/holdTabRef\(index/);
    // PARSED, NOT COUNTED. `countInCode(SWITCHER, "pageTabMenuFocusReturn(")`
    // stood here, asserting the call appears exactly once — and on 2026-09-06
    // `if (back !== null) tabRefs.current.get(back)?.focus();` was replaced by
    // `if (back !== null) void back;` with the whole suite green. The call
    // survives, its ANSWER is discarded, and focus never comes back to the tab
    // after Escape or after an item runs. A count cannot see a value being
    // thrown away. What is kept here is the half a count CAN carry — that there
    // is exactly one such call, asked the right three things, in the right
    // roles (`before` then `next`: read the other way round the module can
    // never see a close). What the component DOES with the answer is
    // "hands focus back to the tab, not merely asks where it should go" below.
    expect(callsTo(SWITCHER, "pageTabMenuFocusReturn").map((call) => call.text)).toEqual([
      "pageTabMenuFocusReturn(before, next, event)",
    ]);
  });
});

describe("opening the menu takes the gesture off the drag", () => {
  it("refuses to open over a reorder in flight, and says so through the rule", () => {
    // 2c: right-click must never start or leave a drag, and a menu over a tab
    // that is currently following the pointer is both a broken-looking overlay
    // and a second, unasked-for effect from one gesture.
    const open = openHandler();
    // PARSED, NOT REGEXED, AND THIS GUARD IS THE SECOND VERSION OF ITSELF.
    //
    //   v1 was `toMatch(call) + toMatch(/return;/)` and fell to
    //     `if (false && tabDragBlocksContextMenu(dragRef.current)) return;`
    //   v2 captured the whole condition with `/if\s*\((.*?)\)\s*return;/` over
    //     this handler's TEXT REGION, and fell on 2026-09-06 to a decoy —
    //     `const shape = (): void => { if (tabDragBlocksContextMenu(dragRef.current)) return; }; void shape;`
    //     which contains the guard's exact captured text, is never called, and
    //     leaves the menu opening over every reorder in flight. Suite green.
    //
    // A decoy can put the text anywhere in the region; it cannot put it back in
    // the list of statements the handler actually RUNS, in the order it runs
    // them. So the assertion is that list, in full — which also carries what
    // the neighbouring test says about the order, and would fail on a fourth
    // statement smuggled in beside these three.
    expect(bodyStatements(SWITCHER, "openTabMenu")).toEqual([
      "if (tabDragBlocksContextMenu(dragRef.current)) return;",
      'dispatchDrag({ type: "context-menu" });',
      'dispatchTabMenu({ type: "open", id });',
    ]);
    // Read from the REF, not from the rendered state: pointer events arrive
    // faster than React re-renders, so a stale `dragState` would let a menu
    // open over a drag that had already armed.
    expect(open).not.toMatch(/tabDragBlocksContextMenu\(dragState\)/);
  });

  it("cancels the in-flight press before it opens anything", () => {
    // A stationary long press is `pressed` (tab-drag.ts has no timer), so the
    // touch context-menu gesture arrives with a live press behind it. Handing
    // that press to the machine as `context-menu` is what stops the pointerup
    // and click that follow from ALSO switching the page under the new menu.
    const open = openHandler();
    const cancelAt = open.indexOf('{ type: "context-menu" }');
    const openAt = open.indexOf('{ type: "open"');
    expect(cancelAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(cancelAt);
    // The drag is told, and the menu is told — one dispatch to each, not the
    // same one twice.
    expect(open).toMatch(/dispatchDrag\(\{\s*type:\s*"context-menu",?\s*\}\)/);
    expect(open).toMatch(/dispatchTabMenu\(\{\s*type:\s*"open",\s*id\s*\}\)/);
  });
});

describe("the menu's own items are the module's, and its delete is the popover's", () => {
  it("draws whatever the rule returned, with the rule's own enabled flag", () => {
    const menu = menuRegion();
    expect(countInCode(SWITCHER, "pageTabMenuItems(")).toBe(1);
    expect(menu).toMatch(/\{item\.label\}/);
    expect(menu).toMatch(/disabled=\{!item\.enabled\}/);
    // NOT re-derived from the row. `canDelete` written here would be a second
    // copy of the rule, free to disagree with the one this file's tests drive.
    expect(menu).not.toContain("canDelete");
    expect(menu).not.toMatch(/disabled=\{!row\./);
    // ...and not inverted, which is the mutation `disabled={!x}` invites.
    expect(menu).not.toMatch(/disabled=\{item\.enabled\}/);
  });

  it("routes delete through the SAME handler the popover uses", () => {
    // "Do not fork a second delete path": `remove` is the one that asks
    // `deletePageIntents` first and hands its emptiness to `pageDeletePrompt`,
    // which is what stops a single-page doc being asked to authorise a no-op.
    // A second call site here that did its own thing would reopen that bug on
    // the surface most people will now use.
    expect(countInCode(SWITCHER, "remove(row)")).toBe(2);
    expect(countInCode(SWITCHER, "deletePageIntents(")).toBe(1);
    expect(countInCode(SWITCHER, "pageDeletePrompt(")).toBe(1);
    expect(countInCode(SWITCHER, "window.confirm(")).toBe(1);
  });

  it("routes rename through the SAME handler too", () => {
    expect(countInCode(SWITCHER, "renamePageIntents(")).toBe(1);
    expect(countInCode(SWITCHER, "window.prompt(")).toBe(1);
  });

  it("interprets the item id rather than branching on the row", () => {
    const args = callArguments(SWITCHER, "const runTabMenuItem = useCallback");
    expect(args).toContain('id === "rename"');
    expect(args).toContain('id === "delete"');
    expect(args).toMatch(/rename\(row\)/);
    expect(args).toMatch(/remove\(row\)/);
    // The two must not have swapped: rename is never the destructive one.
    expect(args).not.toMatch(/id === "rename"\)\s*remove/);
    expect(args).not.toMatch(/id === "delete"\)\s*rename/);
  });

  it("closes itself after an item runs", () => {
    const args = callArguments(SWITCHER, "const runTabMenuItem = useCallback");
    expect(args).toMatch(/dispatchTabMenu\(\{\s*type:\s*"acted",?\s*\}\)/);
  });

  it("names the menu after the page, for a reader without eyes", () => {
    const menu = menuRegion();
    expect(menu).toMatch(/aria-label=\{pageTabMenuLabel\(/);
    expect(menu).toMatch(/role="menu"/);
    expect(menu).toMatch(/role="menuitem"/);
  });

  it("places itself with the shared function and declares no clamp of its own", () => {
    // "Do not write a second clamp" — the flip, the margins and the edge
    // behaviour are all popover-place.ts's, reached through the same call the
    // Pages popover makes.
    expect(countInCode(SWITCHER, "placePopoverBox(")).toBe(2);
    expect(SWITCHER).not.toMatch(/Math\.min\(Math\.max\(/);
    expect(SWITCHER).not.toMatch(/window\.innerWidth\s*-\s*[0-9]/);
  });

  it("takes its layer from the shared constant, like every other body popover", () => {
    const menu = menuRegion();
    expect(menu).not.toMatch(/zIndex:\s*[0-9]/);
    expect(countInCode(SWITCHER, "zIndex: POPOVER_Z_INDEX")).toBe(2);
  });

  it("is portalled to <body>, out of every ancestor's overflow", () => {
    expect(countInCode(SWITCHER, "createPortal(")).toBe(2);
    expect(countInCode(SWITCHER, "document.body")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING SEAMS. Every guard above this line asks "does this text appear in
// the .tsx?" — and on 2026-09-06 a validator walked these five mutations of the
// menu's hands past a green 43-file / 1067-test suite and a clean
// `tsc --noEmit`. In each one the decision module is still imported, still
// called, still perfect, and the menu is broken:
//
//   * `onClick={() => runTabMenuItem(tabMenuRow, item.id)}` -> `onClick={() => undefined}`
//     — a flawless handler nothing calls; every item does nothing;
//   * `<>{popover}{tabMenu}</>` -> `<>{popover}{false ? tabMenu : null}</>`
//     — the menu built and never rendered. The guard at the top of this file
//     catches exactly this for the REMOVED Pages button and never caught it for
//     the node that replaced it;
//   * the dismissal `useEffect` DELETED whole — Escape and outside-click stop
//     closing the menu, while `nextPageTabMenu`'s branches stay fully tested;
//   * the focus `useLayoutEffect` DELETED — focus never lands in the menu on
//     open (the now-unused import does not fail the build);
//   * `anchorOf(tabRefs.current.get(tabMenuOpenId) ?? null)` -> `anchorOf(stripRef.current)`
//     in the placement effect — every menu opens against the whole strip
//     instead of its tab, while `countInCode(SWITCHER, "placePopoverBox(") === 2`
//     goes on saying the shared function is called twice.
//
// What fails on all five is a question about SHAPE: which expression an
// attribute of a named element holds, what a variable is actually initialised
// to, which effect the COMPONENT ITSELF runs, which statements that effect
// runs, and which whole argument a real call site is handed.
//
// AND THE DECOY CLIMBS. The first version of the three guards below asked those
// questions one level too high, and a second pass on 2026-09-06 walked three
// more mutations past them, all still green at 43 files / 1077 tests and
// `tsc --noEmit` 0:
//
//   * the two `document.addEventListener` calls moved into
//     `const register = (): void => { … }; void register;` INSIDE the surviving
//     dismissal effect — `callsTo` is reachability-blind (it reports every call
//     the parser can see, called or not), so its assertion stayed exactly true
//     while the menu bound nothing;
//   * the focus `useLayoutEffect`, byte-for-byte unchanged, wrapped in
//     `const focusOnOpen = (): void => { … }; void focusOnOpen;` — an EXACT
//     match on the effect's own text cannot see that React never runs it;
//   * `anchorLeft: 0, anchorRight: 0, anchorTop: 0, anchorBottom: 0,` written
//     after the correct `...anchorOf(tab)` spread — `PopoverAnchor` is exactly
//     those four fields, so the right anchor is computed and totally discarded
//     while a guard on the `anchorOf` call alone stays green.
//
// tests/lib/source.ts's `jsxAttributes`, `initializerText`, `topLevelEffectIn`,
// `effectStatements`, `bodyStatements` and `callsTo` ask the parser the
// level-by-level version instead — the statement is in the effect, the effect
// is in the component body, the whole argument object is the one intended — so
// a comment, a string literal, a discarded value or an uncalled decoy cannot
// answer them.
describe("the panel's wiring seams — the menu is CONNECTED, not merely built", () => {
  it("hangs each item's click on the handler that runs it", () => {
    // BOUNDED TO THE ELEMENT, not to the file. Every other guard in reach is
    // about `runTabMenuItem`'s BODY, and a perfect handler nothing calls is a
    // menu whose items do nothing. `jsxAttributes` throws unless exactly one
    // element carries the marker, so this cannot be reading a second-best match.
    const item = jsxAttributes(SWITCHER, "data-canvas-page-tab-menu-item");
    expect(item.onClick).toBe("() => runTabMenuItem(row, item.id)");
    // The two arguments are two different roles — the ROW the menu is about and
    // the ITEM that was clicked. Passed the other way round this still
    // typechecks at the JSX level and would rename by item id.
    expect(item["data-canvas-page-tab-menu-item"]).toBe("item.id");
    expect(item.disabled).toBe("!item.enabled");
  });

  it("renders the menu it built, beside the popover and behind no condition", () => {
    // `{false ? tabMenu : null}` builds the whole menu, keeps every guard about
    // its contents green, and never puts it on the screen. No `toContain` on
    // the file can tell that apart from the real thing — the file mentions
    // `tabMenu` either way. Bounded to the initializer, an EXACT match is
    // available and every conditional fails it.
    expect(initializerText(SWITCHER, "overlays").replace(/\s+/g, " ").trim()).toBe(
      "<>{popover}{tabMenu}</>",
    );
  });

  it("runs the dismissal rules from a real effect, on real document listeners", () => {
    // `nextPageTabMenu`'s escape/pointerdown branches are unit-tested directly
    // above; NOTHING asserted the component ever dispatches them, and deleting
    // this effect whole — listeners, containment check and both dispatches —
    // left the suite green.
    //
    // TOP-LEVEL, not merely present. An effect nested inside a closure the
    // component never calls is an effect React never runs, and no assertion
    // about the call's TEXT can tell the two apart; only its position in
    // `usePageSwitcher`'s own statement list can.
    const dismissal = topLevelEffectIn(
      SWITCHER,
      "useTabMenu",
      'dispatchTabMenu({ type: "escape" })',
    );
    // REGISTERED BY THE EFFECT ITSELF. `callsTo` is reachability-blind — it
    // returns every call the parser sees, called or not — so moving these two
    // into `const register = (): void => { … }; void register;` inside this
    // surviving effect kept a `callsTo` assertion green while the menu bound
    // nothing and stopped closing on Escape or on an outside click
    // (2026-09-06). The effect's own top-level statement list is the only
    // question a dead closure cannot answer.
    const statements = effectStatements(dismissal).map((statement) =>
      statement.replace(/\s+/g, " ").trim(),
    );
    expect(statements).toContain('document.addEventListener("pointerdown", onPointerDown);');
    expect(statements).toContain('document.addEventListener("keydown", onKeyDown);');
    // ...and the pairing teardown is the effect's OWN return, so both come down
    // again: a listener added and never removed is a menu that keeps dismissing
    // after it has closed.
    expect(statements[statements.length - 1]).toBe(
      "return () => { document.removeEventListener(\"pointerdown\", onPointerDown); " +
        'document.removeEventListener("keydown", onKeyDown); };',
    );
    // ...and each listener's own statements, so a body emptied out inside a
    // surviving effect fails too. Bounded to THIS effect's text, because the
    // Pages popover has an `onKeyDown` and an `onPointerDown` of its own.
    expect(bodyStatements(dismissal, "onKeyDown")).toEqual([
      'if (event.key !== "Escape") return;',
      'dispatchTabMenu({ type: "escape" });',
    ]);
    expect(
      bodyStatements(dismissal, "onPointerDown").map((statement) =>
        statement.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual([
      "const target = event.target;",
      'dispatchTabMenu({ type: "pointerdown", insideMenu: target instanceof Node && insideMenu(target), });',
    ]);
    // The containment check names the menu ITSELF as well as its descendants —
    // the menu is portalled to <body>, so `contains` alone reads every press on
    // one of its own buttons as "outside" and dismisses on the way DOWN.
    expect(bodyStatements(dismissal, "insideMenu")).toEqual([
      "const menu = menuRef.current;",
      "return menu !== null && (node === menu || menu.contains(node));",
    ]);
  });

  it("moves focus into the menu when it opens", () => {
    // Deleting this effect leaves `pageTabMenuFocusItem` fully unit-tested and
    // the menu opening with focus still on the tab behind it — a keyboard user
    // has to Tab into a menu they just asked for.
    //
    // TWO SEPARATE CLAIMS, and the first one is the one that was missing. An
    // exact match on the effect's own text does NOT prove React runs it:
    // wrapping this whole `useLayoutEffect` — byte-for-byte unchanged — in
    // `const focusOnOpen = (): void => { … }; void focusOnOpen;` kept that
    // match green while focus stayed on the tab behind the menu (2026-09-06).
    // `topLevelEffectIn` demands the effect be a statement of the component's
    // own body, which is what React actually executes; the exact text then
    // says the effect still does the right thing.
    expect(
      topLevelEffectIn(SWITCHER, "useTabMenu", "pageTabMenuFocusItem")
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe(
      'useLayoutEffect(() => { if (tabMenuOpenId === null) return; ' +
        "const first = pageTabMenuFocusItem(tabMenuItems); if (first === null) return; " +
        "menuRef.current ?.querySelector<HTMLButtonElement>(`[data-canvas-page-tab-menu-item=\"${first}\"]`) ?.focus(); " +
        "}, [tabMenuOpenId, tabMenuItems])",
    );
  });

  it("hands focus back to the tab, not merely asks where it should go", () => {
    // THE VALUE-DISCARDING ATTACK. `if (back !== null) void back;` keeps the
    // `pageTabMenuFocusReturn` call, keeps its count at one, keeps the `!== null`
    // test, typechecks — and focus never returns to the tab after Escape or
    // after an item runs. Only the statement list of the handler that runs it
    // can see the answer being dropped, and the list also pins the write order
    // the ref-plus-state pair depends on: the ref first (document-level
    // listeners close over their render's values), the state second.
    expect(bodyStatements(SWITCHER, "dispatchTabMenu")).toEqual([
      "const before = tabMenuRef.current;",
      "const next = nextPageTabMenu(before, event);",
      "tabMenuRef.current = next;",
      "setTabMenuOpenId(next);",
      "const back = pageTabMenuFocusReturn(before, next, event);",
      "if (back !== null) tabRefs.current.get(back)?.focus();",
    ]);
  });

  it("anchors the menu to its TAB, and the popover to the STRIP", () => {
    // `countInCode(SWITCHER, "placePopoverBox(") === 2` above says only that the
    // shared function is called twice — never against WHAT. Re-aiming the
    // menu's anchor at `stripRef.current` keeps that count, keeps the flip and
    // the clamps popover-place.ts owns, and opens every tab's menu against the
    // whole strip instead of the tab it belongs to.
    //
    // THE WHOLE ARGUMENT, not just the anchor call inside it. `PopoverAnchor`
    // is exactly the four fields the spread supplies (canvas/dock/
    // popover-place.ts), so `anchorLeft: 0, anchorRight: 0, anchorTop: 0,
    // anchorBottom: 0,` written after the spread overrides ALL of it: the right
    // anchor is computed and thrown away, and every menu opens clamped into the
    // top-left corner. An assertion that only looks at the `anchorOf` call
    // cannot see that (2026-09-06) — an exact match on `placePopoverBox`'s own
    // argument object can, and it also pins the viewport pair that the flip
    // decision is made against. Bounded to each placement effect, so the two
    // anchors cannot swap or collapse into one, and taken from the component's
    // own statement list so a placement effect moved into a dead closure fails.
    const placement = (needle: string): string =>
      callsTo(topLevelEffectIn(SWITCHER, needle === "setTabMenuBox(" ? "useTabMenu" : "usePageMenu", needle), "placePopoverBox")
        .map((call) => call.text.replace(/\s+/g, " ").trim())
        .join(" | ");
    expect(placement("setTabMenuBox(")).toBe(
      "placePopoverBox({ ...anchorOf(tabRefs.current.get(tabMenuOpenId) ?? null), " +
        "popoverWidth: menu.width, popoverHeight: menu.height, " +
        "viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, })",
    );
    expect(placement("setBox(")).toBe(
      "placePopoverBox({ ...anchorOf(stripRef.current), " +
        "popoverWidth: popover.width, popoverHeight: popover.height, " +
        "viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, })",
    );
    // ...and there is no third anchor site to disagree with either of them.
    expect(callsTo(SWITCHER, "anchorOf")).toHaveLength(2);
  });
});
