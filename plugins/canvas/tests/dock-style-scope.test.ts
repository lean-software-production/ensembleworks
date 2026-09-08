// Run: npx vitest run tests/dock-style-scope.test.ts
//
// WHAT THIS FILE IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT.
//
// The popover moved out of `#canvas-av-dock` and onto `<body>` under an id of
// its own, to escape the `overflow: hidden` ancestor that was cutting it off at
// bb's left pane boundary (canvas/dock/popover-place.ts's header records that
// diagnosis and how thin it is). Every rule in the stylesheet that reached the
// popover's parts through `#canvas-av-dock <something>` stops matching the
// instant that happens. There were two dozen of them. MISSING ONE LEAVES AN
// UNSTYLED CONTROL — an unbordered button, a jump link with no ellipsis — and
// "I read the file carefully" is not a way to be sure you found them all.
//
// So the sheet is parsed and every selector is classified, once, mechanically.
// That is the whole value here and it is a narrow one:
//
//   * IT IS NOT A TEST THAT THE POPOVER LOOKS RIGHT. There is no browser in
//     this spike and no jsdom, so nothing here renders anything. A rule can be
//     perfectly scoped and still be the wrong rule.
//   * THE THREE CLASS LISTS BELOW ARE HAND-WRITTEN, from reading which classes
//     canvas/dock/dock.ts puts inside the popover subtree and which it puts
//     inside the strip. They are knowledge that is NOT in the stylesheet, which
//     is what stops this being a grep of a file against itself — but they are
//     only as good as that reading, and a class this file has never heard of is
//     a class it cannot judge. A new popover part therefore has to be added
//     here as well as to the sheet.
//   * IT CANNOT SEE SPECIFICITY, CASCADE ORDER OR INHERITANCE. It answers one
//     question per selector: is this rule aimed at the tree the elements it
//     names actually live in.
//
// The parser tests above the audit are ordinary unit tests of ordinary string
// handling, and they exist because the audit is only worth anything if the
// parse under it is right — in particular the id-prefix trap, where
// "#canvas-av-dock-popover".startsWith("#canvas-av-dock") is true and a naive
// scope check would wave every misscoped selector through.
import { describe, expect, it } from "vitest";
import {
  auditDockScopes,
  isScopedUnder,
  mentionsClass,
  propertiesOn,
  rootsWithoutOwnFont,
  selectorsIn,
} from "../canvas/dock/style-scope.js";
import { DOCK_POPOVER_ID, DOCK_ROOT_ID, DOCK_STYLES } from "../canvas/dock/styles.js";

describe("selectorsIn", () => {
  it("returns one entry per rule", () => {
    expect(selectorsIn("a { color: red } b { color: blue }")).toEqual(["a", "b"]);
  });

  it("splits a selector list into its selectors", () => {
    expect(selectorsIn("a:hover,\n  b:focus { color: red }")).toEqual(["a:hover", "b:focus"]);
  });

  it("collapses the whitespace inside a selector, so a wrapped one compares equal", () => {
    // The sheet wraps long selectors across lines. Two rules that name the same
    // element must not read as different selectors just because one of them was
    // wrapped, or the twin check below would report a mirror that is there.
    expect(selectorsIn("#a\n  .b   .c { color: red }")).toEqual(["#a .b .c"]);
  });

  it("ignores comments, including ones holding braces and commas", () => {
    // The dock stylesheet is more comment than CSS, and those comments quote
    // selectors and declarations at length.
    expect(selectorsIn("/* a { x }, b */ c { color: red }")).toEqual(["c"]);
  });

  it("ignores declarations, which also contain braces via functions", () => {
    expect(selectorsIn("a { width: min(80vw, 420px); top: calc(100% + 6px) } b { x: y }")).toEqual([
      "a",
      "b",
    ]);
  });

  it("skips an at-rule's own prelude but still reports the rules inside it", () => {
    // No @media in the dock sheet today. The parser handles it anyway because
    // the alternative is a parser that silently reports nothing for a sheet
    // somebody later wraps in one — a green audit that checked nothing.
    expect(selectorsIn("@media (min-width: 40em) { a { color: red } }")).toEqual(["a"]);
  });

  it("returns nothing for a sheet with no rules", () => {
    expect(selectorsIn("/* nothing but a comment */")).toEqual([]);
  });
});

