// Run: npx vitest run tests/page-tabs-fit.test.ts
//
// TASK C1a, the third surface — whether the ported tab bar is drawn at all.
// Design doc D-2: the tab bar is a WIDE-VIEWPORT-ONLY affordance, because
// ported unchanged it costs a permanent header row on exactly the narrow
// panels the dock's squeeze ladder exists to defend. The threshold and the
// show/hide decision are policy and live in canvas/pages/page-tabs-fit.ts, not
// in a .tsx where no test can reach them — the same split canvas/dock/
// squeeze.ts makes, for the same reason.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countInCode, stripComments } from "./lib/source.js";
import {
  PAGE_TABS_HYSTERESIS_PX,
  PAGE_TABS_MIN_PX,
  choosePageTabsVisible,
  nextPageTabsVisible,
} from "../canvas/pages/page-tabs-fit.js";

// THE ONE NAME THE TWO HALVES OF THE WIRING MEET AT. CanvasPanel writes
// `containerWidth: <its state>` and usePageSwitcher reads `containerWidth` off
// its input; the two source guards below check opposite ends of that same
// handover, so the key is declared once here rather than spelled out twice.
// Renaming the prop in only one of the two files then fails a guard instead of
// silently unhooking them (tsc would catch that particular rename too — this
// keeps the guards' own soundness from resting on a check run by a different
// command, the same reason the "declared exactly once" test below exists).
const FED_PROP = "containerWidth";

describe("choosePageTabsVisible — the first decision, with no history", () => {
  it("shows the tabs at the threshold and above", () => {
    expect(choosePageTabsVisible(PAGE_TABS_MIN_PX)).toBe(true);
    expect(choosePageTabsVisible(PAGE_TABS_MIN_PX + 400)).toBe(true);
  });

  it("hides them one pixel below it", () => {
    expect(choosePageTabsVisible(PAGE_TABS_MIN_PX - 1)).toBe(false);
  });

  it("hides them for anything that is not a measurement", () => {
    // 0 is what a detached or not-yet-laid-out element reports, and the first
    // render measures before the ResizeObserver has ever fired. The two
    // failures are not symmetrical: a tab bar that failed to appear is
    // recoverable from the Pages button, which is always drawn, while a tab
    // bar drawn on a phone-width panel eats canvas height nobody can get back.
    for (const width of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(choosePageTabsVisible(width)).toBe(false);
    }
  });
});

