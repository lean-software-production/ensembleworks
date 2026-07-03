# Client-computed spatial stamp — design

- **Status:** Draft for review (brainstormed 2026-07-03)
- **Motivation:** `architecture-spec.md` §6.6 names "canvas size × read
  frequency" as scaling cliff #1: the proximity/stamp geometry
  (`frameAtPoint`, `viewportCenter`, parent walks) runs synchronously on the
  cursor-serving event loop on every `POST /api/transcript`. Every browser
  already holds the full CRDT document, so each client can compute **its
  own** spatial position — one point against one page's frames — and publish
  it in the presence record it already sends. The server then reads a field
  instead of walking the document.
- **Companion docs:** [`architecture-spec.md`](../../architecture-spec.md)
  (§5.2, §5.5, §6.6), [`plugin-architecture-design.md`](../../plugin-architecture-design.md)
  (presence service, contracts).

## Decisions taken during brainstorming

1. **Scope: transcript stamping + read sort point.** The transcript path
   deletes all server geometry. The read endpoints (`/api/frames`,
   `/api/frame`) keep their response-building walks (intrinsic to the
   output) but sort against the client's stamp point instead of the raw
   mouse cursor — an accuracy improvement, since the cursor is "usually
   parked off-canvas" once the camera bubble decoupled from it
   (`app.ts` transcript comment). A server-side spatial index for reads is
   explicitly out of scope (separate feature if ever needed).
2. **No server fallback.** `frameAtPoint` and `viewportCenter` are deleted
   from the server. A connected tab running a pre-deploy bundle publishes
   presence without a stamp and its utterances arrive unstamped (same as
   having no tab open) until the user reloads — a brief, self-healing
   window after one deploy. Keeping the geometry in two places would be
   exactly the "keep in sync" drift pattern the plugin design is killing.
   *(Chosen on recommendation while the user was away — veto point.)*
3. **Computation is a pure, reactive derivation** inside tldraw's
   `getUserPresence` hook (approach A below), not a timer-cadence loop.

## Approaches considered

- **A (chosen): pure derivation in `getUserPresence`.** tldraw 5.1's
  `useSync({ getUserPresence })` override returns
  `{ ...getDefaultUserPresence(store, user), meta: { stamp } }`, with the
  stamp computed by a dependency-free pure module from store records.
  Reactive — recomputes exactly when cursor/camera/page/frames change, so
  the stamp is never stale (someone dragging a frame under my viewport
  updates my stamp). Cost is O(frames on my page) per presence recompute,
  trivial next to tldraw's own per-pointer-move hit testing.
- **B (rejected): scheduler-cadence loop.** A 250 ms loop (the `AvOverlay`
  pattern) computes the stamp via `editor.getShapePageBounds` into a cache
  that `getUserPresence` reads. Rejected: stale-stamp windows; presence
  does not republish when *only* the cached stamp changed; adds a timer;
  couples to the editor instead of the store.
- **C (rejected): keep the computation server-side but async.** Moving
  `frameAtPoint` to a worker thread keeps the
  `getCurrentSnapshot()` serialization cost per utterance and offloads
  nothing from the VM.

## The contract: `presence.meta.stamp`

`TLInstancePresence.meta` is a free-form `JsonObject` that syncs to the
server's presence records. Each canvas client publishes:

```jsonc
meta: {
  stamp: {
    at:    { "x": 1200, "y": 300 },          // rounded ints, page space
    frame: { "name": "Drafting", "dist": 0 } // or null when the page has no frames
  }
}
```

- The page is **not** duplicated in the stamp — `currentPageId` sits on the
  same presence record and updates atomically with `meta`.
