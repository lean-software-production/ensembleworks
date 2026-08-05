# File viewer force-follow (baton) — design

Builds on 2026-07-27-file-viewer-rrweb-broadcast-design.md (rrweb present
mode, PR #71). Replaces the opt-in present/follow model with a single-baton
model: the shape always shows one person's live view, or a frozen copy of
the last one.

## Problem

Today a viewer can opt out of following (FollowingChip "stop"), and when
nobody presents everyone browses their own copy. People end up talking
about different states of the same document — follower sorted a table
differently, presenter says "click the third row", silent divergence.

## Model

Per file-viewer shape, exactly one of two states:

1. **Controller exists.** One person (the baton holder) interacts with the
   real iframe; everyone else sees their rrweb mirror. No opt-out. Camera
   stays free — mirroring is shape-scoped, never viewport-scoped.
2. **No controller.** The shape is frozen at the last-presented view (the
   mirror stays mounted, no new events). Nobody can scroll or interact
   without taking the baton. If no presentation ever happened (or the
   relay log is gone — server restart), the shape shows the plain
   document iframe, non-interactive, at its initial scroll position.

"Follower" stops being a mode anyone enters or leaves; it is the default
state of every non-controller. The three-state per-person model
(idle / presenting / following) collapses to two (controller / mirror).

## Transitions

- **Grab:** double-click into the shape (start editing) — the ONLY grab
  gesture (no header button). Sets the presence baton token. Works
  identically from the frozen state and as a steal.
- **Steal:** same gesture (double-click) while someone else holds the
  baton. Last-writer-wins by token ts (existing presentStore LWW). The
  old controller's editing session ends visually: their iframe flips to
  the mirror of the new controller. Label: header shows "〈name〉 has
  control" (or "You have control" for the holder) as passive text — not
  a button.
- **Release:** only by disconnect. Presence expiry removes the token
  (existing behaviour — the token rides presence meta, which dies with
  the session). No explicit "stop presenting" button. Deselecting or
  clicking away does NOT release the baton.

## UI changes (FileViewerShapeUtil)

- Remove: FollowingChip + "stop" opt-out, `optOutId` state, the
  Present/Presenting-stop toggle semantics, AND the "Take control"
  header button — double-click is the only grab/steal gesture, full
  stop (product decision: no button-based grab path at all).
- Controller attribution is passive text only: "〈name〉 has control"
  while a peer holds the baton, "You have control" while you do —
  neither is a button, nothing to click.
- Double-click-to-edit grabs the baton as a side effect of editing
  starting (editor editing-state watcher), so interaction intent and
  baton are the same thing.
- While a peer holds the baton, the local iframe stays mounted but
  hidden behind the mirror (existing behaviour); double-click still
  starts editing, which grabs the baton and swaps the real iframe back.
- Audience dots simplify: ringed = controller, solid = everyone else
  (present in room). The dimmed "not following" state disappears.
- Frozen state: mirror stays mounted showing the last frame, with a
  subtle header hint ("last presented view — double-click to take
  control"). No live indicator. The not-editing, non-frozen hint reads
  "double-click to take control" (was "double-click to interact").

## Relay / server changes

- The relay log (server/src/present-relay.ts) must survive presenter
  departure so late joiners can render the frozen last view: stop wiping
  the log on present-stop; retain the most recent presentation per shape
  until a new presentation replaces it or the server restarts. The
  10-minute idle TTL is replaced by replace-or-restart retention (bounded:
  one log per shape, existing per-log size caps stay).
- present-stop POST becomes optional (controller rarely stops cleanly);
  keep the endpoint for the degrade path but it no longer deletes the log.
- No new endpoints. Baton is still presence meta (presentStore token);
  no server-side baton authority — LWW by ts stays, thrash surfaced in
  UI (header shows current controller's name; steal shows a toast).

## Degrade paths (unchanged in spirit)

- rrweb broadcast degrades → scroll-fraction-only follow, still forced
  (no opt-out).
- Mirror can't get a stream → fallback to plain iframe tracking scroll
  fraction (existing mirrorFallback), still non-interactive for
  non-controllers.
- Relay log missing in frozen state → plain non-interactive iframe at
  initial position.

## Out of scope

- Camera/viewport follow (explicitly rejected — shape-scoped only).
- Debounce/locking against baton thrash (visible attribution only, v1).
- Explicit release button, idle timeout for a connected-but-away
  controller.
- v2 engine (canvas-v2 FileViewerShape) parity — v1 tldraw engine only,
  same as PR #71.

## Testing

- Unit: baton grab on edit-start; steal flips old controller to mirror;
  no opt-out path remains; frozen-state selector (no token → frozen).
- Relay: log survives present-stop; replaced on next presentation;
  late-join backlog serves last presentation after presenter left.
- Interaction contract (interaction-contracts workspace) for the
  double-click-grabs-baton gesture, or explicit `ux-contract: none`
  justification in the PR body if the surface turns out to be
  v1-tldraw-only (contracts cover canvas-editor/canvas-react/canvas-v2
  surfaces; this is legacy-engine UI).
- E2E smoke: two browsers — A takes control, B mirrors with no stop
  affordance; B double-clicks, A flips to mirror; A disconnects, B sees
  frozen frame; late joiner C sees frozen frame.
