// How hard the strip squeezes, given how much room it has.
//
// The strip draws a fixed run of faces — 24px circles overlapping by 6px, see
// `#canvas-av-dock` in canvas/dock/styles.ts — inside bb's page-header row. At
// desktop width that run is about what a title bar can spare (which is where
// MAX_DOCK_BUBBLES came from). At phone width, or in a split pane, the same six
// faces are wider than the row has to give, and the row does not clip: it is a
// flex line, so the overflow comes out of the page TITLE, which shrinks until
// it is an ellipsis. Presence quietly eating the name of the page you are on is
// the bug this module exists to prevent.
//
// A TIER ON THE CONTAINER'S WIDTH, NOT A FREE-SPACE BUDGET. The obvious
// measurement — row width minus the widths of the other children — is
// worthless here, and it is worthless in a way that looks precise. The header
// row is a flex line whose title child SHRINKS, so the line always exactly
// fills itself: measure "what is left over" at any viewport and the answer is
// ~0, because flex has already spent it. The honest signal is the one thing
// that is not a consequence of our own size — how wide the container the strip
// sits in actually is. Four tiers on that width, and nothing cleverer.
//
// THE TIERS ARE COARSE ON PURPOSE. There is no per-pixel face count, no
// gradually tightening overlap: four named layouts, so there are four things
// to look at rather than a continuum nobody can review, and so the CSS can name
// the tier (a `data-*` attribute) instead of carrying inline widths.
//
// THE BOTTOM TIER GIVES UP THE FACES ENTIRELY, and it exists because squeezing
// them was not enough. The user, with a screenshot of a thread header showing
// no title at all: "On narrow screens the presence icons hide the thread title
// (Perhaps if this is about to happen we should drop the presence icons and
// just keep the mic icon? Or maybe move them to a second header row? Thread
// title is important)". The first option is the one taken — a second header row
// would move bb's own layout, which is not ours to move. At `bare` the strip is
// the mic glyph and a count: the smallest thing that still says there are
// people here, still opens the popover that lists them, and still lines up with
// bb's buttons.
//
// HYSTERESIS IS THE HALF THAT IS NOT OBVIOUS. Width arrives from a live
// measurement, which means every intermediate pixel of a pane drag, and every
// appearance and disappearance of a scrollbar. A bare threshold turns a
// container resting ON a boundary into a strobe — 759 tight, 760 roomy, 759
// tight, at frame rate — and re-laying-out the strip at that cadence reads as
// a rendering fault, not as a responsive layout. So `nextSqueeze` requires the
// width to clear the boundary it is leaving by more than SQUEEZE_HYSTERESIS_PX
// before the layout changes, which makes the boundary a band a divider can be
// parked inside of.
//
// NO DOM AND NO MEASURING HERE. This project has no jsdom and no network to add
// one, so anything decided against a real element is decided where no test can
// reach it — the same split as anchor.ts and expand.ts. The caller measures and
// hands in what it read — both numbers, since WHICH of the row and the window
// counts is itself a judgement (`containerWidth`) — and every judgement about
// what those numbers mean is here, with tests/dock-squeeze.test.ts driving all
// of it.
import { MAX_DOCK_BUBBLES } from "./model.js";

/** The layouts that actually draw faces. Split out from `SqueezeTier` for
 * canvas/dock/face-geometry.ts, which answers "how big is a face, how far does
 * the next one cover it, where do its initials sit" — four questions that have
 * no answer at all for a tier that draws no faces. Naming the subset is what
 * lets that module keep an exhaustive record and refuse the question, rather
 * than carry an invented row of zeroes for `bare` that its own invariant tests
 * would then have to be taught to skip. */
export type FaceTier = "roomy" | "tight" | "cramped";

/** The four layouts the strip has. Named rather than numeric so the value can
 * be written straight onto the element for the stylesheet to switch on. */
export type SqueezeTier = FaceTier | "bare";

/**
 * The narrowest container that still gets the full, unsqueezed strip.
 *
 * Chosen against the shape of the row rather than against a device: below about
 * this width a page title of any real length is already competing with the
 * action buttons, so presence is no longer the only thing being squeezed and it
 * should give up its share first.
 */
export const SQUEEZE_ROOMY_MIN_PX = 760;