describe("propertiesOn", () => {
  it("names the properties a rule declares", () => {
    expect(propertiesOn("#a { color: red; font: 12px serif }", "#a")).toEqual(["color", "font"]);
  });

  it("finds the rule through a selector list", () => {
    expect(propertiesOn("#a, #b { color: red }", "#b")).toEqual(["color"]);
  });

  it("finds a rule whose selector was wrapped across lines", () => {
    // The sheet wraps. "#a .b" and "#a\n  .b" are the same rule and this must
    // not answer "nothing declared" for the second spelling.
    expect(propertiesOn("#a\n  .b { color: red }", "#a .b")).toEqual(["color"]);
  });

  it("collapses the whitespace in the selector it is ASKED about, not only the sheet's", () => {
    // Both sides, or the symmetry is a half one: the sheet's selectors are
    // collapsed by `rulesIn`, so without this the comparison would be
    // collapsed-against-raw and a caller who pasted a wrapped selector out of
    // the sheet would be told the rule declares nothing.
    expect(propertiesOn("#a .b { color: red }", "#a\n  .b")).toEqual(["color"]);
  });

  it("does not answer for a DESCENDANT of the element asked about", () => {
    // "declared on this element" and "declared on something inside it" are
    // different claims, and only the first one says anything about what the
    // element itself gives its children.
    expect(propertiesOn("#a .b { font: 12px serif }", "#a")).toEqual([]);
  });

  it("gathers every rule that names the element, not just the first", () => {
    expect(propertiesOn("#a { color: red } #a { font: 12px serif }", "#a")).toEqual([
      "color",
      "font",
    ]);
  });

  it("ignores comments and a trailing declaration with no semicolon", () => {
    expect(propertiesOn("/* #a { x: y } */ #a { color: red }", "#a")).toEqual(["color"]);
  });

  it("says nothing about a selector the sheet does not have", () => {
    expect(propertiesOn("#a { color: red }", "#zzz")).toEqual([]);
  });
});

describe("rootsWithoutOwnFont", () => {
  it("is silent when every root declares a font", () => {
    const css = "#a { font: 12px serif } #b { font-family: serif }";
    expect(rootsWithoutOwnFont(css, ["#a", "#b"])).toEqual([]);
  });

  it("reports a root that declares no font at all", () => {
    expect(rootsWithoutOwnFont("#a { color: red }", ["#a"])).toEqual(["#a"]);
  });

  it("does NOT accept a size without a family", () => {
    // The half-fix that looks like a fix: "font-size" leaves the FAMILY
    // inherited, which is the part that shows up as "this is in bb's font".
    expect(rootsWithoutOwnFont("#a { font-size: 11px }", ["#a"])).toEqual(["#a"]);
  });

  it("does not accept a font declared on a DESCENDANT of the root", () => {
    // A child with its own font says nothing about its siblings, and this
    // invariant is about what the whole tree inherits.
    expect(rootsWithoutOwnFont("#a .b { font: 12px serif }", ["#a"])).toEqual(["#a"]);
  });
});

describe("isScopedUnder", () => {
  it("accepts the root itself", () => {
    expect(isScopedUnder("#dock", "#dock")).toBe(true);
  });

  it("accepts a descendant of the root", () => {
    expect(isScopedUnder("#dock .thing", "#dock")).toBe(true);
  });

  it("accepts the root qualified by an attribute or a pseudo-class", () => {
    expect(isScopedUnder('#dock[data-x="1"] .thing', "#dock")).toBe(true);
    expect(isScopedUnder("#dock:hover .thing", "#dock")).toBe(true);
    expect(isScopedUnder("#dock[hidden]", "#dock")).toBe(true);
  });

  it("accepts a child, adjacent or sibling combinator after the root", () => {
    expect(isScopedUnder("#dock > .thing", "#dock")).toBe(true);
  });

  it("REFUSES a different id that merely starts with the root's name", () => {
    // The trap this whole function exists for. "#canvas-av-dock-popover"
    // starts with "#canvas-av-dock", so a startsWith check calls every
    // popover rule correctly scoped under the strip's root and the audit
    // passes while the sheet is broken.
    expect(isScopedUnder("#dock-popover .thing", "#dock")).toBe(false);
    expect(isScopedUnder("#dock-popover", "#dock")).toBe(false);
  });

  it("refuses a root that appears somewhere other than first", () => {
    expect(isScopedUnder(".thing #dock", "#dock")).toBe(false);
  });

  it("refuses an unrelated selector", () => {
    expect(isScopedUnder("[data-canvas-row-presence] .face", "#dock")).toBe(false);
  });
});

