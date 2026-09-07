// Run: npx vitest run tests/page-menu.test.ts
//
// TASK C1a — everything the page switcher DECIDES, with no switcher in sight.
// The spike has no jsdom and may not gain one, so a rule written inline in a
// .tsx is a rule no test can reach; canvas/pages/page-menu.ts is where the
// three surfaces (palette, button-popover, wide-only tab bar) get their
// answers from, and this file is the only place those answers are checked.
//
// The row model is deliberately the SAME for all three surfaces: one function
// says which page is current, which arrows are live and whether delete is
// offered, so the popover and the tab bar cannot drift into disagreeing about
// whether a page can be deleted.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { callArguments, countInCode, stripComments } from "./lib/source.js";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { Editor } from "@ensembleworks/canvas-editor";
import type { Page } from "@ensembleworks/canvas-model";
import {
  filterPageRows,
  nextPageMenuOpen,
  pageMenuEnterTarget,
  pageMenuRows,
  renamePageIntents,
  switchPageIntents,
} from "../canvas/pages/page-menu.js";
import { deletePageIntents, movePageIntents } from "../canvas/pages/page-intents.js";

const THREE: readonly Page[] = [
  { id: "page:p", name: "Sketches", index: "a0" },
  { id: "page:q", name: "Retro", index: "a1" },
  { id: "page:r", name: "Roadmap", index: "a2" },
];

describe("pageMenuRows", () => {
  it("lists pages in orderedPages order, not doc order", () => {
    // Deliberately shuffled input: the doc's listPages() order is a CRDT
    // detail, and the switcher's order is the fractional index.
    const rows = pageMenuRows([THREE[2]!, THREE[0]!, THREE[1]!], "page:p");
    expect(rows.map((r) => r.id)).toEqual(["page:p", "page:q", "page:r"]);
  });

  it("marks exactly the current page", () => {
    const rows = pageMenuRows(THREE, "page:q");
    expect(rows.map((r) => r.current)).toEqual([false, true, false]);
  });

  it("marks no row current when currentPageId names no page (a mid-undo doc)", () => {
    // Reachable for one render between a page-removing undo and the clamp
    // (canvas/pages/history-repair.ts). The switcher must draw SOMETHING
    // rather than throw.
    const rows = pageMenuRows(THREE, "page:gone");
    expect(rows.some((r) => r.current)).toBe(false);
  });

  it("kills the left arrow on the first row and the right arrow on the last", () => {
    const rows = pageMenuRows(THREE, "page:p");
    expect(rows.map((r) => r.canMoveLeft)).toEqual([false, true, true]);
    expect(rows.map((r) => r.canMoveRight)).toEqual([true, true, false]);
  });

  it("refuses delete when there is only one page", () => {
    expect(pageMenuRows([THREE[0]!], "page:p").map((r) => r.canDelete)).toEqual([false]);
    expect(pageMenuRows(THREE, "page:p").every((r) => r.canDelete)).toBe(true);
  });

  it("answers an empty page list with an empty row list", () => {
    expect(pageMenuRows([], "page:p")).toEqual([]);
  });
});

describe("the rows agree with the intents behind them", () => {
  // The affordance and the mutation are two different modules, and a button
  // that is enabled but produces no intents is a dead control. Checked
  // against a REAL editor so this cannot pass on a shared misconception.
  function makeEditor(pages: readonly Page[], currentPageId: string): Editor {
    const doc = LoroCanvasDoc.create({ peerId: 1n });
    for (const p of pages) doc.putPage(p);
    doc.commit();
    return new Editor({ doc, now: () => 0, random: () => 0.5, pageId: currentPageId });
  }

  it("every enabled arrow produces a ReorderPage, every disabled one produces nothing", () => {
    const editor = makeEditor(THREE, "page:p");
    for (const row of pageMenuRows(THREE, "page:p")) {
      expect(movePageIntents(editor, row.id, "left").length > 0).toBe(row.canMoveLeft);
      expect(movePageIntents(editor, row.id, "right").length > 0).toBe(row.canMoveRight);
    }
  });

  it("every enabled delete produces a DeletePage, and the last page's does not", () => {
    const many = makeEditor(THREE, "page:p");
    for (const row of pageMenuRows(THREE, "page:p")) {
      expect(deletePageIntents(many, row.id).length > 0).toBe(row.canDelete);
    }
    const one = makeEditor([THREE[0]!], "page:p");
    expect(deletePageIntents(one, "page:p")).toEqual([]);
  });
});

