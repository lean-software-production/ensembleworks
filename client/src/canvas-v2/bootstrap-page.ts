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
 * KNOWN RACE (documented, not hidden — v1 tradeoff): CanvasV2App calls this
 * ONCE, after a bounded "settle" window post-handshake (see its own module
 * header), not after a protocol-guaranteed "you are now fully caught up"
 * signal — canvas-sync's SyncRequest/Update handshake has no such ack.
 * Over a REAL (async) WebSocket, a client reconnecting to an existing
 * non-empty dogfood room during unusually high latency could observe ZERO
 * pages before the server's reply has arrived, and bootstrap a REDUNDANT
 * `page:p` alongside the room's real page. This is CORRECTNESS-NEUTRAL for
 * rendering (canvas-react's ShapeLayer/EmbedLayer never filter by page —
 * "rooms are single-page today" per client/src/App.tsx's own comment — so
 * both pages' shapes render identically regardless of which page owns
 * them) and only matters to `repair()`'s orphan-reparenting target (which
 * never touches a shape that already has a valid page, i.e. never touches
 * pre-existing real content). A protocol-level fix (an explicit
 * server "caught up" ack) is a Phase 4 item, out of this unit's scope.
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
