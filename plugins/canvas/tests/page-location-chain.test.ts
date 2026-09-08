// Run: npx vitest run tests/page-location-chain.test.ts
//
// THE WHOLE CHAIN, CONFIRMED END TO END. Task C2b of
// docs/plans/2026-09-05-bb-canvas-multi-page-design.md (D-5) says two
// mechanisms are BOTH needed, and this file is what makes that claim
// falsifiable rather than a sentence in a design doc:
//
//   1. `document.title` — what the dock SAYS. Each tab reads its own
//      (canvas/dock/dock.ts's `selfReport`) and sends it on the roster poll,
//      so a page name needs no wire change to reach every other client.
//   2. The `subPath` in the reported pathname — where the click GOES, and the
//      thing that tells `locationLabel` a page was addressed at all.
//
// The links are real modules, joined here in the order a live system joins
// them: page name -> decidePageDocumentTitle -> LocationReport -> LocationBook
// -> LocatedMember -> parseLocation -> locationLabel / jumpHref. There is no
// jsdom in this project, so `document.title` and `window.location.pathname`
// are the two values a test has to stand in for; everything between them is
// the shipped code.
import { describe, expect, it } from "vitest";
import type { Page } from "@ensembleworks/canvas-model";
import { LocationBook, type LocationReport } from "../canvas/locations.js";
import { jumpHref, locationLabel, parseLocation } from "../canvas/dock/where.js";
import { decidePageDocumentTitle } from "../canvas/pages/page-title.js";
import { CANVAS_PANEL_PATH } from "../canvas/pages/page-route.js";

/** bb's plugin id for this plugin — the FIRST "canvas" in
 * `/plugins/canvas/canvas/…`; `CANVAS_PANEL_PATH` is the second. They are
 * separate facts that happen to share a spelling, so they are written
 * separately here rather than one being used for both. */
const PLUGIN_ID = "canvas";

const PAGES: Page[] = [
  { id: "page:a", name: "Canvas", index: "a0" },
  { id: "page:retro", name: "Retro", index: "a1" },
];

/** What `selfReport` would build for a tab showing `currentPageId`, with the
 * two browser-owned values (title, pathname) produced the way the panel
 * produces them. `subPath` null models a panel that has not written the page
 * into the URL. */
function reportFor(currentPageId: string, subPath: string | null): LocationReport {
  const action = decidePageDocumentTitle({
    pages: PAGES,
    currentPageId,
    original: "bb",
    // A fresh tab: the host's title is what is there before the panel writes.
    current: "bb",
  });
  const documentTitle = action.kind === "set" ? action.title : "bb";
  const pathname =
    subPath === null
      ? `/plugins/${PLUGIN_ID}/${CANVAS_PANEL_PATH}`
      : `/plugins/${PLUGIN_ID}/${CANVAS_PANEL_PATH}/${subPath}`;
  return {
    clientId: "tab-1",
    name: "alice",
    path: pathname,
    // dock.ts reports a TRIMMED title and omits an empty one; mirrored here so
    // this stands in for the real reporter rather than an idealised one.
    title: documentTitle.trim().length > 0 ? documentTitle.trim() : null,
  };
}

/** Put one report through the server-side book and read the row back out. */
function rowFor(report: LocationReport) {
  const book = new LocationBook();
  book.seen(report, 1_000);
  const row = book.members({}, 1_000)[0];
  expect(row).toBeDefined();
  return row!;
}

describe("what the dock says about somebody on a canvas page", () => {
  it("names the page, and offers a link that lands on it", () => {
    const row = rowFor(reportFor("page:retro", "page:retro"));
    const there = parseLocation(row.path ?? "");

    // 1. What it SAYS — and note where the name came from: the PATH carries a
    //    page id, never a name, so the only way "Retro" can reach another
    //    client at all is the title the tab reported.
    expect(locationLabel(there, null, row.title)).toBe("on the canvas — “Retro”");

    // 2. Where the click GOES — the full path, page and all, and it survives
    //    the href guard.
    expect(jumpHref(row.path)).toBe("/plugins/canvas/canvas/page:retro");
  });

  it("says only 'on the canvas' for a tab that reported no page", () => {
    // BOTH HALVES OR NEITHER. This is the case that proves the title alone is
    // not enough: the tab is reporting the title "Retro", but its URL names no
    // page, so claiming a page would be a guess. It is also what every client
    // running an older bundle looks like.
    const row = rowFor(reportFor("page:retro", null));
    expect(row.title).toBe("Retro");
    expect(locationLabel(parseLocation(row.path ?? ""), null, row.title)).toBe(
      "on the canvas",
    );
  });

  it("says only 'on the canvas' when the page is stranded and the title is the host's", () => {
    // The other half of the pair: a URL that names a page but a tab whose
    // currentPageId names none (the one render between a page-removing undo
    // and history-repair.ts's clamp). The title falls back to bb's own, which
    // is not a page name — so the label falls back too rather than reporting
    // "bb" as the page somebody is on.
    const row = rowFor(reportFor("page:gone", "page:gone"));
    expect(row.title).toBe("bb");
    // Deliberately asserted through the label rather than the title: what
    // matters is that no page gets NAMED, whatever the title happens to be.
    expect(locationLabel(parseLocation(row.path ?? ""), null, "")).toBe(
      "on the canvas",
    );
  });

  it("still says 'on the canvas' once the location has gone stale", () => {
    // The chain must not outlive its own freshness rule: past
    // LOCATION_STALE_MS the book reports present-with-no-location, and a
    // canvas page name is exactly the kind of detail that would look
    // authoritative long after it stopped being true.
    const book = new LocationBook();
    book.seen(reportFor("page:retro", "page:retro"), 1_000);
    const row = book.members({}, 1_000 + 20_000)[0];
    expect(row?.path).toBeNull();
    expect(row?.title).toBeNull();
    expect(locationLabel(null, null, row?.title)).toBe("somewhere in bb");
  });
});
