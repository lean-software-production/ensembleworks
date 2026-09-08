// Run: npx vitest run tests/chrome-dock.test.ts
//
// THE FLOATING CHROME — where the toolbar and the page tabs go once they stop
// being rows in the canvas column, and what they let through.
//
// Owner request, 2026-09-05: "can we make the command palette something that
// floats over the canvas; perhaps docked at the bottom?" and "lets make the
// 'pages' look like tabs". The two rows of chrome that used to sit ABOVE the
// drawing surface (a toolbar row, plus a width-gated tab row) leave the
// vertical flow entirely and become one bottom-centred group over a full-bleed
// canvas — the tldraw/Figma arrangement.
//
// WHY EVERY NUMBER BELOW IS IN A MODULE AND NOT IN THE .tsx. Same reason
// canvas/pages/page-tabs-fit.ts and canvas/dock/squeeze.ts give in their
// headers: this project has no jsdom and may not gain one, so an offset, a
// layer or a visibility rule written inline in a component is one no test can
// ever read, and a validator can move it in either direction with the whole
// suite green. Nothing here was seen in a browser.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countInCode, stripComments } from "./lib/source.js";
import {
  BB_MODAL_LAYER_FLOOR,
  POPOVER_Z_INDEX,
} from "../canvas/dock/popover-place.js";
import {
  CHROME_DOCK_EDGE_GAP_PX,
  CHROME_DOCK_POINTER_EVENTS,
  CHROME_DOCK_TOOLBAR_OVERFLOW,
  CHROME_DOCK_Z_INDEX,
} from "../canvas/pages/chrome-dock.js";

const PANEL = stripComments(
  readFileSync(new URL("../canvas/panel/shared.ts", import.meta.url), "utf8") +
    readFileSync(new URL("../canvas/panel/session-view.tsx", import.meta.url), "utf8"),
);
/** The module's own source. Read so the deletion of the fit ladder can be
 * asserted at BOTH ends: a dead export left behind here is a policy nothing
 * applies, and the next reader cannot tell that from a live one. */
const MODULE = stripComments(
  readFileSync(new URL("../canvas/pages/chrome-dock.ts", import.meta.url), "utf8"),
);

describe("CHROME_DOCK_POINTER_EVENTS — the dead-strip guard", () => {
  it("lets the wrapper pass pointers through and only the card take them", () => {
    // THE REGRESSION THIS FORBIDS. The floating group is stretched across the
    // bottom of the drawing surface so its card can be centred. If that
    // stretched wrapper takes pointer events, the whole bottom band of the
    // canvas silently stops drawing — a gesture that starts there hits the
    // wrapper instead of <Viewport>, and no test in this project can see it,
    // because the failure is a hit-test in a browser we do not have.
    expect(CHROME_DOCK_POINTER_EVENTS.wrapper).toBe("none");
    expect(CHROME_DOCK_POINTER_EVENTS.card).toBe("auto");
  });
});

describe("CHROME_DOCK_Z_INDEX — the floating chrome's layer", () => {
  it("paints over the canvas rather than under it", () => {
    expect(CHROME_DOCK_Z_INDEX).toBeGreaterThan(0);
  });

  it("stays under the <body>-portalled popovers it anchors", () => {
    // The Pages popover hangs off a button in this card and, when it cannot
    // fit above, canvas/dock/popover-place.ts's clamp slides it back DOWN over
    // the anchor (its "bottom margin wins" rule). If the card outranked the
    // popover, the page list would be painted over by the bar that opened it.
    expect(CHROME_DOCK_Z_INDEX).toBeLessThan(POPOVER_Z_INDEX);
  });

  it("stays under the layer bb's own dialogs are recorded at", () => {
    expect(CHROME_DOCK_Z_INDEX).toBeLessThan(BB_MODAL_LAYER_FLOOR);
  });
});

describe("CHROME_DOCK_EDGE_GAP_PX", () => {
  it("is a real gap, so the card never sits flush in the corner", () => {
    expect(CHROME_DOCK_EDGE_GAP_PX).toBeGreaterThan(0);
    expect(Number.isFinite(CHROME_DOCK_EDGE_GAP_PX)).toBe(true);
  });
});

describe("CHROME_DOCK_TOOLBAR_OVERFLOW — wider than the panel", () => {
  it("wraps rather than scrolling or clipping", () => {
    // The toolbar's contents are a BOUNDED set (Pages + six tools + a chip),
    // so a second line ends the problem. Scrolling would hide controls behind
    // a gesture nobody knows is available, and hiding would delete them.
    expect(CHROME_DOCK_TOOLBAR_OVERFLOW).toBe("wrap");
  });
});