/**
 * The narrowest container that still gets four faces.
 *
 * MOVED UP FROM 480 by two hysteresis bands, and only to make room for the
 * floor below it — see SQUEEZE_BARE_MIN_PX for the arithmetic that forced it.
 * Nothing about four faces changed; what changed is that there is now a
 * boundary underneath this one, and the two of them need more than their two
 * half-bands of separation or the tier between them owns no width outright.
 * Rows between 480 and 576 get three faces where they used to get four, which
 * is the direction this whole module errs in anyway: presence gives up its
 * share of the row first.
 */
export const SQUEEZE_TIGHT_MIN_PX = 576;

/**
 * The narrowest container that still gets faces AT ALL. Below it the strip is
 * the mic and a count.
 *
 * WHERE 432 COMES FROM, in the order the reasons actually bind.
 *
 * 1. WHAT THE STRIP COSTS THE ROW, which is arithmetic off our own declarations
 *    rather than a guess. At cramped the strip is a 40px run of three faces
 *    (canvas/dock/face-geometry.ts: 3 x 20px overlapping by 10px) plus the 14px
 *    mic glyph, the 4px gap between them, 3px of padding each side, a 1px
 *    border each side and the 4px margin the element carries — 70px of the row.
 *    At tight it is a 61px run (4 x 22px overlapping by 9px) with 5px padding
 *    instead of 3, so 95px. Dropping from four faces to three therefore hands
 *    the row back 25px — 21 of face run and 4 of side padding — and nothing
 *    else in the row changes when it happens.
 *    So if SQUEEZE_TIGHT_MIN_PX is the width at which four faces stop being
 *    affordable, three stop being affordable 25px below it — which put the new
 *    floor in the mid-400s and nowhere near the 300s.
 *
 * 2. WHAT THE TITLE NEEDS, WHICH IS A JUDGEMENT AND NOTHING MORE. Somewhere
 *    around 120-160px is, in my estimation, the least a thread title can have
 *    and still be a title rather than an ellipsis — perhaps fourteen to
 *    eighteen characters. THERE IS NO MEASUREMENT BEHIND THAT: there is no
 *    browser in this spike, bb's header type size is not ours to read, and I
 *    have not seen this rendered. It is the number in this file most worth
 *    challenging, and the one to challenge FIRST if the report recurs. Note
 *    that it cancels out of the arithmetic in (1) — the title's share is the
 *    same on both sides of that subtraction — so it sets the ladder's overall
 *    generosity rather than this particular floor.
 *
 * 3. THE BAND, which is what actually fixed the digits. Every boundary needs
 *    SQUEEZE_HYSTERESIS_PX of dead band on each side, so adjacent floors have
 *    to be MORE than two bands apart — at exactly two the bands meet and the
 *    tier between them has no width that answers the same whatever was on
 *    screen before it, which is a tier you cannot reason about from a
 *    measurement alone. (Written as 96 first and caught by the test that asks
 *    each tier for such a width: cramped had none.) 432 with a tight floor of
 *    576 is three bands, so cramped owns 481-527 outright. That is why
 *    SQUEEZE_TIGHT_MIN_PX moved rather than this number being squeezed down to
 *    fit under the old one — squashing cramped would have retired a tier by
 *    accident.
 *
 * WHAT I COULD NOT CHECK, said plainly. Whether a phone-width thread header row
 * measures 390 or something smaller is not known here — it depends on bb's own
 * padding and on whether its side panel is inline or an overlay at that width,
 * and I have no browser to look in. 432 is above every current phone viewport
 * in portrait, so a full-width phone header lands in `bare` either way; that is
 * the reasoning, not an observation.
 *
 * THE COST, WHICH IS REAL. The ladder has one set of floors for all three of
 * anchor.ts's placements, and the "fixed" placement measures the WINDOW and has
 * no title to protect (that route renders no header at all). So a phone-sized
 * window now drops the faces on a route where nothing was competing for the
 * room. Accepted rather than overlooked: the count and the popover still carry
 * who is present, and the alternative — per-placement floors — is a second
 * ladder to keep correct, which is a bigger thing than this buys.
 */
export const SQUEEZE_BARE_MIN_PX = 432;