describe("filterPageRows", () => {
  const rows = pageMenuRows(THREE, "page:p");

  it("returns every row for an empty or whitespace query", () => {
    expect(filterPageRows(rows, "")).toHaveLength(3);
    expect(filterPageRows(rows, "   ")).toHaveLength(3);
  });

  it("matches a name case-insensitively, anywhere in it", () => {
    expect(filterPageRows(rows, "retro").map((r) => r.id)).toEqual(["page:q"]);
    expect(filterPageRows(rows, "OAD").map((r) => r.id)).toEqual(["page:r"]);
  });

  it("keeps the row order it was given", () => {
    expect(filterPageRows(rows, "r").map((r) => r.id)).toEqual(["page:q", "page:r"]);
  });

  it("does NOT match the page id", () => {
    // Every id starts with "page:", so matching ids would make the query
    // "page" — a word somebody typing a page name will absolutely type —
    // match everything, and would surface a mint detail the user never chose.
    expect(filterPageRows(rows, "page:q")).toEqual([]);
  });

  it("returns nothing rather than everything when nothing matches", () => {
    expect(filterPageRows(rows, "zzz")).toEqual([]);
  });
});

describe("pageMenuEnterTarget", () => {
  it("is the top row, so Enter goes to the best match", () => {
    const rows = pageMenuRows(THREE, "page:p");
    expect(pageMenuEnterTarget(filterPageRows(rows, "r"))?.id).toBe("page:q");
  });

  it("is null when the filter matched nothing, so Enter does nothing at all", () => {
    expect(pageMenuEnterTarget([])).toBe(null);
  });
});

describe("renamePageIntents", () => {
  const row = pageMenuRows(THREE, "page:p")[1]!;

  it("renames to the trimmed text", () => {
    expect(renamePageIntents(row, "  Retrospective  ")).toEqual([
      { type: "RenamePage", id: "page:q", name: "Retrospective" },
    ]);
  });

  it("emits nothing when the prompt was cancelled", () => {
    // window.prompt answers null for Cancel and "" for an emptied box, and the
    // two must NOT be told apart here: neither is a request to rename, and a
    // page with an empty name is unclickable in every surface that draws it.
    expect(renamePageIntents(row, null)).toEqual([]);
    expect(renamePageIntents(row, "")).toEqual([]);
    expect(renamePageIntents(row, "   ")).toEqual([]);
  });

  it("emits nothing when the name did not actually change", () => {
    // A same-value RenamePage is a doc write, a sync frame to every peer and
    // an undo entry that undoes nothing visible.
    expect(renamePageIntents(row, "Retro")).toEqual([]);
    expect(renamePageIntents(row, "  Retro  ")).toEqual([]);
  });
});

describe("nextPageMenuOpen", () => {
  it("toggles on a click of the button that owns it", () => {
    expect(nextPageMenuOpen(false, { type: "button-click" })).toBe(true);
    expect(nextPageMenuOpen(true, { type: "button-click" })).toBe(false);
  });

  it("opens on the palette command, even when it is already open", () => {
    // The palette command is a REQUEST to see the list, never a toggle: a
    // user who typed "Canvas: go to page" and got it closed would think the
    // command was broken.
    expect(nextPageMenuOpen(false, { type: "palette" })).toBe(true);
    expect(nextPageMenuOpen(true, { type: "palette" })).toBe(true);
  });

  it("closes on Escape and on a pointerdown outside the widget", () => {
    expect(nextPageMenuOpen(true, { type: "escape" })).toBe(false);
    expect(nextPageMenuOpen(true, { type: "pointerdown", insideWidget: false })).toBe(false);
  });

  it("does NOT close on a pointerdown inside the widget", () => {
    // The lesson canvas/dock/dock.ts's `insideWidget` records: a naive
    // containment check that knows only about the BUTTON dismisses the
    // popover on the way down from every control the popover exists to
    // offer, before the click that operates it ever arrives.
    expect(nextPageMenuOpen(true, { type: "pointerdown", insideWidget: true })).toBe(true);
  });

  it("closes after switching or creating a page — the view moved", () => {
    expect(nextPageMenuOpen(true, { type: "acted", action: "switch" })).toBe(false);
    // "+ new page" switches to the new page (newPageIntents batches
    // SetCurrentPage), so it is a switch by another name.
    expect(nextPageMenuOpen(true, { type: "acted", action: "create" })).toBe(false);
  });

  it("stays open after renaming, deleting or reordering — that is page management", () => {
    // These are the operations you do several of in a row, and each one
    // re-renders the list you are working in. Closing would make the second
    // one cost a re-open.
    expect(nextPageMenuOpen(true, { type: "acted", action: "rename" })).toBe(true);
    expect(nextPageMenuOpen(true, { type: "acted", action: "delete" })).toBe(true);
    expect(nextPageMenuOpen(true, { type: "acted", action: "move" })).toBe(true);
  });

  it("never opens a closed menu except on button-click or palette", () => {
    const events = [
      { type: "escape" },
      { type: "pointerdown", insideWidget: true },
      { type: "pointerdown", insideWidget: false },
      { type: "acted", action: "rename" },
      { type: "acted", action: "switch" },
    ] as const;
    for (const event of events) expect(nextPageMenuOpen(false, event)).toBe(false);
  });
});