- **Semantics are identical to today's server logic, relocated:** if the
  mouse cursor is inside a frame (they're pointing at something), `at` =
  cursor and `frame` = that frame (`dist` 0). Otherwise `at` = viewport
  centre (what they're looking at; falls back to the cursor if
  camera/screenBounds are unavailable) and `frame` = nearest frame on the
  page by edge distance. `at` and `frame` always agree — the recorded point
  is the one the frame was matched against.
- An absent/malformed `stamp` means "no spatial position known" (old
  bundle, non-canvas presence). Consumers treat it as today's
  nobody-connected case.
- The type is defined in `client/src/presence/stamp.ts` and mirrored in
  `server/src/app.ts` with a keep-in-sync comment — flagged as an early
  candidate for `@ensembleworks/contracts` when that package lands
  (plugin design §6 step 1). Server parsing is defensive (shape-checked
  field by field, like `getCursorRefs` today), never trusting the wire.

## Client changes

- **New pure module `client/src/presence/stamp.ts`** (house style: logic in
  dependency-free, unit-tested modules): ports `pageIdOf`, `pagePoint`,
  `frameAtPoint`, and `viewportCenter` from `server/src/app.ts` and exposes
  `computeStamp(records, { currentPageId, cursor, camera, screenBounds })`.
  Operates on raw store records (no editor dependency) so it is trivially
  testable and reactive under `getUserPresence`.
- **`client/src/App.tsx`**: pass `getUserPresence` to `useSync` —
  `getDefaultUserPresence(store, user)` spread plus
  `meta: { stamp: computeStamp(...) }` built from the same default-presence
  fields (cursor, camera, screenBounds, currentPageId) and the store's
  frame records.

## Server changes

All in `server/src/app.ts` (the plugin split has not happened yet):

- **`CursorRef` gains `stamp: { at: {x,y}, frame: {name,dist}|null } | null`**,
  parsed defensively from `presence.meta.stamp` in `getCursorRefs`.
- **`POST /api/transcript`**: the geometry block (snapshot fetch, two
  `frameAtPoint` calls, `viewportCenter`) is replaced by reading the
  speaker's `ref.stamp`: `cursor` ← `stamp.at`, `frame` ← `stamp.frame`,
  `page` ← `ref.currentPageId` (unchanged). No stamp → all three null.
  **The transcript path no longer touches the document at all.**
- **`/api/frames` and `/api/frame`**: `byProximity` sorts against
  `ref.stamp?.at ?? ref.cursor` (the fallback here is point *selection*,
  not geometry — the raw cursor is already on the presence record). The
  `sortedBy` response block reports the point actually used so callers'
  interpretation stays truthful.
- **Deleted:** `frameAtPoint`, `viewportCenter`. (`pageIdOf`/`pagePoint`
  remain — the read endpoints still need them to build responses.)
- `pickCursor` (most-recently-active selection) is unchanged.

## Transcript entry format

Unchanged: `{ id, t, identity, name, text, page, cursor:{x,y}, frame:{name,dist} }`.
Only the *provenance* of `cursor`/`frame` moves (client-computed instead of
server-computed). No JSONL migration; existing minutes/conversation-map
consumers are unaffected.

## Trust & failure modes

- **No trust change:** the stamp is client-asserted, but so is the cursor
  position it replaces; everyone behind the access gateway already has
  shell access to the box.
- **Stale bundle after deploy:** unstamped transcript lines until reload
  (decision 2). Self-healing, bounded to one deploy window.
- **Multiple tabs per user:** `getCursorRefs` already yields one ref per
  presence record; transcript stamping picks the speaker's ref exactly as
  today (`find` by raw userId) — behaviour unchanged.
- **Nobody connected:** identical to today — null stamps, `sortedBy: null`,
  document-order reads.

## Testing

- **`client/src/presence/stamp.test.ts`** (new): cursor inside a frame
  (dist 0, `at` = cursor); cursor outside → viewport-centre point + nearest
  frame; no camera/screenBounds → cursor fallback; nested frames
  (parent-relative coordinates); page with no frames → `frame: null`;
  frames on other pages ignored.
- **`server/src/scribe-api.test.ts`** (rewrite of stamping cases): the
  presence fixtures (which already write full presence records including
  `meta`) gain `meta.stamp`; assert the entry carries it verbatim; a
  presence record *without* a stamp yields null `cursor`/`frame`; the
  `user:` prefix matching is preserved.
- **`server/src/canvas-api.test.ts`**: proximity-sorting cases updated to
  seed `meta.stamp` and assert sorting by the stamp point (and raw-cursor
  fallback when the stamp is absent).
- **Verification pass:** `npm run typecheck && npm run build`, full unit
  suites, plus a manual headless-browser check that a live tab publishes
  `meta.stamp` and a posted transcript line lands stamped.

## Success criteria

1. `POST /api/transcript` performs zero document reads (no
   `getCurrentSnapshot` call on that path).
2. Stamp semantics are behaviour-identical for a live, current-bundle tab
   (same frame chosen, same point recorded, `at`/`frame` agreement held).
3. `frameAtPoint`/`viewportCenter` no longer exist in server code.
4. All existing consumers (minutes/map agents, `bin/canvas` reads) work
   without change.