/**
 * How far past a boundary the width must travel before the layout follows it.
 *
 * Sized to swallow the two things that sit exactly on a boundary and twitch: a
 * scrollbar appearing and disappearing (~15px), and a pane divider being held
 * near a threshold. Larger would make the strip feel like it is lagging the
 * drag; smaller and a scrollbar alone could still flip it.
 */
export const SQUEEZE_HYSTERESIS_PX = 48;

/**
 * How many faces the strip draws at each tier.
 *
 * ZERO IS A REAL ANSWER AT `bare`, AND `buildDockModel` NOW TAKES IT AT ITS
 * WORD. This paragraph used to pose that as an open question, because
 * canvas/dock/model.ts's `facesThatFit` clamped with `Math.max(1, ...)` and so
 * would have drawn ONE face at the tier whose whole point is none. It was
 * answered by taking BOTH of the options it offered, not one: the clamp learned
 * the difference between "I could not measure" and "none, on purpose" (it
 * floors at 0, and only an ABSENT or non-finite limit still means
 * MAX_DOCK_BUBBLES), and canvas/dock/styles.ts additionally takes the
 * now-empty ".dock-bubbles" out of the box tree at this tier so its flex gap
 * goes with it.
 *
 * The fear behind the old floor — a broken measurement emptying a strip that
 * has people in it — is still answered, one module earlier and in this file: a
 * width that is not a measurement never becomes a `bare`, because
 * `chooseSqueeze` answers it with `cramped` and `nextSqueeze` holds the tier
 * already on screen. Noted here because this is where the 0 is decided, and
 * read out of model.ts rather than assumed.
 */
export function maxBubblesFor(tier: SqueezeTier): number {
  switch (tier) {
    case "roomy":
      // Imported, not repeated: the roomy tier IS the strip's normal cap, and
      // two constants that have to agree are one constant with a bug in
      // waiting. Squeezing narrows the strip; it never widens it.
      return MAX_DOCK_BUBBLES;
    case "tight":
      return 4;
    case "cramped":
      return 3;
    case "bare":
      // Not "as few as possible" — none. A single face is the worst of both:
      // it costs most of what three cost (a lone 20px circle against a 40px
      // run) and it says something false, since one face out of a room of five
      // reads as "one person is here". The count says the true thing in less
      // width.
      return 0;
  }
}

/** Is this number something that was actually measured? */
function isMeasurement(width: number): boolean {
  // Infinity and NaN are both reachable from a failed read, and 0 is what a
  // detached or not-yet-laid-out element reports — none of them is a width.
  return Number.isFinite(width) && width > 0;
}

/**
 * Which of the two things the caller can measure the tier is decided from.
 *
 * The strip has three placements (canvas/dock/anchor.ts) and only two possible
 * containers: bb's page-header row for the two in-row placements, and the
 * window for "fixed", the routes that render no header at all. So there is a
 * choice to make on every pass, and it is a choice about behaviour rather than
 * about DOM — which is why it is here, where a test can reach it, and why
 * dock.ts hands in two numbers instead of picking one.
 *
 * `rowWidth` is `null` for "there is no row", which is the fixed placement, and
 * the window is not a fallback there — it is the actual constraint on a strip
 * pinned to the corner of it.
 *
 * A row that IS there but does not measure (0 from a `display: none` ancestor
 * mid route change, or from a node detached for a frame; NaN from a failed
 * read) is the case worth stating out loud, because the tempting answer is
 * wrong: the window is not a stand-in for an unmeasurable row. A 500px row in a
 * split pane sits inside a 1440px window, so answering with the window would
 * repaint the strip roomy for a row with no room to give. Instead this passes
 * the not-a-measurement through, where the two consumers already have their own
 * answers for it — `nextSqueeze` holds the layout that is drawn, and
 * `chooseSqueeze`, which only runs when there is no layout yet, takes the safe
 * small end.
 */
export function containerWidth(rowWidth: number | null, viewportWidth: number): number {
  if (rowWidth === null) return viewportWidth;
  // Normalised to one value rather than passed on as-is, so a 0 and an
  // Infinity leave here indistinguishable: "not a measurement" is one state,
  // and giving it one representation keeps callers from growing a second
  // opinion about which flavour of unknown they got.
  return isMeasurement(rowWidth) ? rowWidth : Number.NaN;
}

