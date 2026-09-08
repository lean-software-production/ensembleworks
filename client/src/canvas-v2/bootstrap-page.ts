/**
 * PAGE-ID CONVENTION for a dogfood v2 room — canvas-editor's `Editor` demands
 * a `pageId` at CONSTRUCTION time (a fixed field: canvas-editor/src/editor.ts's
 * `EditorOpts.pageId` doc comment — "every Editor needs a home page, so the
 * constructor demands it now"), so CanvasV2App must resolve one page id
 * before it can build the Editor at all.
 *
 * DECISION: `resolvePageId` prefers whatever page id ALREADY EXISTS in the
 * synced doc (via canvas-model's `canonicalPageId` — the lexicographically
 * smallest page id, the SAME "pick one canonical page" rule
 * canvas-model/src/repair.ts already uses for orphan reparenting) over
 * inventing a new one — so a room that already has real content (from a
 * prior v2 session, or a future tldraw-room conversion) keeps using its
 * REAL page rather than splitting into two. Only when the doc has ZERO
 * pages (a genuinely brand-new v2-only room) does this function bootstrap
 * one, under the literal id `BOOTSTRAP_PAGE_ID = 'page:p'` — the SAME
 * convention server/src/canvas-v2/crash-writer.ts already established for a
 * room's single default page (see its own doc comment: "`page:p` Page
 * record — without one, every shape's `parentId: 'page:p'`..."). Reusing
 * that literal (rather than inventing a second convention) means every v2
 * room this codebase creates, test-fixture or real dogfood, converges on
 * the identical single-page id when starting from empty.
 *
 * SYNC-READINESS (was a KNOWN RACE): CanvasV2App calls this ONCE, after
 * awaiting sync readiness — it races `SyncClientPeer.ready()` (which resolves
 * on the server's Frame.SyncDone, sent right after the backfill Update) against
 * a bounded safety cap. In the common case the backfill has already been
 * imported, so an existing room's real page is visible here and adopted. The
 * redundant-`page:p` bootstrap described below is now only reachable in the
 * pathological tail where readiness never arrives within the cap.
 *
 * THAT TAIL IS NO LONGER CORRECTNESS-NEUTRAL FOR RENDERING, and this comment
 * claimed otherwise until 2026-09-05. The old claim was that "canvas-react's
 * ShapeLayer/EmbedLayer never filter by page — rooms are single-page today —
 * so both pages' shapes render identically regardless of which page owns
 * them". Both halves have since stopped being true: Task R1's page filter
 * landed on 2026-07-22 in canvas-react/src/ShapeLayer.tsx:110
 * (`.filter((s) => pageIdOf(snapshot, s) === currentPageId)`) and
 * canvas-react/src/embed/EmbedLayer.tsx:106 (the same predicate), and rooms
 * are no longer single-page — CanvasV2App.tsx:1227 mounts a PageSwitcher.
 * The App.tsx sentence that was cited still exists (App.tsx:238) but it is
 * scoped to the LEGACY tldraw engine's frame-targeting, and was never a claim
 * about canvas-react.
 *
 * SO WHAT THE TAIL ACTUALLY COSTS, in the two cases it splits into.
 *
 * (a) The room's real default page IS `page:p` — the overwhelmingly common
 * case, because that literal is this codebase's ONE convention for it (see
 * above, and server/src/canvas-v2/crash-writer.ts). The late backfill then
 * merges onto the very page we bootstrapped, `currentPageId` already names it,
 * and the filter changes nothing. Still correctness-neutral, just for a
 * narrower reason than the old comment gave.
 *
 * (b) The room's pages do NOT include `page:p` (it was deleted, or the room
 * came from somewhere that used other ids — `mintPageId` produces
 * `page:<base36>`). Now the bootstrapped `page:p` is a second, empty page, the
 * Editor's `currentPageId` names it, and every real shape — parented to the
 * room's own page — is filtered OUT of both layers. The user sees an EMPTY
 * canvas over intact content. Nothing else catches this: `repair()` does not,
 * because those shapes are not orphans (their page really exists), and
 * `clampCurrentPageIntents` does not, because it only fires when
 * `currentPageId` DANGLES and `page:p` is a live page we just created.
 *
 * WHY (b) IS STILL ACCEPTED RATHER THAN FIXED. It is bounded and recoverable,
 * not lossy: nothing is deleted or reparented, the doc still holds every shape
 * on its real page, and CanvasV2App.tsx:1227's PageSwitcher lists both pages
 * and switches between them in one click. It also needs BOTH the missed
 * readiness ack AND a room with no `page:p` at all. NOT claimed: that a
 * subsequent cold load heals itself — `canonicalPageId` picks the
 * lexicographically smallest id, and a minted `page:<base36>` can sort either
 * side of `page:p`, so the next load may well adopt the empty one again. A
 * protocol-level fix isn't needed for the common case (Frame.SyncDone IS that
 * ack); the cap-bounded tail is accepted as the remaining tradeoff — but it is
 * now a VISIBLE, user-facing tradeoff in case (b), which is exactly the part
 * the old comment got wrong.
 */
import { canonicalPageId } from '@ensembleworks/canvas-model'
import type { CanvasDoc } from '@ensembleworks/canvas-doc'

export const BOOTSTRAP_PAGE_ID = 'page:p'

/** Resolve the page id `Editor` should use, bootstrapping one (and
 * committing that write) iff the doc has no pages at all. Idempotent in
 * practice: a doc that already has `BOOTSTRAP_PAGE_ID` (from an earlier
 * bootstrap, this session or a prior one) just returns it via
 * `canonicalPageId` — `putPage` is never called again. */
export function resolvePageId(doc: CanvasDoc): string {
	const existing = canonicalPageId(doc.listPages())
	if (existing) return existing
	doc.putPage({ id: BOOTSTRAP_PAGE_ID, name: 'Canvas' })
	doc.commit()
	return BOOTSTRAP_PAGE_ID
}
