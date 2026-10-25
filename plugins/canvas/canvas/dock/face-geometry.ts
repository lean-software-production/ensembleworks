// How big a face is, how far the next one covers it, and where its initials sit
// — one set of numbers per squeeze tier, with the relationship between them
// stated as something a test can check.
//
// WHY THESE ARE NOT JUST CSS. They were, and the CSS was wrong in a way no
// reader could see: three independent pixel literals per tier whose only
// connection was a prose comment above them claiming the type "stays 10px …
// faces you can still tell apart". At the cramped tier the arithmetic did not
// support that sentence — a 20px face covered by 12px leaves an 8px sliver,
// and two centred capitals at 10px sit in the middle of the circle, so what
// actually showed on every face but the last was part of the FIRST letter and
// nothing else. Numbers that have to agree with each other belong somewhere
// they can be made to prove it; canvas/dock/styles.ts interpolates them from
// here, so there is exactly one place for each of them to be wrong.
//
// THE INITIALS ARE THE IDENTITY. There is no photograph behind a face — the
// circle is a name-derived hue and one or two capitals (canvas/roster.ts's
// `initialsFor`). An overlapping stack covering part of every face is normal
// and fine; it is what a stack IS. Covering the letters is not, because it
// deletes the only thing that distinguishes one circle from another. So the
// invariant this module exists to hold is narrow and specific: whatever else
// a neighbouring face covers, the LEADING CAPITAL of every face is whole.
//
// WHICH SIDE IS COVERED, and it is worth stating because getting it backwards
// inverts every fix. `.dock-bubbles` is a plain flex row and `.dock-bubble` is
// `position: relative` with no `z-index` anywhere in the sheet, so paint order
// is DOM order and each face is drawn OVER the one before it. A face's exposed
// part is therefore its LEFT edge, which is why the cramped tier's glyph moves
// left rather than right.
//
// NO DOM AND NO MEASURING HERE, the same split as squeeze.ts and anchor.ts.
// This project has no jsdom, so anything decided against a real element is
// decided where no test can reach it.
// FaceTier, NOT the full SqueezeTier, AND THAT IS THE WHOLE OF THIS MODULE'S
// ANSWER TO THE "bare" TIER: it has no place here. Every export below asks a
// question about a circle — how wide is it, how much of it does the next one
// cover, where inside it do the initials sit — and a tier that draws no circles
// has no answer to any of them. The tempting alternative was a row of zeroes
// for `bare`, which would have been worse than useless: `exposedSlicePx` and
// `runWidthPx` would then return confident nonsense for it, and the invariant
// tests this file exists for (leading capital whole, glyph inside the circle)
// would have had to grow a special case to skip the one tier that cannot
// satisfy them. Taking the narrower type instead makes asking the question a
// compile error, which is the only kind of "not applicable" that stays true.
import type { FaceTier } from "./squeeze.js";

/**
 * The type size the initials are set at, at every tier.
 *
 * It does NOT shrink with the circle, and that is the point of the whole file:
 * the tier that has least room is the tier whose faces most need to stay
 * readable, so the second variable is the geometry around the type rather than
 * the type itself.
 */
export const INITIALS_FONT_PX = 10;

/**
 * How wide one capital is, as a fraction of the font size.
 *
 * AN ESTIMATE, AND UNVERIFIED — there is no browser in this project to measure
 * a glyph in, and this file will not pretend otherwise. In the system UI sans
 * the strip asks for (`-apple-system, "Segoe UI", system-ui`) a semibold
 * capital runs roughly 0.6em (I, J) to 0.75em (A, O, S), with M and W wider
 * still. 0.72 is deliberately at the upper end of the ordinary range rather
 * than at the average: this number is used to decide how much of a face must
 * stay uncovered, and the failure it guards against is a letter being clipped,
 * so overestimating costs a pixel or two of strip width and underestimating
 * costs the thing the strip is for. An M or a W will still lose a hair.
 */
export const CAPITAL_ADVANCE_RATIO = 0.72;

/** How wide one capital is, in px. */
export function capitalAdvancePx(): number {
  return INITIALS_FONT_PX * CAPITAL_ADVANCE_RATIO;
}

/**
 * How many capitals a face can hold.
 *
 * `initialsFor` returns at most two: the first letter of each of the first two
 * words when a name splits into words, the first two letters of the word when
 * it does not, and a lone "?" when it can find nothing. Two is the width to
 * plan for.
 */
export const INITIALS_MAX_CAPITALS = 2;

/** How wide the whole glyph run is, in px. */
export function initialsWidthPx(): number {
  return capitalAdvancePx() * INITIALS_MAX_CAPITALS;
}

