// Run: npx vitest run tests/page-switcher-tabs.test.ts
//
// THE SPLIT BETWEEN THE TAB STRIP AND THE PAGES POPOVER.
//
// Owner request, 2026-09-05: "lets make the 'pages' look like tabs; and remove
// the buttons that move them left, right or delete them from the display. just
// make the page name look like a tab."
//
// "From the display" is the TAB STRIP. The popover is a list, not tabs, and it
// KEEPS rename / move-left / move-right / delete — for one load-bearing reason
// that this file exists to make mechanical: reordering pages is about to
// become a POINTER DRAG (task 2), which no keyboard can perform. Strip the
// popover's move buttons too and page reordering becomes pointer-only, which
// is an accessibility regression, not a simplification. The popover is what
// keeps reorder and delete keyboard-reachable.
//
// WHY A SOURCE READ. No jsdom here, so the rendered tree is unobservable. What
// is checkable is the file's CODE (comments stripped — see
// tests/source-guard.test.ts's header on why raw text is not a guard), bounded
// to each surface's own region so "the popover still has a delete button"
// cannot be what satisfies "the tab strip has no delete button".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countInCode, stripComments } from "./lib/source.js";

const SWITCHER = stripComments([
  "switcher/page-menu-view.tsx",
  "switcher/page-tabs.tsx",
  "switcher/actions.ts",
  "switcher/tab-menu.ts",
  "switcher/use-page-switcher.tsx",
  "switcher/styles.ts",
].map((file) => readFileSync(new URL(`../canvas/pages/${file}`, import.meta.url), "utf8")).join("\n"));
const TABS = stripComments(
  readFileSync(new URL("../canvas/pages/switcher/page-tabs.tsx", import.meta.url), "utf8"),
);

/** The popover's JSX: from the portalled dialog's marker to the `document.body`
 * argument that closes `createPortal`. */
function popoverRegion(): string {
  const from = SWITCHER.indexOf("data-canvas-page-menu\n");
  const to = SWITCHER.indexOf("document.body");
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return SWITCHER.slice(from, to);
}

/** The tab strip's JSX: from its marker to the hook's return.
 *
 * THE TAB'S OWN CONTEXT MENU IS DELIBERATELY OUTSIDE THIS SLICE. It is declared
 * ahead of the strip (between the popover's `document.body` and
 * `data-canvas-page-tabs`), so "the strip carries no delete control" below
 * still means the STRIP — the menu that hangs off a tab on right-click is a
 * different surface with its own file, tests/page-tab-menu.test.ts. */
function tabsRegion(): string {
  const from = TABS.indexOf("data-canvas-page-tabs");
  const to = TABS.length;
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return TABS.slice(from, to);
}