describe("nextPageTabsVisible — the sticky decision", () => {
  it("needs a full band above the threshold before it appears", () => {
    expect(nextPageTabsVisible(false, PAGE_TABS_MIN_PX)).toBe(false);
    expect(nextPageTabsVisible(false, PAGE_TABS_MIN_PX + PAGE_TABS_HYSTERESIS_PX - 1)).toBe(false);
    expect(nextPageTabsVisible(false, PAGE_TABS_MIN_PX + PAGE_TABS_HYSTERESIS_PX)).toBe(true);
  });

  it("needs a full band below the threshold before it goes", () => {
    expect(nextPageTabsVisible(true, PAGE_TABS_MIN_PX - 1)).toBe(true);
    expect(nextPageTabsVisible(true, PAGE_TABS_MIN_PX - PAGE_TABS_HYSTERESIS_PX)).toBe(true);
    expect(nextPageTabsVisible(true, PAGE_TABS_MIN_PX - PAGE_TABS_HYSTERESIS_PX - 1)).toBe(false);
  });

  it("holds whatever is on screen for a width that is not a measurement", () => {
    // A failed read must never be the reason a row appears or disappears.
    for (const width of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(nextPageTabsVisible(true, width)).toBe(true);
      expect(nextPageTabsVisible(false, width)).toBe(false);
    }
  });

  it("gives the whole band to whatever was already drawn", () => {
    // The property the band exists for: a divider parked ON the threshold, or
    // a scrollbar appearing and disappearing, must not strobe the row in and
    // out at frame rate.
    for (
      let width = PAGE_TABS_MIN_PX - PAGE_TABS_HYSTERESIS_PX;
      width <= PAGE_TABS_MIN_PX + PAGE_TABS_HYSTERESIS_PX - 1;
      width += 1
    ) {
      expect(nextPageTabsVisible(true, width)).toBe(true);
      expect(nextPageTabsVisible(false, width)).toBe(false);
    }
  });

  // OWNER BUG 2026-09-06: "i'm not seeing the tabs at all". The threshold was
  // set when the tab strip was a SECOND row of chrome stacked on the floating
  // toolbar and competing for vertical space; the Pages button covered the
  // same capability, so hiding the row early was cheap. The strip is now the
  // PRIMARY page navigation, in the flow at the top of the column, so hiding
  // it on an ordinary panel width is the wrong default — and because the seed
  // is `false` (columnWidth starts at 0, before any measurement), the width
  // that actually reveals the row is MIN + HYSTERESIS, not MIN.
  //
  // These are ABSOLUTE widths on purpose. Every other assertion in this file
  // is written relative to PAGE_TABS_MIN_PX and therefore says nothing about
  // whether the constant itself is a sane number — which is exactly how a
  // 768px reveal threshold shipped without a failing test.
  it("reveals the row at ordinary canvas widths, from a cold start", () => {
    // A bb panel with the sidebar open, no thread aside: a few hundred px.
    expect(nextPageTabsVisible(false, 480)).toBe(true);
    // Narrower still — a thread aside open beside the canvas.
    expect(nextPageTabsVisible(false, 420)).toBe(true);
  });

  it("still hides the row when the column is too narrow to seat a tab", () => {
    expect(nextPageTabsVisible(false, 280)).toBe(false);
  });

  it("is idempotent — feeding it its own answer never flips it", () => {
    for (let width = 200; width <= 1600; width += 7) {
      const once = nextPageTabsVisible(choosePageTabsVisible(width), width);
      expect(nextPageTabsVisible(once, width)).toBe(once);
    }
  });

  it("agrees with the historyless answer once the width is a band clear of the threshold", () => {
    expect(nextPageTabsVisible(true, PAGE_TABS_MIN_PX + PAGE_TABS_HYSTERESIS_PX)).toBe(
      choosePageTabsVisible(PAGE_TABS_MIN_PX + PAGE_TABS_HYSTERESIS_PX),
    );
    expect(nextPageTabsVisible(false, PAGE_TABS_MIN_PX - PAGE_TABS_HYSTERESIS_PX - 1)).toBe(
      choosePageTabsVisible(PAGE_TABS_MIN_PX - PAGE_TABS_HYSTERESIS_PX - 1),
    );
  });
});

