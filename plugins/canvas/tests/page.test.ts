// Run: npx vitest run tests/page.test.ts
//
// Which page the Editor is seeded with. This is the one decision the mount
// makes before it can construct anything (canvas-editor's Editor demands a
// pageId at construction time), and once bb deep links carry a page in the
// route's subPath it is also the decision a STALE BOOKMARK lands on. There is
// no jsdom here, so it lives in canvas/page.ts as a pure function of
// (doc, requested) and is tested at that seam rather than through the panel.
import { describe, expect, it } from "vitest";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import type { CanvasDoc } from "@ensembleworks/canvas-doc";
import type { PageId } from "@ensembleworks/canvas-model";
import { BOOTSTRAP_PAGE_ID, resolvePageId } from "../canvas/page.js";

/** A doc seeded with exactly the pages named, committed like a real one. */
function docWith(...pageIds: PageId[]): CanvasDoc {
  const doc = LoroCanvasDoc.create({ peerId: 1n });
  for (const id of pageIds) doc.putPage({ id, name: id });
  if (pageIds.length > 0) doc.commit();
  return doc;
}

describe("resolvePageId", () => {
  it("adopts a requested page that names a live page", () => {
    // The deep-link case: /plugins/canvas/canvas/<pageId> must land on THAT
    // page even though canonicalPageId (lexicographically smallest) says
    // page:a. Without this the subPath would be decorative.
    const doc = docWith("page:a", "page:retro");
    expect(resolvePageId(doc, "page:retro", null)).toBe("page:retro");
  });

  it("falls back to the canonical page when the requested page is not live", () => {
    // A stale bookmark, a page somebody deleted, or a subPath a human typed.
    // Landing on an EMPTY canvas would look like data loss; landing on the
    // canonical page looks like a bookmark that has moved on.
    const doc = docWith("page:a", "page:retro");
    expect(resolvePageId(doc, "page:deleted-last-week", null)).toBe("page:a");
  });

  it("ignores a requested page that is empty or null", () => {
    // "" is what a bare panel route (no subPath) degrades to in bb's SDK, and
    // null is what `pageIdFromSubPath` returns for every spelling of "no page
    // was asked for"; neither is a request.
    const doc = docWith("page:a", "page:retro");
    expect(resolvePageId(doc, "", null)).toBe("page:a");
    expect(resolvePageId(doc, null, null)).toBe("page:a");
  });

  it("requires the caller to say what the route asked for", () => {
    // NOT a style preference. The mount is the only production caller, and
    // passing the route's page here IS cold-load deep linking — the whole of
    // it. A review mutation dropped the argument (`resolvePageId(peer.doc)`),
    // deleting the feature, and neither the suite nor `tsc` noticed. With no
    // default there is nothing to silently fall back to, so this now reads as
    // a compile error rather than as a quietly different product.
    const doc = docWith("page:a");
    // @ts-expect-error — both page claims are required parameters.
    void (() => resolvePageId(doc, null));
    expect(resolvePageId(doc, null, null)).toBe("page:a");
  });

  it("bootstraps the default page, and commits it, on a doc with no pages", () => {
    const doc = docWith();
    expect(resolvePageId(doc, null, null)).toBe(BOOTSTRAP_PAGE_ID);
    expect(doc.listPages().map((p) => p.id)).toEqual([BOOTSTRAP_PAGE_ID]);
  });

  it("bootstraps rather than honouring a request when the doc has no pages", () => {
    // The dead-bookmark rule at its extreme: a requested id that names nothing
    // must never be conjured into existence, because a page the doc does not
    // have is a page nobody else can see.
    const doc = docWith();
    expect(resolvePageId(doc, "page:ghost", null)).toBe(BOOTSTRAP_PAGE_ID);
    expect(doc.listPages().map((p) => p.id)).toEqual([BOOTSTRAP_PAGE_ID]);
  });

  it("is idempotent — a bootstrapped doc resolves to the same page again", () => {
    const doc = docWith();
    const first = resolvePageId(doc, null, null);
    expect(resolvePageId(doc, first, null)).toBe(first);
    expect(resolvePageId(doc, null, null)).toBe(first);
    expect(doc.listPages()).toHaveLength(1);
  });
});

describe("resolvePageId remembers where this client left off", () => {
  it("opens the remembered page when the route asks for nothing", () => {
    const doc = docWith("page:a", "page:retro");
    expect(resolvePageId(doc, null, "page:retro")).toBe("page:retro");
    expect(resolvePageId(doc, "", "page:retro")).toBe("page:retro");
  });

  it("lets an explicit deep link beat the memory", () => {
    const doc = docWith("page:a", "page:retro", "page:plan");
    expect(resolvePageId(doc, "page:plan", "page:retro")).toBe("page:plan");
  });

  it("falls through when the remembered page is no longer live", () => {
    const doc = docWith("page:a", "page:retro");
    expect(resolvePageId(doc, null, "page:deleted-last-week")).toBe("page:a");
  });

  it("does not create a remembered page in an empty document", () => {
    const doc = docWith();
    expect(resolvePageId(doc, null, "page:ghost")).toBe(BOOTSTRAP_PAGE_ID);
  });

  it("ignores blank memory", () => {
    const doc = docWith("page:a", "page:retro");
    expect(resolvePageId(doc, null, "")).toBe("page:a");
  });
});
