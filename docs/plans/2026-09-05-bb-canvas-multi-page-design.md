# bb-plugin-canvas — multi-page canvas UX (design)

**Status:** implemented. **Date:** 2026-09-05.
**Scope:** `plugins/canvas/` only. Nothing here changes
`canvas-model` / `canvas-doc` / `canvas-sync` / `canvas-editor` /
`canvas-react` except one optional field (D-4). Client runtime behavior remains
unchanged; `client/` receives only the comment correction recorded under R-2.

---

## Summary

**The engine already supported multiple pages. At the time this design was
written, the plugin did not.** `docs/plans/2026-07-22-canvas-v2-pages.md` landed full multi-page
support across the clean-room packages on 2026-07-22, including a working
`PageSwitcher` UI in `client/src/canvas-v2/`. The bb plugin resolves exactly
one page at mount (`canvas/page.ts`'s `resolvePageId`) and renders no
switcher.

So this is not an engine project. It is a **port plus four bb-specific
decisions**: where the switcher lives given bb's header-space constraints,
how a page becomes URL-addressable inside a bb nav panel, whether cursors
become page-scoped, and what the presence dock says about somebody who is on
a page you are not.

---

## Verified ground truth

Everything in this table was read in the tree on 2026-09-05. Line numbers are
from that reading.

### What already works

| Capability | Where | Note |
|---|---|---|
| `Page.index` fractional string, `orderedPages`, `canonicalPageId` | `canvas-model` | A1; ordering is `(index, id)` |
| `currentPageId` in `EditorState` | `canvas-editor/src/editor.ts:58` | Editor-LOCAL, never persisted to the doc |
| `SetCurrentPage` view intent | `canvas-editor/src/editor.ts:927` | No doc write, no undo entry — a view change, like `SetCamera` |
| `CreatePage` / `DeletePage` / `RenamePage` / `MovePage` | `canvas-editor` | E3; `InverseOp` grew `putPage`/`deletePage`, so these ARE undoable |
| Render filter by page | `canvas-react/src/ShapeLayer.tsx:110` | `pageIdOf(snapshot, s) === currentPageId`, composed with z-order + culling |
| Same filter for embeds | `canvas-react/src/embed/EmbedLayer.tsx:106` | Terminals/screenshares/file-viewers are page-scoped too |
| Tools parent onto the current page | `canvas-editor/src/tools` (E2) | Reads `editor.get().currentPageId` live |
| Paste/duplicate target the current page | `canvas-editor/src/clipboard-intents.ts:78` | Same live read |
| Page CRUD on the doc | `canvas-doc/src/canvas-doc.ts:112-115` | `putPage` / `deletePage` / `listPages` |
| Switcher UI (tab bar) + pure intent math | `client/src/canvas-v2/PageSwitcher.tsx`, `page-switcher-dom.ts` | U1; tested, with `data-canvas-v2-page` hooks |
| Browser interaction contract | `switching-page-changes-rendered-shapes` | Z1 |

### What the plugin did before implementation

| Thing | Where | Current behaviour |
|---|---|---|
| Page resolution | `plugins/canvas/canvas/page.ts` | `canonicalPageId` or bootstrap `page:p`, once, at mount |
| Editor construction | `plugins/canvas/canvas/CanvasPanel.tsx:510-515` | `resolvePageId(peer.doc)` then `new Editor({ …, pageId })` |
| Switcher | — | Not mounted |
| Route | `plugins/canvas/app.tsx` | `app.slots.navPanel({ path: "canvas" })`, one route |
| Room | `plugins/canvas/canvas/wire.ts:7` | `ROOM_ID = "main"`, pinned |

The plugin's pre-implementation mount sequence was **the same shape** as the client's:
`client/src/canvas-v2/CanvasV2App.tsx:410-411` is line-for-line the same
`resolvePageId` → `new Editor({ …, pageId })` pair, and that app then mounts
`<PageSwitcher editor snapshot currentPageId={editorState.currentPageId} />`
at line 1227. At design time, the plugin was missing that mount and nothing structural.

---

## The two unknowns, now answered

Both were flagged as blocking before speccing. Both resolved by reading, not
by running anything.

### 1. Does bb's `navPanel` support sub-paths? — **Yes, in the path.**

`PluginNavPanelProps` (`@get-bb/plugin-sdk` bundled types, `bb-plugin-sdk-app.d.ts:344-355`):

> The route remainder after the panel root, `""` at the root. The panel's
> route is `/plugins/<pluginId>/<path>/*`, so a deep link like
> `/plugins/notes/notes/work/ideas.md` renders the panel with
> `subPath: "work/ideas.md"`. Navigate within the panel via
> `useBbNavigate().toPluginPanel(path, { subPath })` — browser back/forward
> then walks panel-internal history.

`BbNavigate.toPluginPanel(path, { subPath?, replace? })` is at line 2086 of
the same file.

This is materially better than the `?page=` query encoding assumed in the
earlier discussion, and it **removes the conflict with `where.ts`** entirely.
`canvas/dock/where.ts`'s `parseLocation` deliberately strips query and hash —
a query encoding would have been thrown away by exactly the code that needed
it. A path segment is not stripped. Better still, the panel branch
(`where.ts:80-88`) matches on the first three segments and **puts the whole
cleaned path in `.path`**, so `/plugins/canvas/canvas/retro` already parses
today, already round-trips through `jumpHref`, and already produces a working
jump link. It just currently *says* "on the canvas" for every page
(`locationLabel`'s `panel` case).

### 2. Can the Editor switch pages without a rebuild? — **Yes.**

`SetCurrentPage` mutates `EditorState.currentPageId` only
(`editor.ts:927`), and every consumer reads it live rather than reading the
frozen construction-time `editor.pageId` (D-1's crux; see `editor.ts:49-51`).
`ShapeLayer` re-filters on it. The client app proves the whole loop in
production code. `opts.pageId` stays what it always was: the seed.

---

## Decisions

### D-1. Pages within one doc — **not** rooms

Two different axes get called "multiple canvases" and they cost wildly
different amounts.

A **page** is same doc, same sync stream, same snapshot row, same AV session,
same transcript. The CRDT and the renderer already model it.

A **room** is a separate doc. The persistence layer is *already* room-keyed —
`canvas/store.ts` uses `canvas_snapshot(room PRIMARY KEY)` and
`canvas_updates(room, seq)`, and `CanvasRoomHost` takes a `room?` option — so
the temptation is to say rooms are nearly free. They are not, because the
dock stack around them is singular by construction: which room's transcript
does the thread panel show? Which room's AV session does the mic button join?
What does the sidebar's "N on the canvas" badge count? Every one of those is
a fresh product decision.

**Decision: pages.** Rooms stay a separate, later question — and the question
that actually motivates them ("a canvas per project, or per thread") should
be asked on its own terms rather than smuggled in as a page feature.

### D-2. Switcher surface — command palette + button-popover; tab bar only when wide

`PageSwitcher.tsx` is a horizontal tab bar (the 2026-07-22 plan's judgment
call #1, accepted there). Ported unchanged into the bb panel it costs a
permanent header row (~28px at its current `padding: '4px 6px'` plus a
border) and scrolls horizontally past roughly eight pages — on the same
narrow viewports the dock's squeeze tiers exist to defend
(`canvas/dock/squeeze.ts`).

bb offers two cheaper surfaces the standalone client did not have:

- **Command palette.** `app.tsx` already registers a `commandPaletteAction`
  ("Canvas: open room transcript"), so the pattern is established. A "Canvas:
  go to page…" command costs zero pixels and is the fastest path for anyone
  who knows the page's name.
- **A single button with a popover list**, mirroring the presence dock's own
  popover — which, as of 2026-09-02, is a `<body>`-parented `position: fixed`
  node with a tested edge clamp (`canvas/dock/popover-place.ts`). That
  machinery is reusable and already knows how not to fall off a narrow
  screen.

**Decision:** palette + button-popover as the primary surfaces. Port the tab
bar as a **wide-viewport-only** affordance, gated on the same measured
container width the squeeze ladder uses, so it never competes with the canvas
for space on a phone. Reuse `page-switcher-dom.ts`'s pure intent-builders
(`newPageIntents` / `deletePageIntents` / `movePageIntents`) verbatim — they
are DOM-free and already unit-tested, which is exactly the shape this spike's
no-jsdom rule demands.

### D-3. A page is addressable at `/plugins/canvas/canvas/<pageId>`

Given unknown #1, the page rides the `subPath`. Consequences:

- `resolvePageId(doc)` grows a requested-page argument:
  `resolvePageId(doc, subPath)` — adopt the requested page when it names a
  live page, else fall back to today's canonical-or-bootstrap behaviour. The
  fallback is not optional: a stale bookmark to a deleted page must land
  somewhere real rather than render an empty canvas.
- Switching pages calls `toPluginPanel("canvas", { subPath: pageId })` so
  browser back/forward walks page history, which the SDK comment promises.
- `where.ts`'s `BbLocation` panel variant gains an optional `subPath`, and
  `locationLabel`'s `panel` case learns to say *on the canvas — "Retro"*
  instead of a flat *on the canvas*. The jump href needs no change: `.path`
  already carries the full path.

**Open sub-question, deliberately unresolved here:** the URL currently would
carry a raw page **id** (`page:k3f9…`), which is ugly and leaks a mint
detail. A name slug is prettier but is not stable under rename and is not
unique. Recommend shipping the id first and treating slugs as a later
nicety — a wrong-looking URL is cheaper than a URL that breaks when somebody
renames a page.

### D-4. Presence-by-page — **do it**, reversing the 2026-07-22 deferral

The pages plan deferred this as judgment call #2 ("D-7. Presence-by-page —
DEFERRED"), and the reasoning was sound *for that context*: v2 presence is
per-room, page-scoping it needs a new `canvas-sync` `Presence` field, and a
peer on page 2 seeing a page-1 cursor is harmless because cursors are
world-space and simply land off the visible content.

**That reasoning does not transfer to bb.** The entire premise of the
presence dock is answering "who is where" — `canvas/locations.ts` exists
solely because the sync room could not see a bb tab that had not joined. A
dock that confidently reports somebody as "on the canvas" while their cursor
drifts through a page they are not on is the exact failure mode `where.ts`
already refuses for stale locations: *"a stale location is worse than none —
it is wrong and it looks right."*

**Decision:** add `page?: string | null` to `Presence`
(`canvas-sync/src/presence.ts:7`). Optional, following the precedent set by
`editing` in that same interface and for the same stated reason — an absent
key means "unknown", which is also what makes an older publisher compatible
rather than a decode error. Consumers (`Cursors`, `EditingIndicators`) hide
peers whose `page` is present and differs from the local `currentPageId`;
a peer whose `page` is absent keeps today's room-wide behaviour.

This is the one change outside the spike. It is additive, optional, and
backwards-compatible in both directions.

### D-5. The dock says which page

Two mechanisms, both cheap, and they compose:

1. **`document.title`.** `canvas/locations.ts`'s `LocationReport` already
   carries `title`, read by each tab from its own `document.title`
   specifically so the server never has to look anything up. Setting the
   canvas panel's title to include the page name makes the page name flow
   through the roster for free, with zero wire change.
2. **`subPath` in the reported path** (D-3), which is what makes the *jump
   link* land on the right page rather than merely describing it.

Both are needed: (1) is what the dock *says*, (2) is where the click *goes*.

---

## Task order

Deliberately ordered so each step is independently shippable and the
riskiest-to-reverse decision comes last.

| # | Task | Touches | Gate |
|---|---|---|---|
| 1 | Port `page-switcher-dom.ts` intent-builders into the spike | `plugins/…/canvas/pages/` | Unit tests, no DOM |
| 2 | Mount a page-switcher surface (palette + popover; tab bar wide-only) | `CanvasPanel.tsx`, `app.tsx` | Interaction contract (see below) |
| 3 | Undo-clamp | `CanvasPanel.tsx` keydown | Port `clampCurrentPageIntents` — see risk R-1 |
| 4 | `Presence.page` + cursor filter | `canvas-sync`, `canvas-react` | Optional field; unit tests both directions |
| 5 | Page name into `document.title` | `CanvasPanel.tsx` | Roster shows it end to end |
| 6 | `subPath` routing + `resolvePageId(doc, subPath)` + `where.ts` label | `page.ts`, `where.ts`, `CanvasPanel.tsx` | Deep link, back/forward, stale-id fallback |

Steps 1-3 give a working multi-page canvas. Steps 4-6 make the *presence*
story honest. Shipping 1-3 without 4 leaves the known-wrong cursor behaviour
in place, so if only part lands, say so explicitly rather than calling it
done.

---

## Interaction contracts (CLAUDE.md — mandatory)

Steps 2 and 3 touch interaction-bearing surfaces, so each declares a contract
in `@ensembleworks/interaction-contracts` or records
`ux-contract: none — <reason>` in the PR body. Z1's existing
`switching-page-changes-rendered-shapes` contract is the model and may be
extendable rather than duplicated. Per CLAUDE.md, any subagent brief for this
work must carry the RED-first obligation and the both-adapters rule
explicitly — a brief outweighs ambient context.

### Verdict for step 4 (`Presence.page` + cursor filter) — 2026-09-05: **none**

Settled after `scripts/ux-contract-presence.test.ts` was re-run against the
real change set (it had only ever scored an empty diff, because nothing was
committed yet, and so passed vacuously). It genuinely fails on the real list:

```
UX_CONTRACT_CHANGED_FILES='canvas-react/src/overlay/Cursors.tsx
canvas-react/src/cursors.test.ts
canvas-sync/src/presence.ts
canvas-sync/src/presence.test.ts' bun scripts/ux-contract-presence.test.ts
# AssertionError: diff touches interaction-bearing path(s) [...] without
# touching the interaction-contracts module ... and without a
# 'ux-contract: none — <reason>' marker in the PR body.
```

Note the env var is **newline**-separated, not comma-separated
(`realChangedFiles()` splits on `\n`); a comma-joined string is read as one
long filename, which happens to still trip the gate but garbles the message.

**Why not extend `switching-page-changes-rendered-shapes`.** Not because
extending is expensive — because the extension could not be made RED, and
CLAUDE.md says an unreachable RED is a STOP-and-report, not a licence to skip
to the fix.

1. The browser runner (`e2e/lib/contracts.ts`) drives a live `?engine=v2`
   **client** room. There, `adaptPresence`
   (`client/src/canvas-v2/presence.ts`) maps only `{ cursor: p.cursor }` — the
   new `page` field never reaches `RemotePresence` — and
   `CanvasV2App.tsx:1257` renders `<Cursors>` with no `currentPageId`. So
   `isOnOtherPage` returns `false` for every peer in the client, filter
   present or absent. A two-actor contract asserting "B's cursor disappears
   when A switches page" would fail identically before *and* after the change.
2. The FSM runner has no DOM and no presence at all; a rendered peer cursor is
   browser-only by construction (the same class as `peerEditingIndicator`,
   already a throw-stub).
3. The only consumer that passes `currentPageId` is the bb plugin panel
   (`plugins/canvas/canvas/CanvasPanel.tsx`), and the framework has no
   bb-plugin lane — neither runner mounts it.
4. Manufacturing a lane by making the client page-aware would reverse
   `2026-07-22-canvas-v2-pages.md`'s **D-7** for the client — which **D-4**
   above explicitly declines to do. Changing shipped product behaviour to feed
   a gate is the wrong trade.

**The marker, verbatim, for the PR body** (one line — the gate's regex does not
span newlines):

> ux-contract: none — no interaction surface is added or changed. The cursor page filter is a render-time predicate over NETWORK state with no gesture (`Presence.page` is an optional wire field, `Cursors`' `currentPageId` is an optional prop, `isOnOtherPage` is pure), and the only other interaction-bearing file in this diff, client/src/canvas-v2/bootstrap-page.ts, is a COMMENT-ONLY correction with zero executable change. No contract runner can reach the filter either: the browser runner drives a `?engine=v2` client room, where `adaptPresence` (client/src/canvas-v2/presence.ts) maps only `{cursor}` and CanvasV2App.tsx:1257 passes no `currentPageId`, so the filter is inert there; the FSM runner has no DOM or presence at all; and the only page-aware consumer is the bb plugin panel, which neither runner mounts. Making it reachable would mean reversing docs/plans/2026-07-22-canvas-v2-pages.md D-7 for the client, which 2026-09-05's D-4 explicitly declines to do — so an extended `switching-page-changes-rendered-shapes` would be RED before AND after, not RED-then-GREEN.

**Revisit when** the client itself becomes page-aware in presence (i.e. when
D-7 is genuinely reversed for the client, not just for bb). At that moment the
browser runner *can* observe this, the RED becomes reachable, and this opt-out
should be replaced by a real contract — probably a `peerCursorVisible(peerKey)`
`Obs` addition, implemented in `e2e/lib/contracts.ts` and throw-stubbed in
`canvas-editor/src/contracts/fsm-runner.ts`.

Steps 2 and 3 (the switcher surface and the undo-clamp) are separate
declarations and are **not** covered by this verdict.

---

## Risks and open questions

**R-1. Undo can strand `currentPageId`.** Already discovered and solved
upstream: `CanvasV2App.tsx:806-820` clamps after both undo and redo, because
`SetCurrentPage` has no undo inverse, so undoing a `CreatePage` +
`SetCurrentPage` batch removes the page while `currentPageId` still names it
— and the render filter then paints nothing. Redo can strand it the same way
by reintroducing a `DeletePage`. The spike will inherit this the moment it
gains page mutation, and its own undo stack is a separate
editor-level inverse-intent implementation. **Port
`clampCurrentPageIntents` (`client/src/canvas-v2/page-switcher-dom.ts:110`)
with the switcher; do not rediscover this.**

**R-2. Stale comment in `client/src/canvas-v2/bootstrap-page.ts`.** Its
header still claims *"canvas-react's ShapeLayer/EmbedLayer never filter by
page"*. R1 landed that filter (`ShapeLayer.tsx:110`), so the comment predates
the code and is now false. It is load-bearing in that doc comment's argument
about the bootstrap tail being "correctness-neutral for rendering" — which no
longer holds the same way. Not a bug in this design's path, but worth a
one-line fix so the next reader is not misled.

**CORRECTED 2026-09-05.** Both line refs verified (`ShapeLayer.tsx:110`,
`embed/EmbedLayer.tsx:106` — the same `pageIdOf(snapshot, s) ===
currentPageId` predicate), and the argument they undercut was rewritten rather
than the sentence merely deleted. The conclusion changed: the tail splits in
two. When the room's real default page **is** `page:p` — the common case, since
that literal is the codebase's one convention — the late backfill merges onto
the page we bootstrapped and the filter changes nothing. When it is **not**
(`page:p` deleted, or a room minted from `page:<base36>` ids), the
bootstrapped page is a second, empty one, `currentPageId` names it, and every
real shape is filtered out of both layers: an empty canvas over intact
content. `repair()` does not catch it (those shapes are not orphans) and
`clampCurrentPageIntents` does not either (`page:p` is live, so nothing
dangles). Accepted, not fixed — it is recoverable via the PageSwitcher and
needs both a missed readiness ack and a `page:p`-less room — but it is now
documented as a **visible** tradeoff. Also **not** claimed: that a later cold
load heals itself; `canonicalPageId` sorts lexicographically and a minted id
can land either side of `page:p`.

**R-3. Doc growth.** One doc holds every page's shapes, so page count grows
the snapshot and every client loads all of it. Fine at spike scale.
The room axis (D-1) is the eventual answer if it ever isn't.

**R-4. Page id in the URL** — see D-3's open sub-question.

---

## Not verified

Stated plainly so nobody treats them as established:

- **No browser was run for this design.** Every geometry and layout claim
  (the tab bar's ~28px cost, how it behaves past eight pages) is read off the
  stylesheet, not observed.
- **`toPluginPanel`'s back/forward behaviour is the SDK's documented
  promise**, quoted above from the bundled types. It has not been exercised
  against the running bb host, and the plugin's own history with bb's router
  is a caution: `canvas/dock/navigate.ts` verifies its `pushState` attempt
  and falls back precisely because that behaviour is undocumented and could
  change silently. `toPluginPanel` is documented, which is a better footing —
  but it is still somebody else's router.
- **The 2026-07-22 plan's D-7 rationale was read, not re-derived.** D-4 above
  reverses its recommendation for bb specifically; it does not claim the
  original call was wrong for the client.
