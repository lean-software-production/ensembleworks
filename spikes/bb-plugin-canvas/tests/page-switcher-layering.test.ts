// Run: npx vitest run tests/page-switcher-layering.test.ts
//
// WHICH LAYER THE PAGE POPOVER PAINTS ON — a policy, therefore not a number in
// a .tsx.
//
// The page switcher's popover is portalled to <body> as `position: fixed`, the
// same arrangement the presence dock's popover reached on 2026-09-02. That
// arrangement is the ONLY one in which choosing a z-index chooses an answer
// (canvas/dock/styles.ts's `#canvas-av-dock-popover` block spells this out: on
// <body> there is no positioned ancestor left to resolve against, so the number
// is compared in the root stacking context). Having reached that point, this
// plugin already recorded which number, and why:
//
//   "WHY NOT HIGHER. bb's dialogs, popovers and command palette sit at 50+ …
//    an overlay that cannot be dismissed by the thing on top of it is a trap.
//    WHY NOT LOWER: the whole point of leaving the pane is to be paintable
//    over it."   — canvas/dock/styles.ts, the z-index note
//
// The page popover is the same KIND of thing as the presence popover — plugin
// chrome hanging off a plugin control — so it gets the same answer, from the
// same constant, and this file is what makes "the same" mechanical rather than
// a resemblance two files happen to share today.
//
// WHAT IS AND IS NOT ESTABLISHED HERE. That bb's modal layers sit at 50+ is
// INHERITED BELIEF, carried in canvas/dock/styles.ts and never measured — there
// is no browser in this spike. What this test can honestly check is agreement:
// the constant the React inline style uses is the constant the stylesheet
// writes, it sits under the recorded modal floor, and no DOM file quietly picks
// its own.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BB_MODAL_LAYER_FLOOR,
  POPOVER_Z_INDEX,
} from "../canvas/dock/popover-place.js";
import { DOCK_STYLES } from "../canvas/dock/styles.js";
import { CHROME_DOCK_Z_INDEX } from "../canvas/pages/chrome-dock.js";

const SWITCHER = readFileSync(
  new URL("../canvas/pages/PageSwitcher.tsx", import.meta.url),
  "utf8",
);

describe("POPOVER_Z_INDEX — one number for every <body>-portalled plugin popover", () => {
  it("sits below the modal floor bb's own dialogs and palette are recorded at", () => {
    // THE FAILURE THIS FORBIDS, concretely: the user opens the page popover,
    // then opens bb's command palette from the keyboard. No pointerdown ever
    // fires, so the popover's outside-click dismissal never runs; if the
    // popover outranks the palette the user is left reading page names on top
    // of the thing they just asked for, with no way to dismiss it. That is
    // exactly the trap canvas/dock/styles.ts refuses.
    expect(POPOVER_Z_INDEX).toBeLessThan(BB_MODAL_LAYER_FLOOR);
  });

  it("sits above 0, because escaping the pane is only worth it to paint over it", () => {
    expect(POPOVER_Z_INDEX).toBeGreaterThan(0);
  });

  it("is the number the dock's stylesheet actually writes", () => {
    // The drift guard. Two popovers on <body> at two different z-indexes would
    // mean one of them silently lost a decision the other made.
    const block = /#canvas-av-dock-popover\s*\{([\s\S]*?)\}/.exec(DOCK_STYLES);
    expect(block).not.toBeNull();
    const declared = /z-index:\s*(\d+)\s*;/.exec(block?.[1] ?? "");
    expect(declared).not.toBeNull();
    expect(Number(declared?.[1])).toBe(POPOVER_Z_INDEX);
  });
});

describe("the page switcher does not pick its own layer", () => {
  it("declares no numeric z-index of its own", () => {
    // A z-index literal in a .tsx is a layering policy in a file no test can
    // reach — this spike has no jsdom, so the number could be changed to
    // anything in either direction and every test would stay green. The .tsx
    // may only NAME the constant.
    const literals = SWITCHER.match(/zIndex:\s*[0-9]/g) ?? [];
    expect(literals).toEqual([]);
  });

  it("uses the shared constant", () => {
    expect(SWITCHER).toContain("zIndex: POPOVER_Z_INDEX");
  });
});

// ---------------------------------------------------------------------------
// THE FLOATING CHROME JOINS THE SAME LADDER (2026-09-05).
//
// The toolbar and the page tabs left the column's flow and now float over the
// drawing surface, which makes them a THIRD layered thing in this plugin — and
// the first one that is NOT portalled to <body>. Its number is pinned here,
// beside the other two, because a layer chosen in isolation is how the page
// popover originally arrived carrying 2147483000.
describe("the floating chrome dock's layer", () => {
  it("sits under the popovers it anchors, which sit under bb's modals", () => {
    // One ordered ladder, asserted as a chain so that moving any rung past
    // another fails here rather than in a browser nobody has.
    expect(0).toBeLessThan(CHROME_DOCK_Z_INDEX);
    expect(CHROME_DOCK_Z_INDEX).toBeLessThan(POPOVER_Z_INDEX);
    expect(POPOVER_Z_INDEX).toBeLessThan(BB_MODAL_LAYER_FLOOR);
  });

  it("is not a number the panel picked for itself", () => {
    const panel = readFileSync(
      new URL("../canvas/panel/shared.ts", import.meta.url),
      "utf8",
    ) + readFileSync(new URL("../canvas/panel/session-view.tsx", import.meta.url), "utf8");
    expect(panel.match(/zIndex:\s*[0-9]/g) ?? []).toEqual([]);
    expect(panel).toContain("zIndex: CHROME_DOCK_Z_INDEX");
  });
});