describe("switchPageIntents — what clicking a row is worth", () => {
  // The rule used to live inline in PageSwitcher.tsx's click handler, where
  // nothing could reach it: `if (!row.current) editor.applyAll(…)`. Flipping
  // that condition, or deleting it, broke no test — so it is here now.
  const rows = pageMenuRows(THREE, "page:q");
  const current = rows.find((row) => row.current);
  const other = rows.find((row) => !row.current);

  it("switches to a page you are not on", () => {
    expect(switchPageIntents(other!)).toEqual([
      { type: "SetCurrentPage", pageId: other!.id },
    ]);
  });

  it("does nothing for the page already being rendered", () => {
    // A same-value SetCurrentPage is not free: it still notifies every editor
    // subscriber, so every surface re-renders to draw exactly what it drew.
    expect(switchPageIntents(current!)).toEqual([]);
  });

  it("never emits anything but SetCurrentPage — switching is a VIEW change", () => {
    // canvas-editor/src/editor.ts:927: SetCurrentPage writes no doc and takes
    // no undo entry. A switch that smuggled a mutation alongside would put a
    // page change on the undo stack, which is the bug history-repair.ts exists
    // to clean up after.
    for (const row of rows) {
      for (const intent of switchPageIntents(row)) {
        expect(intent.type).toBe("SetCurrentPage");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// THE WIRE THAT CARRIES THIS ROW MODEL: the panel's document and current page
// -> usePageSwitcher -> pageMenuRows.
//
// WHY SOURCE READS AND NOT BEHAVIOUR TESTS. Everything above this line is a
// real unit test of real functions; none of it touches the two .tsx files that
// decide WHAT those functions are called with, because there is no jsdom here
// to mount them (see tests/lib/source.ts's header). So the three values this
// block is about — the editor, the document and the current page id; the
// fourth argument of the same call, `containerWidth`, is pinned in
// tests/page-tabs-fit.test.ts — are checked the only honest way left: by
// reading the call sites as CODE.
//
// VERIFIED BY MUTATION, 2026-09-05, before this block existed — each of these
// alone gave `npx tsc --noEmit` exit 0 and the whole suite at 39 files / 875
// tests passed, byte-identical to the unmutated baseline:
//   * CanvasPanel.tsx `snapshot,` -> `snapshot: { ...snapshot, pages: [] },`
//   * CanvasPanel.tsx `currentPageId: editorState.currentPageId` -> `""`
//   * PageSwitcher.tsx `pageMenuRows(snapshot.pages, currentPageId)`
//     -> `pageMenuRows([], currentPageId)`
//   * PageSwitcher.tsx `pageMenuButtonLabel(rows, currentPageId)`
//     -> `pageMenuButtonLabel(rows, "")`   (that call, and the toolbar button
//     it labelled, were removed on 2026-09-06 — see page-menu.ts)
//
// WHAT IS LOST WHEN THIS IS UNPINNED. With no pages reaching `pageMenuRows`
// the row model is empty, so the tab bar draws no tabs and the popover lists
// no pages: the whole of D-2's multi-page surface is invisible while the
// document is perfectly intact — strictly worse than the `pages: []` title
// mutation tests/page-title.test.ts records, which only cost `document.title`.
// With no current page id, no row is `current` — nothing is ever highlighted,
// so no tab reads as the one you are on and the popover draws no selection.
//
// BOTH ENDS, because a wire is only pinned when both ends are: the panel half
// says what is handed over, the switcher half says the handed-over values are
// what the pure functions get. That is the shape tests/page-tabs-fit.test.ts
// already uses for `containerWidth`, the fourth argument of this same call.
const PANEL = readFileSync(new URL("../canvas/CanvasPanel.tsx", import.meta.url), "utf8");
const PANEL_CODE = stripComments(PANEL);
const SWITCHER = readFileSync(
  new URL("../canvas/pages/PageSwitcher.tsx", import.meta.url),
  "utf8",
);
const SWITCHER_CODE = stripComments(SWITCHER);

describe("the panel end of the wire — what it feeds usePageSwitcher", () => {
  it("mounts the switcher exactly once", () => {
    // Counted in CODE, and asserted before anything below reads the call's
    // arguments: `callArguments` takes the FIRST match, so a second mount
    // would make every assertion below silently about whichever came first.
    expect(countInCode(PANEL, "usePageSwitcher(")).toBe(1);
  });

  it("hands it the live document", () => {
    // Bounded to this call's own argument list rather than a file-wide
    // `toContain`, because `snapshot` appears all over the panel (dependency
    // arrays, the renderer's props) — a file-wide read survives deleting it
    // from HERE, which is mutation 1 above.
    //
    // Either spelling of the same handover: the shorthand as written, or
    // `snapshot: snapshot`. Not `snapshot: <anything else>` — an expression
    // between the two ends is exactly what the mutation was.
    const args = callArguments(PANEL_CODE, "usePageSwitcher");
    // `[,{]` because `callArguments` returns this call's whole object literal
    // braces and all, so the first property is preceded by `{` and the rest by
    // a comma.
    expect(args).toMatch(/[,{]\s*snapshot\s*(?:,|:\s*snapshot\s*,)/);
  });

  it("hands it the page being shown", () => {
    // `currentPageId: editorState.currentPageId` appears at several call sites
    // in the panel; this is the one whose loss makes the switcher stop
    // highlighting anything. Hence, again, bounded to this call.
    // MUTATION VERIFIED 2026-09-05: `toContain` pins a PREFIX, so
    // `editorState.currentPageId.replace(/^page:/, "")` — an id no page has,
    // i.e. nothing highlighted ever again — passed it with tsc at exit 0 and
    // the suite at 882 tests. Bounded to the whole property value: the match
    // must end at the comma that closes it.
    const args = callArguments(PANEL_CODE, "usePageSwitcher");
    expect(args).toMatch(/[,{]\s*currentPageId:\s*editorState\.currentPageId\s*,/);
  });

  it("hands it the editor every page mutation is applied through", () => {
    // No mutation of this one was found that typechecks — the panel has one
    // editor and it is the only value of its type in scope. Pinned anyway
    // because it costs a line and it is the same seam class as the three that
    // did mutate cleanly: an argument list is checked whole, or the next
    // argument added to it inherits the hole.
    const args = callArguments(PANEL_CODE, "usePageSwitcher");
    expect(args).toMatch(/[,{]\s*editor\s*(?:,|:\s*editor\s*,)/);
  });
});

describe("the switcher end of the wire — what usePageSwitcher does with them", () => {
  it("takes both values off its input rather than recomputing them", () => {
    // The join with the block above: that one proves the panel writes these
    // two, this proves the hook destructures them straight out of `input`
    // instead of deriving something else on the way in (which would make the
    // panel-side guard true and meaningless).
    expect(SWITCHER_CODE).toMatch(/const \{[^}]*\bsnapshot\b[^}]*\}\s*=\s*input;/);
    expect(SWITCHER_CODE).toMatch(/const \{[^}]*\bcurrentPageId\b[^}]*\}\s*=\s*input;/);
  });

  it("builds the row model from the fed document and the fed current page", () => {
    expect(countInCode(SWITCHER, "pageMenuRows(")).toBe(1);
    const args = callArguments(SWITCHER_CODE, "pageMenuRows").replace(/\s+/g, " ").trim();
    expect(args).toBe("snapshot.pages, currentPageId");
  });

  it("carries the current page id all the way to the row model, unmodified", () => {
    // WHERE THAT ID NOW SHOWS UP, since the toolbar button that used to name it
    // was removed on 2026-09-06: `row.current`, which is the tab's
    // `aria-pressed` and its joined-to-the-canvas paint, and the popover's
    // highlight. `pageMenuRows` is the only consumer left, so the guard above
    // ("builds the row model from the fed document and the fed current page")
    // is now the whole of this wire's switcher end — pinned here as a negative
    // so a reintroduced second consumer has to be argued rather than assumed.
    expect(countInCode(SWITCHER, "currentPageId")).toBeGreaterThan(0);
    expect(countInCode(SWITCHER, 'pageMenuRows(snapshot.pages, currentPageId)')).toBe(1);
    expect(SWITCHER_CODE).not.toMatch(/pageMenuRows\(\s*\[\s*\]/);
    expect(SWITCHER_CODE).not.toMatch(/pageMenuRows\([^)]*,\s*""\s*\)/);
  });
});