/**
 * Where a tier puts its initials inside the circle.
 *
 * `"center"` is the ordinary answer and the one the eye expects on a circle it
 * can see all of. `{ leftPx }` is for a tier whose faces are covered so hard
 * that the centre of the circle is behind the next face — there the glyph is
 * pushed into the part that still shows, and the number is how far its left
 * edge sits from the face's own left edge.
 */
export type InitialsPlacement = "center" | { readonly leftPx: number };

export interface TierFace {
  /** The circle's width and height. */
  readonly diameterPx: number;
  /**
   * How far the NEXT face is pulled back over this one — the magnitude of the
   * negative `margin-left` in the stylesheet, kept positive here so the
   * arithmetic below reads as subtraction rather than as double negatives.
   */
  readonly overlapPx: number;
  readonly initials: InitialsPlacement;
}

/**
 * The three layouts, as numbers.
 *
 * ROOMY IS IN HERE TOO even though the stylesheet has no `[data-dock-squeeze=
 * "roomy"]` rule — the unsqueezed strip is written as the base `.dock-bubble`
 * rule, which is where these three numbers are interpolated. Listing it is what
 * lets the invariant tests cover all three tiers rather than the two that
 * happen to have a rule of their own.
 *
 * CRAMPED IS THE ONE WITH A CONSIDERED `leftPx`, and its two numbers were
 * chosen together. At the shipped 12px overlap the exposed sliver was 8px and a
 * centred glyph put the leading capital at x 2.8-10.0, so 5.2px of a 7.2px
 * letter reached the reader and none of the second one did.
 *
 * Relaxing the overlap alone cannot fix that: a centred pair of capitals runs x
 * 2.8-17.2 in a 20px circle, so showing it whole would need 17.2px of exposure
 * — a 2.8px overlap, LESS than the roomy tier's 6px, which would leave the
 * narrowest layout the widest one. So the glyph moves instead, and the overlap
 * relaxes only as far as the leading capital needs: 10px exposed, which costs
 * the three-face cramped run 4px (36px to 40px) and leaves it still far
 * narrower than tight's 61px.
 *
 * The trailing capital of a covered face is partly hidden at cramped, and that
 * is accepted rather than overlooked: with a 10px window and a ~7.2px capital
 * there is no exposure that shows both letters and none that hides the second
 * cleanly, so the choice is between a whole leading letter with the next one
 * peeking, and the sliver-of-one-letter this replaced.
 */
export const FACE_GEOMETRY: Record<FaceTier, TierFace> = {
  roomy: { diameterPx: 24, overlapPx: 6, initials: "center" },
  tight: { diameterPx: 22, overlapPx: 9, initials: "center" },
  cramped: { diameterPx: 20, overlapPx: 10, initials: { leftPx: 1.5 } },
};

/** How much of a face its neighbour leaves showing, in px. The last face in a
 * run has nothing on top of it and is exempt — this is every other face. */
export function exposedSlicePx(tier: FaceTier): number {
  const face = FACE_GEOMETRY[tier];
  return face.diameterPx - face.overlapPx;
}

/** How far the glyph run's left edge sits from the face's left edge, in px. */
export function initialsLeftEdgePx(tier: FaceTier): number {
  const { diameterPx, initials } = FACE_GEOMETRY[tier];
  if (initials === "center") return (diameterPx - initialsWidthPx()) / 2;
  return initials.leftPx;
}

/**
 * How far in from the face's left edge the circle stops clipping, in px.
 *
 * `.dock-bubble` is `overflow: hidden` on a `border-radius: 50%` box, so the
 * corners of the text's line box are outside the paintable area. The band is
 * measured at the WORST row of that line box — half the font size above and
 * below the centre — which is pessimistic on purpose: a capital's cap height is
 * well under the font size, so the real glyph sits inside a narrower band and
 * clears more than this says. Being wrong in that direction only costs a
 * fraction of a pixel of margin.
 */
export function roundingInsetPx(tier: FaceTier): number {
  const radius = FACE_GEOMETRY[tier].diameterPx / 2;
  const halfBand = INITIALS_FONT_PX / 2;
  return radius - Math.sqrt(radius * radius - halfBand * halfBand);
}

/**
 * How wide a run of `count` faces is at this tier, in px.
 *
 * The number the squeeze tiers exist to reduce: this is what the strip takes
 * out of bb's header row, and every pixel of it comes off the page title.
 */
export function runWidthPx(tier: FaceTier, count: number): number {
  if (count <= 0) return 0;
  const face = FACE_GEOMETRY[tier];
  return count * face.diameterPx - (count - 1) * face.overlapPx;
}