/** The tiers in width order, so "is this width asking to widen or to narrow"
 * is a comparison rather than a table of six pairs. */
const TIER_RANK: Record<SqueezeTier, number> = { bare: 0, cramped: 1, tight: 2, roomy: 3 };

/**
 * The tier for a container of this width, with no history.
 *
 * The first decision of a strip's life, and the answer whenever there is no
 * previous layout to be sticky about. A width that is not a measurement answers
 * "cramped" — the safe end of the range, because the two failures are not
 * symmetrical: a strip that is too small is merely sparse and still legible,
 * while a strip that is too wide pushes bb's own header content out of the row.
 */
export function chooseSqueeze(width: number): SqueezeTier {
  if (!isMeasurement(width)) return "cramped";
  if (width >= SQUEEZE_ROOMY_MIN_PX) return "roomy";
  if (width >= SQUEEZE_TIGHT_MIN_PX) return "tight";
  if (width >= SQUEEZE_BARE_MIN_PX) return "cramped";
  return "bare";
}

/**
 * The tier for a container of this width, given the tier currently on screen.
 *
 * Same boundaries, plus the dead band. Expressed as "which direction is this
 * width asking us to move, and has it earned the move" — floors are raised by
 * the hysteresis when widening and lowered by it when narrowing, so each
 * boundary is one band wide from whichever side the width approaches it. That
 * two-sided shift is the part a naive implementation gets wrong: shifting the
 * floors in one direction only leaves the opposite crossing bare, and one bare
 * crossing is all a flap needs.
 *
 * Widening answers with the widest floor the width has cleared BY A BAND, which
 * is not always the tier `chooseSqueeze` would name. A cramped strip at
 * SQUEEZE_ROOMY_MIN_PX + 1 goes TIGHT: the roomy floor has been passed but not
 * cleared, and landing roomy would put the strip one pixel from a boundary it
 * never earned — exactly the position the band exists to keep it out of. Past
 * both bands it goes straight to roomy in one call; nothing is near a boundary
 * there, so there is nothing to be sticky about.
 *
 * A width that is not a measurement KEEPS the current tier — the opposite of
 * `chooseSqueeze`'s answer, deliberately. Mid-life, a 0 or a NaN is a
 * measurement failure (an observer firing on a hidden ancestor, an element
 * detached for a frame during a route change), not a narrow screen. Collapsing
 * a working desktop strip because one read came back blank is a visible bug;
 * holding the last good layout is invisible.
 */
export function nextSqueeze(current: SqueezeTier, width: number): SqueezeTier {
  if (!isMeasurement(width)) return current;

  // RENAMED FROM `bare`, which was the right word for "the thresholds with no
  // hysteresis on them" right up until a TIER was called bare. Two meanings on
  // one identifier in a nine-line function is how a reader ends up believing
  // this line asks whether the strip is already at the bottom of the ladder.
  const historyless = chooseSqueeze(width);
  if (historyless === current) return current;

  if (TIER_RANK[historyless] > TIER_RANK[current]) {
    // Widening. Strictly greater, so a width sitting exactly one band above a
    // floor has crossed it BY the hysteresis, not by more than it, and still
    // belongs to the tier it is in.
    if (width > SQUEEZE_ROOMY_MIN_PX + SQUEEZE_HYSTERESIS_PX) return "roomy";
    if (width > SQUEEZE_TIGHT_MIN_PX + SQUEEZE_HYSTERESIS_PX) return "tight";
    if (width > SQUEEZE_BARE_MIN_PX + SQUEEZE_HYSTERESIS_PX) return "cramped";
    return "bare";
  }

  // Narrowing. The mirror image: a width still within a band of a floor keeps
  // the tier above it.
  if (width >= SQUEEZE_ROOMY_MIN_PX - SQUEEZE_HYSTERESIS_PX) return "roomy";
  if (width >= SQUEEZE_TIGHT_MIN_PX - SQUEEZE_HYSTERESIS_PX) return "tight";
  if (width >= SQUEEZE_BARE_MIN_PX - SQUEEZE_HYSTERESIS_PX) return "cramped";
  // The end of the ladder, and the only branch with no floor under it: a
  // container narrower than the bare floor's band gets the same answer at every
  // width, because there is nothing left to give up.
  return "bare";
}