describe("the width the panel actually feeds this gate", () => {
  // WHY A SOURCE READ AND NOT A BEHAVIOUR TEST. There is no jsdom here, so the
  // panel's wiring cannot be rendered; what CAN be checked is that the width
  // handed to the gate is the kind of number the gate's contract is written
  // for. This matters because the module's whole safety argument —
  // `choosePageTabsVisible` hides the row for anything that is not a
  // measurement, so a phone-width panel never has a row flash onto it — is void
  // if the caller substitutes a plausible-looking default before calling.
  //
  // CanvasPanel keeps exactly such a default: `viewportSize` starts at
  // 1024x768 and its ResizeObserver reads `element.clientWidth || 1024`, both
  // deliberately, because SHAPE CULLING against a zero rect culls everything.
  // 1024 is comfortably over PAGE_TABS_MIN_PX, so feeding that state to this
  // gate makes the first render on a phone answer "wide enough".
  // READ AS CODE, NEVER AS RAW TEXT. Every assertion below runs against
  // `stripComments(PANEL)`, for the reason tests/source-guard.test.ts's header
  // gives at length: a guard reading a .tsx as one flat string is satisfied by
  // that file's own prose, and the prose is exactly where the wiring gets
  // described. Found by review on 2026-09-05 against THIS block: with
  // `useState(0)` mutated to `useState(1024)` the guard below correctly failed,
  // but adding a single commented-out `// const [columnWidth, setColumnWidth] =
  // useState(0);` line above the mutation put it back to 12 passed — a decoy
  // in a comment, with the real initial width 1024 and the 768/672 that
  // page-tabs-fit.ts's header states in caps silently false.
  const PANEL = stripComments(
    readFileSync(new URL("../canvas/panel/session.tsx", import.meta.url), "utf8") +
      readFileSync(new URL("../canvas/panel/session-viewport.ts", import.meta.url), "utf8") +
      readFileSync(new URL("../canvas/panel/session-pages.ts", import.meta.url), "utf8"),
  );
  const fed = new RegExp(`${FED_PROP}:\\s*([A-Za-z0-9_.]+)`).exec(PANEL);

  it("is passed at all", () => {
    expect(fed).not.toBeNull();
  });

  it("starts at 0 — 'nothing has been measured yet' — rather than at a guess", () => {
    const name = fed?.[1] ?? "";
    expect(name).not.toContain(".");
    expect(PANEL).toMatch(new RegExp(`const \\[${name}, set[A-Za-z]+\\] = useState\\(0\\)`));
  });

  it("is declared exactly once, so no second initialiser can shadow the first", () => {
    // The guard above asks "does a `useState(0)` declaration of this name
    // exist", which a file holding BOTH that and a later `useState(1024)`
    // would still satisfy. Two `const` declarations of one name in one scope
    // is a TypeScript error, so `npx tsc --noEmit` already refuses it — this
    // states the property here too rather than leaving this guard's soundness
    // resting on a check run by a different command.
    const name = fed?.[1] ?? "";
    const declarations =
      PANEL.match(new RegExp(`const \\[${name}, set[A-Za-z]+\\] = useState\\(`, "g")) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it("is never given the culling fallback", () => {
    const name = fed?.[1] ?? "";
    const setter = new RegExp(`set[A-Za-z]*\\(\\s*[^;]*\\|\\|\\s*\\d`, "g");
    const substituted = (PANEL.match(setter) ?? []).join("\n");
    expect(substituted).not.toContain(name);
  });
});

describe("what usePageSwitcher does with the width the panel feeds it", () => {
  // WHY A SECOND SOURCE READ, ON THE OTHER END OF THE SAME WIRE. The block
  // above pins the PANEL half of the chain — `columnWidth` starts at 0 and is
  // handed over unmodified. It says nothing about what the hook receiving it
  // does, and until 2026-09-05 nothing did.
  //
  // VERIFIED BY MUTATION, 2026-09-05, before this block existed: replacing
  // usePageSwitcher's `useState(() => choosePageTabsVisible(containerWidth))`
  // with `useState(true)` AND its width-change effect body with `void
  // containerWidth;` — which reduces canvas/pages/page-tabs-fit.ts to dead code
  // outright — reported 39 files / 819 tests passed and `tsc` exit 0,
  // byte-identical to the unmutated baseline. Each mutation alone was green
  // too, as was dropping the `!tabsVisible ? null :` gate from the tab bar and
  // swapping the effect to call `choosePageTabsVisible` (no hysteresis).
  //
  // WHAT IS LOST WHEN THIS IS UNPINNED. `useState(true)` alone draws the ported
  // tab row on the first frame of EVERY bb panel, phone-width ones included —
  // the asymmetric failure page-tabs-fit.ts's header calls out, since a row
  // that eats canvas height has no affordance to get it back. It also makes
  // that header's headline claim false: the row would start visible and hide
  // at 671, so the observable numbers would not be 768 and 672.
  //
  // READ AS CODE, NEVER AS RAW TEXT, for the reason tests/source-guard.test.ts
  // gives at length. Checked, so as not to overstate it: PageSwitcher.tsx's
  // prose does NOT currently spell out either call — its header names the
  // MODULE (`canvas/pages/page-tabs-fit.ts`) and its `containerWidth` doc
  // comment points at it — so today a raw read would fail on the same four
  // mutations. Stripping is here because that is one comment away from being
  // untrue, in the file whose header exists to describe this exact wiring, and
  // a guard satisfied by a decoy is how the panel-side block above was found
  // unfalsifiable on 2026-09-05.
  const SWITCHER = stripComments(
    readFileSync(new URL("../canvas/pages/PageSwitcher.tsx", import.meta.url), "utf8"),
  );

  // Group 1: the state's name. Group 2: the setter's suffix. Group 3: the
  // identifier the seed is computed from — the whole point of the guard.
  const init =
    /const \[([A-Za-z0-9_]+), set([A-Za-z0-9_]+)\]\s*=\s*useState\(\(\)\s*=>\s*choosePageTabsVisible\(([A-Za-z0-9_]+)\)\)/.exec(
      SWITCHER,
    );

  it("receives the width under the same prop name the panel writes", () => {
    // This is the join between the two guards: the block above proves the
    // panel writes `containerWidth: <a state that starts at 0>`, and this
    // proves the hook's `containerWidth` is a plain input it destructures
    // rather than something it recomputes or defaults on the way in.
    expect(SWITCHER).toMatch(new RegExp(`readonly\\s+${FED_PROP}:\\s*number;`));
    expect(SWITCHER).toMatch(new RegExp(`const \\{[^}]*\\b${FED_PROP}\\b[^}]*\\}\\s*=\\s*input;`));
  });

  it("seeds the tab-bar state from choosePageTabsVisible(<the fed width>), not from a literal", () => {
    expect(init).not.toBeNull();
    expect(init?.[3]).toBe(FED_PROP);
  });

  it("asks the historyless question exactly once — seeding is its only job here", () => {
    // Two calls would mean some later decision skipped the hysteresis band and
    // re-answered from scratch, which is how the 768/672 the module's header
    // promises collapse back to a bare 720 edge that strobes on a divider drag.
    expect(countInCode(SWITCHER, "choosePageTabsVisible(")).toBe(1);
  });

  it("re-decides on every width change through nextPageTabsVisible(<what is drawn>, <the fed width>)", () => {
    const setter = `set${init?.[2] ?? ""}`;
    // The backreference pins that the value handed to nextPageTabsVisible as
    // "what is currently drawn" is the updater's own previous-state argument —
    // passing anything else there is what makes the band stop being sticky.
    expect(SWITCHER).toMatch(
      new RegExp(
        `useEffect\\(\\(\\)\\s*=>\\s*\\{\\s*${setter}\\(\\(([A-Za-z0-9_]+)\\)\\s*=>\\s*` +
          `nextPageTabsVisible\\(\\1,\\s*${FED_PROP}\\)\\);?\\s*\\},\\s*\\[${FED_PROP}\\]\\)`,
      ),
    );
    expect(countInCode(SWITCHER, "nextPageTabsVisible(")).toBe(1);
  });

  it("gates the tab bar node itself on that state", () => {
    // Both halves above can be intact and the row still drawn unconditionally,
    // because nothing forces the state to be consulted at the render site.
    const name = init?.[1] ?? "";
    const gate = new RegExp(`const tabs\\s*=\\s*!${name}\\s*\\?\\s*null\\s*:`);
    expect(SWITCHER).toMatch(gate);
    // …and that the thing behind the gate is the tab bar, not some other
    // node that happens to be assigned to a variable called `tabs`.
    expect(countInCode(SWITCHER, "data-canvas-page-tabs")).toBe(1);
    const at = gate.exec(SWITCHER)?.index ?? -1;
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(SWITCHER.indexOf("data-canvas-page-tabs"));
  });
});