describe("mentionsClass", () => {
  it("finds a class anywhere in the selector", () => {
    expect(mentionsClass("#dock .a .b", "b")).toBe(true);
  });

  it("finds a class attached to a type selector", () => {
    expect(mentionsClass("#dock a.jump:hover", "jump")).toBe(true);
  });

  it("does not mistake a longer class for the one asked about", () => {
    // ".dock-jump-inert" must not answer for ".dock-jump", or every rule would
    // classify as every class it is a prefix of.
    expect(mentionsClass("#dock .dock-jump-inert", "dock-jump")).toBe(false);
    expect(mentionsClass("#dock .dock-jump", "dock-jump-inert")).toBe(false);
  });

  it("does not mistake an attribute value for a class", () => {
    expect(mentionsClass('#dock [data-x="dock-jump"]', "dock-jump")).toBe(false);
  });
});

describe("auditDockScopes", () => {
  const lists = {
    popoverOnly: ["pop"],
    stripOnly: ["strip"],
    shared: ["both"],
    stripRoot: "#dock",
    popoverRoot: "#dock-popover",
  };

  it("is silent about a sheet where every rule is aimed at the right tree", () => {
    const css = `
      #dock .strip { a: b }
      #dock-popover .pop { a: b }
      #dock .both, #dock-popover .both { a: b }
    `;
    expect(auditDockScopes({ css, ...lists })).toEqual([]);
  });

  it("reports a popover part still scoped under the strip's root", () => {
    const complaints = auditDockScopes({ css: "#dock .pop { a: b }", ...lists });
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toContain("#dock .pop");
  });

  it("reports a strip part scoped under the popover's root", () => {
    const complaints = auditDockScopes({ css: "#dock-popover .strip { a: b }", ...lists });
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toContain("#dock-popover .strip");
  });

  it("reports a shared part that reaches only one of the two trees", () => {
    // The failure mode with no visible selector to point at: ".dock-bubble"'s
    // base rule kept its strip scope, so the popover's faces lost their
    // border-radius, their overflow clip and their separator ring — and no rule
    // in the sheet looks wrong on its own.
    const complaints = auditDockScopes({ css: "#dock .both { a: b }", ...lists });
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toContain("#dock-popover .both");
  });

  it("accepts a shared part mirrored as two rules rather than one selector list", () => {
    const css = "#dock .both { a: b } #dock-popover .both { a: b }";
    expect(auditDockScopes({ css, ...lists })).toEqual([]);
  });

  it("does not ask a selector that already names a strip part to be mirrored", () => {
    // "#dock .strip .both" is the squeeze tiers: they name a shared class but
    // they are about the strip's copy of it, and a popover twin would be a rule
    // for an element that does not exist.
    expect(auditDockScopes({ css: "#dock .strip .both { a: b }", ...lists })).toEqual([]);
  });

  it("reports a selector that claims to be about both trees at once", () => {
    const complaints = auditDockScopes({ css: "#dock .strip .pop { a: b }", ...lists });
    expect(complaints).toHaveLength(1);
    // The WORDING, not just the count. Without the conflict branch this
    // selector is simply "a popover part in the wrong tree", which is also one
    // complaint — so a count-only assertion cannot tell the two apart, and the
    // advice differs: one is re-root it, the other is this rule can never match
    // anything and re-rooting will not help.
    expect(complaints[0]).toContain("can never match");
  });

  it("says nothing about selectors that name none of the parts it knows", () => {
    // The sidebar row decorations, which are scoped by their own attribute and
    // are none of this function's business.
    expect(auditDockScopes({ css: "[data-row] .face { a: b }", ...lists })).toEqual([]);
  });

  it("reports a known part scoped under neither root", () => {
    const complaints = auditDockScopes({ css: ".pop { a: b }", ...lists });
    expect(complaints).toHaveLength(1);
  });
});