describe("the tab strip shows a name and nothing else", () => {
  it("still names every page with the existing hook", () => {
    const tabs = tabsRegion();
    expect(tabs).toMatch(/data-canvas-page-tab=\{row\.id\}/);
    expect(tabs).toMatch(/\{row\.name\}/);
    expect(tabs).toMatch(/data-canvas-new-page-tab/);
  });

  it("carries no move or delete control", () => {
    // The whole of the owner's request, expressed against the code rather
    // than the prose: neither the labels nor the handlers survive here.
    // Still true after the context menu landed on 2026-09-06 — a right-click
    // is not a control drawn in the strip, and the menu it raises is drawn
    // somewhere else entirely (on <body>, out of this slice).
    const tabs = tabsRegion();
    expect(tabs).not.toContain("Move ");
    expect(tabs).not.toContain("Delete ");
    expect(tabs).not.toMatch(/move\(row/);
    expect(tabs).not.toMatch(/remove\(row/);
    expect(tabs).not.toContain("canMoveLeft");
    expect(tabs).not.toContain("canMoveRight");
    expect(tabs).not.toContain("canDelete");
  });

  it("keeps double-click-to-rename on the tab itself", () => {
    // An affordance nobody asked to remove, and the one task 2's drag has to
    // coexist with.
    expect(tabsRegion()).toMatch(/onDoubleClick=\{\(\)\s*=>\s*rename\(row\)\}/);
  });

  it("still says which tab is the current one, to a screen reader", () => {
    // "Tab-shaped" is a look; `aria-pressed` is the part of it that survives
    // having no eyes.
    expect(tabsRegion()).toMatch(/aria-pressed=\{row\.current\}/);
  });

  it("shapes the tab from `current`, so one tab joins the card and the rest recede", () => {
    expect(tabsRegion()).toMatch(/pageTabStyle\(row\.current\)/);
  });

  it("scrolls rather than wrapping, because the page list is unbounded", () => {
    // The opposite answer from the toolbar's (canvas/pages/chrome-dock.ts's
    // CHROME_DOCK_TOOLBAR_OVERFLOW = "wrap"), and deliberately: the toolbar
    // holds a fixed handful of controls, so a second line ends the problem,
    // while pages are unbounded and wrapping them would grow the floating card
    // until it ate the canvas.
    expect(SWITCHER).toMatch(/overflowX:\s*"auto"/);
  });
});

describe("the popover keeps the full management surface", () => {
  it("still offers rename, both moves and delete", () => {
    const popover = popoverRegion();
    expect(popover).toMatch(/Rename \$\{row\.name\}/);
    expect(popover).toMatch(/Move \$\{row\.name\} left/);
    expect(popover).toMatch(/Move \$\{row\.name\} right/);
    expect(popover).toMatch(/Delete \$\{row\.name\}/);
  });

  it("wires each of them to the intent helpers", () => {
    const popover = popoverRegion();
    expect(popover).toMatch(/onClick=\{\(\)\s*=>\s*rename\(row\)\}/);
    expect(popover).toMatch(/onClick=\{\(\)\s*=>\s*move\(row,\s*"left"\)\}/);
    expect(popover).toMatch(/onClick=\{\(\)\s*=>\s*move\(row,\s*"right"\)\}/);
    expect(popover).toMatch(/onClick=\{\(\)\s*=>\s*remove\(row\)\}/);
  });

  it("keeps them keyboard-reachable — real buttons, disabled not hidden", () => {
    // `disabled` rather than a conditional render is what keeps the control in
    // the tab order and tells a screen reader WHY it cannot be used. Hiding
    // them would leave a keyboard user with no path to reorder at all once the
    // tab strip's drag is the only other way.
    const popover = popoverRegion();
    expect(popover).toMatch(/disabled=\{!row\.canMoveLeft\}/);
    expect(popover).toMatch(/disabled=\{!row\.canMoveRight\}/);
    expect(popover).toMatch(/disabled=\{!row\.canDelete\}/);
  });

  it("is the only place the MOVE handlers are called from", () => {
    // If a second call site appears, this file's region bounds stop meaning
    // what they say — so the count is pinned rather than assumed.
    expect(countInCode(SWITCHER, "move(row,")).toBe(2);
    // ...and both of them are the popover's. Reordering has no other surface
    // than this and the pointer drag, which is exactly why these two buttons
    // may not be removed.
    expect(countInCode(popoverRegion(), "move(row,")).toBe(2);
  });

  it("shares its rename and delete handlers with the tab context menu, and no one else", () => {
    // TWO CALL SITES EACH, and the second is `runTabMenuItem`
    // (tests/page-tab-menu.test.ts pins that end). SHARED rather than forked
    // on purpose: `remove` is the handler that asks `deletePageIntents` first
    // and hands its emptiness to `pageDeletePrompt`, which is what stops a
    // single-page document being asked to authorise a delete that was already
    // refused.
    expect(countInCode(SWITCHER, "remove(row)")).toBe(2);
    expect(countInCode(popoverRegion(), "remove(row)")).toBe(1);
    expect(countInCode(SWITCHER, "window.confirm(")).toBe(1);
    expect(countInCode(SWITCHER, "window.prompt(")).toBe(1);
  });
});

describe("one palette, declared once", () => {
  it("takes its colours from the shared chrome module", () => {
    // The floating card is drawn by CanvasPanel.tsx and the tabs sitting on it
    // by this file. Two files writing their own literals is how the presence
    // popover ended up with a font nobody chose; a shared import is the fix,
    // and this is what keeps it shared.
    expect(SWITCHER).toMatch(/from "\.\.\/chrome-dock\.js"/);
  });

  it("declares no colour of its own", () => {
    expect(SWITCHER.match(/#[0-9a-fA-F]{3}/g) ?? []).toEqual([]);
    expect(SWITCHER.match(/rgba?\(/g) ?? []).toEqual([]);
  });
});