describe("the bar has no width ladder, because it has nothing to drop", () => {
  // OWNER REQUEST, 2026-09-08: "Please remove the presence icon from the
  // control bar." The chip — your own name and the colour peers see your cursor
  // in — was the ONE thing the fit ladder dropped on a narrow panel; every
  // CONTROL was always drawn at both fits. With the chip gone the ladder has no
  // subject, so `ChromeDockFit`, `chooseChromeDockFit`, `nextChromeDockFit`,
  // `chromeDockShowsSelfName` and their two widths were deleted rather than
  // left as a policy about nothing.
  //
  // WHERE SELF-IDENTITY LIVES NOW: nowhere in this bar. It was never the only
  // copy — the peer's own cursor carries the same name and colour, which is
  // what the chip existed to be matched against.
  it("names no fit anywhere in the module or the panel", () => {
    for (const gone of [
      "ChromeDockFit",
      "chooseChromeDockFit",
      "nextChromeDockFit",
      "chromeDockShowsSelfName",
      "CHROME_DOCK_FULL_MIN_PX",
      "CHROME_DOCK_HYSTERESIS_PX",
    ]) {
      expect(countInCode(MODULE, gone)).toBe(0);
      expect(countInCode(PANEL, gone)).toBe(0);
    }
    expect(countInCode(PANEL, "chromeFit")).toBe(0);
  });

  it("draws no self-name chip", () => {
    expect(countInCode(PANEL, "data-canvas-self-name")).toBe(0);
    expect(countInCode(PANEL, "chromeSelfNameStyle")).toBe(0);
    // The chip was the only reader of the name->colour map in this file; a
    // leftover import is the tell that only the markup was deleted.
    expect(countInCode(PANEL, "colorForName")).toBe(0);
  });

  it("still draws every tool button, ungated", () => {
    // The point of the deletion is that nothing in the bar is width-dependent
    // any more. A new `if` around a control would have to come back through
    // this module.
    expect(countInCode(PANEL, "TOOL_BUTTONS.map(")).toBe(1);
  });
});

/** The floating wrapper's own style object — from the `const` that declares it
 * to its closing brace. Bounding assertions to it is what stops a rule
 * belonging to some other box from satisfying them. */
