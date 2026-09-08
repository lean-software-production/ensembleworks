// Page-id resolution for the spike's single room.
//
// canvas-editor's `Editor` demands a pageId at construction time, so the mount
// has to resolve one before it can build the editor. Prefer whatever page the
// synced doc already has (canonicalPageId — the same "pick one canonical page"
// rule canvas-model's repair() uses) so a room with real content keeps using
// its real page; only bootstrap `page:p` when the doc has no pages at all.
// `page:p` is the convention the EnsembleWorks server already established for
// a room's single default page, reused here rather than inventing a second one.
//
// The `requested` argument is where a bb DEEP LINK arrives. bb renders a nav
// panel for `/plugins/<pluginId>/<path>/*` and hands the remainder to the panel
// as `subPath` (@get-bb/plugin-sdk bundled types, bb-plugin-sdk-app.d.ts:344-355),
// so `/plugins/canvas/canvas/page:retro` is how one page is addressable. That
// string is UNTRUSTED — a human typed it, a bookmark preserved it, or the page
// it names was deleted last week — so it is honoured only when it names a page
// the doc actually has. Everything else falls through to the behaviour above,
// deliberately: a dead bookmark must land on a real page, because an empty
// canvas is indistinguishable from data loss to the person looking at it.
import { canonicalPageId } from "@ensembleworks/canvas-model";
import type { CanvasDoc } from "@ensembleworks/canvas-doc";

export const BOOTSTRAP_PAGE_ID = "page:p";

/**
 * Resolve the page id the Editor should use, bootstrapping one (and committing
 * that write) iff the doc has no pages at all. Idempotent: a doc that already
 * carries BOOTSTRAP_PAGE_ID just gets it back from canonicalPageId.
 *
 * `requested` is the page id the route asked for (see the module header), or
 * null for "no page was asked for". It wins iff it names a live page;
 * null, empty, or unknown falls through to the canonical-or-bootstrap answer.
 *
 * REQUIRED, not optional, and that is the point. The mount is the only
 * production caller, and the whole of C2a's cold-load deep linking is the
 * single act of passing the route's page here. Review on 2026-09-05 mutated
 * that call to `resolvePageId(peer.doc)`, deleting deep linking outright, and
 * both the suite and the typecheck stayed green. With no default there is
 * nothing to silently fall back TO: a caller that forgets the route fails
 * `tsc` before any test has to notice.
 */
export function resolvePageId(
  doc: CanvasDoc,
  requested: string | null,
  remembered: string | null,
): string {
  const pages = doc.listPages();
  const isLive = (pageId: string | null): pageId is string =>
    pageId !== null &&
    pageId.length > 0 &&
    pages.some((page) => page.id === pageId);
  if (isLive(requested)) return requested;
  if (isLive(remembered)) return remembered;
  const existing = canonicalPageId(pages);
  if (existing) return existing;
  doc.putPage({ id: BOOTSTRAP_PAGE_ID, name: "Canvas" });
  doc.commit();
  return BOOTSTRAP_PAGE_ID;
}
