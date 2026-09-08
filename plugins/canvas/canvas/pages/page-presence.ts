// WHICH PAGE THIS PEER TELLS EVERYBODY ELSE IT IS LOOKING AT, and when that is
// worth a wire write. No DOM, no store, no clock — the panel does the telling
// and canvas/presence-publisher.ts does the writing; this decides what and
// whether.
//
// Task W1 of docs/plans/2026-09-05-bb-canvas-multi-page-design.md (D-4).
//
// D-4's field already existed on both sides before anything here did:
// canvas-sync's optional `Presence.page` and canvas-react's `Cursors` filter
// (`isOnOtherPage`, opt-in behind a `currentPageId` prop). What was missing was
// a publisher that ever SET the field, so the filter was inert for every
// client and a peer on page 2 still had their cursor drawn on your page 1 —
// the "on the canvas" report that is wrong and looks right that D-4 exists to
// kill.
//
// TWO DECISIONS LIVE HERE, both small and both load-bearing, and they are in a
// module rather than in the panel because the panel is a .tsx and this project
// has no jsdom: a rule written there is a rule no test can reach.
//
// ABSENT/NULL MEANS UNKNOWN, NEVER "ELSEWHERE". Both readers treat null and
// undefined identically (canvas-sync's `Presence.page` doc comment and
// canvas-react's `isOnOtherPage` both say so), so "I have not told you" leaves
// a peer VISIBLE. Erasing somebody who simply has not said where they are
// would be the same confidently-wrong report as reporting them in the wrong
// place.

/**
 * What to publish as `Presence.page`, given the local view's current page.
 *
 * The empty-string case is the one worth a function. `page: ""` is not
 * "unknown" on the wire — it is a page id that no live page has, so every
 * reader computes `isOnOtherPage("", theirPage) === true` and hides this
 * cursor for everyone, everywhere. Unknown must therefore collapse to null,
 * which readers already understand, rather than to a falsy id which they do
 * not.
 *
 * (Whether an empty `currentPageId` can occur is not the point: the cost of
 * being wrong is invisible-to-everybody, and the cost of the guard is one
 * comparison.)
 */
export function presencePageFor(
  currentPageId: string | null | undefined,
): string | null {
  return typeof currentPageId === "string" && currentPageId.length > 0
    ? currentPageId
    : null;
}

/**
 * Whether a page write is owed to the wire.
 *
 * WHY THIS IS NOT MERELY AN OPTIMISATION. The publisher's page write BYPASSES
 * its throttle, because a switch has no later event guaranteed to carry it and
 * until it lands, everyone on the page just left keeps drawing this cursor as
 * though it were still there (the same argument `clearCursor` makes). A bypass
 * is only safe while it is rare, and the panel re-asserts the current page
 * from an effect — so "only when it actually moved" is the thing standing
 * between a user-rate write and a re-render-rate one with the throttle
 * disabled.
 *
 * A KNOWN PAGE BECOMING UNKNOWN IS ALSO NEWS: peers currently hiding this
 * cursor because it was demonstrably elsewhere must be told to stop.
 *
 * Both sides are normalised through `?? null` so the publisher's initial
 * "nothing published yet" state and a published null are one state, not two
 * that differ only in how they were spelled.
 */
export function isPageRepublishNeeded(
  published: string | null | undefined,
  next: string | null,
): boolean {
  return (published ?? null) !== next;
}