function chromeStyle(): string {
  const from = PANEL.indexOf("const chromeWrapperStyle");
  const to = PANEL.indexOf("};", from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return PANEL.slice(from, to);
}

/** The same slice for the CARD COLUMN — the box that starts taking clicks
 * again inside the pass-through wrapper.
 *
 * WHY BOTH SLICES EXIST. A file-wide `pointerEvents: …\.wrapper` /
 * `…\.card` pair says only that both names appear SOMEWHERE; it cannot say
 * which box got which, so swapping the two lines satisfies it. That swap is
 * exactly the dead-strip regression: the stretched wrapper takes `auto` and
 * eats every gesture in the bottom band of the canvas, while the card
 * inherits `none` and stops responding to clicks at all. */
function chromeCardStyle(): string {
  const from = PANEL.indexOf("const chromeCardColumnStyle");
  const to = PANEL.indexOf("};", from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return PANEL.slice(from, to);
}

describe("the panel's wiring of the floating chrome", () => {
  // WHY SOURCE READS. No jsdom, so what CanvasPanel.tsx actually renders is
  // unobservable; what can be pinned is that it NAMES these decisions instead
  // of re-making them, and that the two chrome rows really did leave the
  // column's flow.

  it("draws the chrome dock exactly once", () => {
    expect(countInCode(PANEL, "data-canvas-chrome-dock")).toBe(1);
  });

  it("puts the chrome AFTER the viewport element, not above it in the column", () => {
    // This is the float, mechanically. The group is a SIBLING of the
    // `data-canvas-viewport` box and comes after it, so the flex column has
    // exactly one in-flow child and the drawing surface gets the whole of it;
    // a chrome row still in the flow would appear BEFORE this marker, which is
    // where both of them used to be.
    //
    // A SIBLING RATHER THAN A CHILD ON PURPOSE: the panel's keyboard fallback
    // bails when the event target is inside `viewportRef`, so a tool button
    // moved inside that box would have every shortcut typed from it swallowed
    // by both handlers.
    const viewport = PANEL.indexOf("<CanvasSurface");
    const dock = PANEL.indexOf("data-canvas-chrome-dock");
    expect(viewport).toBeGreaterThan(-1);
    expect(dock).toBeGreaterThan(viewport);
    // …and it is out of the flow rather than merely last in it.
    expect(chromeStyle()).toMatch(/position:\s*"absolute"\s*,/);
  });

  it("carries ONLY the tools — no chip and no page surface float with them", () => {
    const dock = PANEL.indexOf("data-canvas-chrome-dock");
    const tabs = PANEL.indexOf("{pageSwitcher.tabs}");
    expect(countInCode(PANEL, "{pageSwitcher.tabs}")).toBe(1);
    // OWNER REQUEST 2026-09-06, reversing the previous arrangement: "The tabs
    // should be at the top (where the control bar used to be); not attached to
    // the floating control bar at the bottom." So the tabs render BEFORE the
    // dock — the dock is now the toolbar alone.
    expect(tabs).toBeLessThan(dock);
    // OWNER REQUEST, same day: "Lets remove the page selector from the control
    // bar." The "Pages: <name>" button is gone from the bar and from the hook,
    // so there is nothing left to be in the wrong place.
    expect(countInCode(PANEL, "pageSwitcher.button")).toBe(0);
  });

  it("mounts the switcher's <body> surfaces OUTSIDE the tab strip's width gate", () => {
    // The popover and a tab's context menu are `createPortal`s, so where this
    // node sits in the column is immaterial — but WHETHER it is rendered at all
    // is not. Inside the gate `tabs` is behind, the popover would stop existing
    // on a narrow column, which is precisely where it matters most: the
    // command palette's "Canvas: go to page…" is then the ONLY page surface,
    // and its ◂ / ▸ buttons are the only keyboard path to reordering.
    expect(countInCode(PANEL, "{pageSwitcher.overlays}")).toBe(1);
    const overlays = PANEL.indexOf("{pageSwitcher.overlays}");
    const tabs = PANEL.indexOf("{pageSwitcher.tabs}");
    expect(overlays).toBeGreaterThan(tabs);
    // Not nested inside the tab ROW either — that div is where the gated strip
    // goes, and this must not share its fate.
    const row = PANEL.indexOf("data-canvas-page-tab-row");
    const viewport = PANEL.indexOf("<CanvasSurface");
    expect(row).toBeLessThan(viewport);
    expect(overlays).toBeGreaterThan(viewport);
  });

  it("puts the page tabs in the FLOW at the top of the column, above the viewport", () => {
    const tabs = PANEL.indexOf("{pageSwitcher.tabs}");
    const viewport = PANEL.indexOf("<CanvasSurface");
    expect(tabs).toBeGreaterThan(-1);
    expect(viewport).toBeGreaterThan(-1);
    // In the flow AND first: the strip takes its own height back off the
    // canvas (which is exactly what "where the control bar used to be" means)
    // rather than floating over it.
    expect(tabs).toBeLessThan(viewport);
    expect(countInCode(PANEL, "data-canvas-page-tab-row")).toBe(1);
    const row = PANEL.indexOf("data-canvas-page-tab-row");
    expect(row).toBeLessThan(tabs);
    // The row must NOT be absolutely positioned — that would put it back over
    // the canvas instead of above it, which is the thing being undone here.
    const from = PANEL.indexOf("const chromeTabRowStyle");
    expect(from).toBeGreaterThan(-1);
    const slice = PANEL.slice(from, PANEL.indexOf("};", from));
    expect(slice).not.toMatch(/position:\s*"absolute"/);
    expect(slice).toMatch(/flexShrink:\s*0/);
  });

  it("names the pointer-events policy rather than writing one", () => {
    // BOUNDED TO EACH BOX, not to the file: which style object gets which
    // half of the policy IS the policy. See chromeCardStyle()'s header for
    // what an unbounded pair lets through.
    expect(chromeStyle()).toMatch(/pointerEvents:\s*CHROME_DOCK_POINTER_EVENTS\.wrapper\s*,/);
    expect(chromeStyle()).not.toMatch(/CHROME_DOCK_POINTER_EVENTS\.card/);
    expect(chromeCardStyle()).toMatch(/pointerEvents:\s*CHROME_DOCK_POINTER_EVENTS\.card\s*,/);
    expect(chromeCardStyle()).not.toMatch(/CHROME_DOCK_POINTER_EVENTS\.wrapper/);
    // A literal here is the dead-strip bug written where nothing can read it.
    expect(PANEL).not.toMatch(/pointerEvents:\s*["']/);
  });

  it("names the layer rather than picking one", () => {
    expect(PANEL).toMatch(/zIndex:\s*CHROME_DOCK_Z_INDEX\s*[,}]/);
    expect(PANEL.match(/zIndex:\s*[0-9]/g) ?? []).toEqual([]);
  });

  it("names the edge gap rather than writing offsets", () => {
    // Bottom-centred: pinned to the bottom edge, and stretched left-to-right
    // by the same gap so the card can centre itself inside it. Bounded to the
    // wrapper's own style object — a file-wide match would be satisfied by any
    // other rule that happened to mention the constant.
    const style = chromeStyle();
    expect(style).toMatch(/bottom:\s*CHROME_DOCK_EDGE_GAP_PX\s*,/);
    expect(style).toMatch(/left:\s*CHROME_DOCK_EDGE_GAP_PX\s*,/);
    expect(style).toMatch(/right:\s*CHROME_DOCK_EDGE_GAP_PX\s*,/);
    expect(style).toMatch(/justifyContent:\s*"center"\s*,/);
  });

  it("names the overflow answer rather than guessing in CSS", () => {
    expect(PANEL).toMatch(/flexWrap:\s*CHROME_DOCK_TOOLBAR_OVERFLOW\s*[,}]/);
  });
});