describe("the dock stylesheet", () => {
  /** Classes canvas/dock/dock.ts only ever builds inside the popover element.
   * Read off the construction block there: the popover holds `.dock-faces`
   * (each face a `.dock-face` wrapping a bubble and a `.dock-jump` link), the
   * `.dock-controls` row of `.dock-btn`s (`.dock-audio` has no rule of its own,
   * `.dock-mic`, `.dock-camera` and `.dock-transcript` do), and the
   * `.dock-status` line. `.dock-video` is here because `renderBubbles` is
   * called with `video: true` for the popover's faces and `video: false` for
   * the strip's, so a `<video>` can only ever be attached inside the popover. */
  const popoverOnly = [
    "dock-popover",
    "dock-faces",
    "dock-face",
    "dock-jump",
    "dock-jump-inert",
    "dock-controls",
    "dock-btn",
    "dock-mic",
    "dock-camera",
    "dock-transcript",
    "dock-status",
    "dock-video",
  ];

  /** Classes that only ever exist inside `#canvas-av-dock`. */
  const stripOnly = ["dock-strip", "dock-bubbles", "dock-overflow", "dock-call"];

  /** Drawn in BOTH trees, by the same `renderBubbles`, so a rule for either of
   * these has to reach both or one of the two rows loses it. */
  const shared = ["dock-bubble", "dock-initials"];

  it("aims every popover rule at the popover's own root and every strip rule at the strip's", () => {
    expect(
      auditDockScopes({
        css: DOCK_STYLES,
        stripRoot: `#${DOCK_ROOT_ID}`,
        popoverRoot: `#${DOCK_POPOVER_ID}`,
        popoverOnly,
        stripOnly,
        shared,
      }),
    ).toEqual([]);
  });

  it("gives each tree root a font of its own, because neither has an ancestor in this sheet", () => {
    // THE FAILURE THE SCOPE AUDIT ABOVE CANNOT SEE. That one asks which tree a
    // rule is AIMED at; this asks what a tree INHERITS. They are different
    // questions and the popover's move broke the second one without touching
    // the first: it used to sit inside `#canvas-av-dock`, whose rule declares
    // `font: 12px/1.35 -apple-system, …`, and `.dock-btn`'s `font: inherit`
    // and the family-less `font-size` on `.dock-jump` and `.dock-status` all
    // took their family, size and line-height from there. On <body> they
    // inherit bb's instead.
    //
    // WHY THAT IS A RULE AND NOT A PREFERENCE: the top of canvas/dock/styles.ts
    // states that this sheet is self-contained and theme-neutral, because bb's
    // typography and variables are not a contract offered to plugins. A tree
    // whose root declares no font is a tree whose text is whatever the host
    // happens to be using, which is exactly the dependency that file refuses
    // everywhere else.
    //
    // It is asked of BOTH roots on purpose. The strip's has always had one, so
    // that half is a regression guard rather than a fix; making the invariant
    // "every root this sheet owns" is what makes a third tree — should anyone
    // ever add one — arrive with the question already asked.
    expect(rootsWithoutOwnFont(DOCK_STYLES, [`#${DOCK_ROOT_ID}`, `#${DOCK_POPOVER_ID}`])).toEqual(
      [],
    );
  });

  it("gives the two trees different roots", () => {
    // Not a tautology: the audit above would pass trivially if the two ids were
    // the same string, because every "scoped under the popover root" check
    // would also be a "scoped under the strip root" check.
    expect(DOCK_POPOVER_ID).not.toBe(DOCK_ROOT_ID);
  });
});
