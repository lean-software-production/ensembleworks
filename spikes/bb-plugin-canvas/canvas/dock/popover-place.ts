// Where the popover goes, on both axes.
//
// THE MODULE ANSWERED HALF A QUESTION AND NOW ANSWERS THE WHOLE ONE. It began
// as `placePopover`, a horizontal nudge on top of a resting CSS position, for
// the first bug the user reported (a popover hung off the left of a narrow
// screen). The second report is a different failure with the same symptom: "the
// popover is showing behind the left side menu", and the screenshot shows it
// cut off dead on the vertical line where bb's left navigation panel ends, the
// faces to the left of that line simply GONE rather than dimmed. The reading
// taken is that this is CLIPPING rather than z-order: an absolutely-positioned
// box is clipped by any ancestor with `overflow: hidden` that also contains its
// containing block, and this box's containing block is `#canvas-av-dock`, which
// lives deep inside bb's panes. A straight vertical cut at a pane boundary with
// nothing showing through is what overflow does; stacking dims and overlaps
// rather than deleting, and a z-index cannot restore pixels that were never
// painted.
//
// THAT READING IS A DIAGNOSIS FROM A DESCRIBED SCREENSHOT, NOT AN OBSERVATION,
// and the next reader should know exactly how thin it is. There is no browser
// in this spike, so nothing below was checked in a running app: not which
// ancestor does the clipping, and not the stacking either — this popover
// declares z-index 45 (canvas/dock/styles.ts) and that file's own note puts
// bb's modal layers at 50+, but the z-index of the pane doing the cutting was
// never read, so "45 is above it" is an assumption and not a measurement. What
// would falsify the whole diagnosis is cheap and specific: if the next task
// makes this popover `position: fixed` on <body> and the same cut survives,
// then it was never the ancestor chain and the stacking is where to look next.
//
// The fix (the next task's, in dock.ts and the stylesheet) is to take the
// popover out of that ancestor chain entirely: `position: fixed`, parented to
// <body>, where no pane's overflow can reach it. A fixed box has no resting
// position to nudge — its containing block is the viewport — so it needs
// viewport coordinates for BOTH axes. `placePopoverBox` is that answer;
// `placePopover` stays as the horizontal policy it always was, and is CALLED by
// the new function rather than copied into it, because two clamps drift.
//
// -- the original note, still the horizontal half of the story ---------------
//
// The popover is `position: absolute; right: 0` against `#canvas-av-dock` (see
// the popover block in canvas/dock/styles.ts), so it hangs LEFTWARD from the
// strip's right edge, up to `min(80vw, 420px)` wide. That is the right shape
// for a control at the right of a bar, and it is wrong in exactly one
// situation, which is the one the user reported: "when we show the dock it
// doesn't get clipped by the side of the screen on narrow devices... most
// pronounced on the thread screen; where we have quite a few buttons on the
// right."
//
// WHY THE THREAD ROUTE IS THE WORST CASE. The strip is prepended into the
// header's action cluster — anchor.ts level 1, "before", where it becomes the
// cluster's FIRST child — so on a thread it sits in FRONT of several of bb's
// own buttons and its right edge is some distance in from the viewport's. Hang
// a 420px popover from a right edge that is itself a few hundred pixels short
// of a phone-width screen and the popover's LEFT edge lands off the screen.
// Nothing clamps it today: `right: 0` is the whole of the current positioning.
//
// THIS IS A FUNCTION OF WHERE THE STRIP ENDED UP, NOT A CONSTANT OFFSET, which
// is why the answer has to be computed per open rather than baked into the CSS.
// The other two placements put the strip much closer to the viewport's right
// edge — "row" makes it the trailing child of the header row, and "fixed" pins
// it into the corner — and from there the same popover fits, or overflows the
// OTHER side. One rule covering all three: keep the box inside the viewport's
// margins, moving it as little as possible.
//
// NO DOM AND NO MEASURING HERE. Same split as anchor.ts and squeeze.ts: this
// project has no jsdom and no network to add one, so anything decided against a
// real element is decided where no test can reach it. The caller measures — a
// DOMRect from the strip, an offsetWidth from the popover, the window's width —
// and every judgement about what those numbers mean is here, with
// tests/dock-popover-place.test.ts driving all of it.

/**
 * How close the popover may come to the viewport edge.
 *
 * 8px, and the reason is that it is the gap the strip's own fixed placement
 * already leaves: `right: 52px` there is bb's 16px gutter plus its 28px corner
 * button plus 8, measured against the running app (canvas/dock/styles.ts). So
 * this is not a new number in the design, it is the existing one.
 *
 * It also has to survive being small. The popover carries a 12px border-radius
 * and a 1px border, so the visible corner curves away from the edge for most of
 * those 8px — a 0 margin would read as "clipped" even when the box is exactly
 * on-screen, which is the complaint this whole module answers. Going the other
 * way, matching bb's full 16px gutter was rejected: the popover is an overlay,
 * not a column of page content, and lining it up with bb's content grid would
 * claim a relationship to the page's layout it does not have. It also costs
 * 16px of the 312px the 80vw cap leaves on a 390px phone, and `.dock-controls`
 * already wraps its four labelled buttons at that width.
 */
export const POPOVER_EDGE_MARGIN_PX = 8;

export interface PopoverPlacement {
  /**
   * Pixels to translate the right-aligned popover along x. 0 means
   * "right-aligned to the strip, which already fits" — the common case, and the
   * one that stays pixel-identical to today, because a popover that was never
   * in trouble must not move. Positive slides it right (its left edge was
   * off-screen), negative slides it left.
   */
  readonly shift: number;
}

/** Is this number something that was actually measured? */
function isMeasurement(value: number): boolean {
  // Infinity and NaN both arrive from a failed read, and 0 is what a detached
  // or not-yet-laid-out element reports — none of them is a width. Same test,
  // and same wording, as squeeze.ts: "not a measurement" is one state wherever
  // the dock meets a number it did not get to check.
  return Number.isFinite(value) && value > 0;
}

/**
 * How far to slide the popover, given where right-aligning would have put it.
 *
 * Reads as one sentence per edge, in the order the edges lose. If the RIGHT
 * edge is past its margin, pull left by exactly the overhang — reachable from
 * the "fixed" placement, which pins the strip into the corner, and from any
 * host that ever puts the action cluster flush with the window. Then, if the
 * LEFT edge is still past its margin, push right until it is on it — the
 * reported bug, and the branch that runs on a thread route at phone width.
 *
 * BOTH CORRECTIONS ARE THE SHORTFALL ITSELF, never a fixed nudge and never a
 * re-centring. The popover is the answer to a click on a control in the strip;
 * moving it further than necessary breaks the visual tie back to the thing that
 * opened it, and a popover that has drifted to the middle of the screen reads
 * as a dialog rather than as this control's menu.
 *
 * THE LEFT EDGE WINS WHEN BOTH CANNOT BE SATISFIED — a popover wider than
 * `viewportWidth - 2 * margin`, which no combination of positions can fit. The
 * left-hand correction runs second precisely so that it overrides, pinning the
 * left edge at the margin and letting the right overhang. The popover's content
 * flows from its left edge — `.dock-controls` and `.dock-faces` are both
 * wrapping flex rows with no `justify-content`, so both start there — which
 * makes the left edge where its meaning starts: a reader who can see the start
 * of every row can still use it, while pinning the right instead would hide the
 * first button and the first face.
 * A CSS max-width that accounts for the margins should make this branch
 * unreachable in practice — it is here so the function is total, not because we
 * expect to arrive in it.
 *
 * AN INPUT THAT IS NOT A MEASUREMENT ANSWERS 0, which is today's rendering
 * exactly: right-aligned to the strip, as `right: 0` already does. A failed
 * read must never be the reason the popover jumps across the screen, so the
 * worst this module can do is leave things as they are. `margin` is held to the
 * same standard even though it is a caller's constant rather than a
 * measurement, and a NEGATIVE margin is refused rather than honoured: it would
 * be a request to push the popover deliberately off the edge, which is the one
 * outcome this module exists to prevent. Zero is allowed — that is a caller
 * saying "flush with the edge is fine", which is a position, not a failure.
 */
export function placePopover(input: {
  /** The strip's right edge in viewport coordinates (a DOMRect .right). */
  readonly anchorRight: number;
  /** The popover's laid-out width. */
  readonly popoverWidth: number;
  readonly viewportWidth: number;
  /** Defaults to POPOVER_EDGE_MARGIN_PX. */
  readonly margin?: number;
}): PopoverPlacement {
  const { anchorRight, popoverWidth, viewportWidth } = input;
  const margin = input.margin ?? POPOVER_EDGE_MARGIN_PX;

  // anchorRight is checked for finiteness only, not for sign: a strip scrolled
  // or animated to a negative x is an unusual position, but it is a real one,
  // and the clamp below has a correct answer for it. The two widths and the
  // margin are the ones where a non-positive value means "I did not get a
  // number", except that a 0 margin is a legitimate request.
  if (!Number.isFinite(anchorRight)) return { shift: 0 };
  if (!isMeasurement(popoverWidth)) return { shift: 0 };
  if (!isMeasurement(viewportWidth)) return { shift: 0 };
  if (!Number.isFinite(margin) || margin < 0) return { shift: 0 };

  const left = anchorRight - popoverWidth;
  const maxRight = viewportWidth - margin;

  let shift = 0;
  if (anchorRight > maxRight) shift = maxRight - anchorRight;
  if (left + shift < margin) shift = margin - left;

  return { shift };
}

/**
 * The gap between the strip and the popover hanging from it.
 *
 * 6px, READ OFF THE STYLESHEET rather than chosen here: the popover rule in
 * canvas/dock/styles.ts used to say `top: calc(100% + 6px)`, so this is the
 * number the absolute placement drew all along, moved to where the fixed-
 * position arithmetic can reach it. It is not a new decision and nothing about
 * the popover's appearance changed because of it.
 *
 * THAT DECLARATION IS NOW GONE from the sheet — the popover is `position:
 * fixed` on <body> and both of its offsets are written from here — so this
 * constant is no longer a copy of a number in the CSS, it is the only place the
 * number exists. Said plainly because the paragraph above reads like a
 * cross-reference and a reader could go looking for the original.
 *
 * It is smaller than POPOVER_EDGE_MARGIN_PX on purpose, and the two are not the
 * same kind of number: this one is the visual tie between a control and the
 * menu it opened (near enough to read as attached), that one is clearance from
 * the edge of the screen. Making them equal would be a coincidence, not a
 * simplification.
 */
export const POPOVER_ANCHOR_GAP_PX = 6;

/**
 * The layer bb's own dialogs, popovers and command palette are believed to
 * occupy.
 *
 * INHERITED BELIEF, NOT A MEASUREMENT. The figure ("50+") is the one
 * canvas/dock/styles.ts has carried since before this module existed; nothing
 * in this spike has read bb's stylesheet and there is no browser here to read
 * it in. It is named rather than left as prose so that the ONE thing that can
 * be checked — that this plugin's popovers stay under it — is checkable, and so
 * that if somebody ever does measure bb's layers there is exactly one number to
 * correct.
 */
export const BB_MODAL_LAYER_FLOOR = 50;

/**
 * The layer every <body>-portalled popover in this plugin paints on.
 *
 * WHY THIS IS A CONSTANT AND NOT A NUMBER AT EACH SITE. There are two such
 * popovers now — the presence dock's (canvas/dock/styles.ts's
 * `#canvas-av-dock-popover`) and the page switcher's (canvas/pages/
 * PageSwitcher.tsx) — and the second one arrived carrying 2147483000, which
 * silently reversed a decision the first one had already argued out at length.
 * A z-index written inline in a .tsx is unreachable by every test in a project
 * with no jsdom, so it could be moved in either direction and nothing would
 * notice. Here, tests/page-switcher-layering.test.ts notices.
 *
 * WHY 45, quoting the decision rather than restating it (canvas/dock/styles.ts,
 * the `#canvas-av-dock-popover` z-index note):
 *
 *   "WHY NOT HIGHER. bb's dialogs, popovers and command palette sit at 50+ …
 *    A call control is not more important than the dialog you just opened, and
 *    an overlay that cannot be dismissed by the thing on top of it is a trap.
 *    WHY NOT LOWER: the whole point of leaving the pane is to be paintable
 *    over it."
 *
 * THE PAGE POPOVER IS THE SAME KIND OF THING and inherits the same answer for
 * the same reason. It is dismissed by Escape and by an outside POINTERDOWN, so
 * a bb surface opened FROM THE KEYBOARD (the command palette's shortcut is the
 * obvious one) dismisses it not at all — and a page list painted over the
 * palette the user just summoned, with no pointer gesture that will clear it,
 * is precisely the trap above.
 *
 * WHAT IS NOT KNOWN, unchanged from styles.ts: whether 45 is genuinely above
 * bb's ORDINARY chrome. If a popover escapes its clip and still paints under
 * something, this is the number to look at first.
 */
export const POPOVER_Z_INDEX = 45;

/** Where the popover's top-left corner goes, in viewport coordinates. */
export interface PopoverRect {
  readonly left: number;
  readonly top: number;
}

/** The four edges `placePopoverBox` places against — one DOMRect's worth,
 * named so a caller can hand over a rect it measured or the anchorless value
 * below without spelling four properties out twice. */
export interface PopoverAnchor {
  readonly anchorLeft: number;
  readonly anchorRight: number;
  readonly anchorTop: number;
  readonly anchorBottom: number;
}

/**
 * The anchor to place against when there is NO anchor element at all.
 *
 * WHY THIS IS NOW A REAL CASE, and not the "detached element" curiosity the
 * NaN fallback below was written for. The canvas toolbar's "Pages" button was
 * removed at the owner's request on 2026-09-06, and it was the page popover's
 * anchor. That popover stays — it is the type-a-name-to-jump fast path and, far
 * more importantly, the only KEYBOARD path to REORDERING pages now that
 * reordering is a pointer drag (canvas/pages/tab-drag.ts) — and it is still
 * opened by bb's command palette. On a column too narrow for the tab strip
 * (canvas/pages/page-tabs-fit.ts) there is then nothing on screen to hang it
 * from.
 *
 * THE COMPONENT USED TO ANSWER THAT WITH AN INLINE `if (!anchor) return;`,
 * which left the box wherever it was last placed — a decision written in a .tsx
 * that no test in this jsdom-free project could read, and one whose "position"
 * was whatever a previous open happened to compute. Handing this value to
 * `placePopoverBox` instead routes the case through the module's own,
 * already-tested fallback: the SAFE CORNER at `(margin, margin)`. That corner
 * is not a good position and is not claimed to be one; it is the only position
 * that is certainly on-screen, which makes an anchorless open a visible oddity
 * rather than an invisible disappearance.
 *
 * NaN RATHER THAN A SENTINEL OBJECT on purpose: "I did not get a number" is
 * already this module's vocabulary (`isMeasurement`, and every guard written
 * against it), so an anchorless open takes the path a failed measurement takes
 * instead of adding a second one beside it.
 */
export const NO_POPOVER_ANCHOR: PopoverAnchor = {
  anchorLeft: Number.NaN,
  anchorRight: Number.NaN,
  anchorTop: Number.NaN,
  anchorBottom: Number.NaN,
};

/** The margin to actually use, given what the caller asked for. Shared by both
 * axes and by the fallback corner, so a caller cannot get one margin on x and
 * another on y. Same judgement as `placePopover`: a negative margin is a
 * request to hang the box off the edge, which is the outcome this module exists
 * to prevent, so it is refused; zero is a position and is honoured. */
function usableMargin(margin: number | undefined): number {
  const asked = margin ?? POPOVER_EDGE_MARGIN_PX;
  return Number.isFinite(asked) && asked >= 0 ? asked : POPOVER_EDGE_MARGIN_PX;
}

/** The gap to actually use. Same rule: zero means "flush against the strip",
 * which is a look someone could legitimately ask for; a negative gap would slide
 * the popover UP over the control that opened it, which is never what was
 * meant. */
function usableGap(gap: number | undefined): number {
  const asked = gap ?? POPOVER_ANCHOR_GAP_PX;
  return Number.isFinite(asked) && asked >= 0 ? asked : POPOVER_ANCHOR_GAP_PX;
}

/**
 * Where to put a FIXED-POSITION popover, in viewport coordinates.
 *
 * HORIZONTAL IS `placePopover`, unchanged and uncopied — right-aligned to the
 * anchor, clamped inside the margins by the smallest movement that works, left
 * edge winning when the box cannot satisfy both. The only difference is what
 * comes out: `placePopover` describes the correction, this describes the
 * resulting edge, and the one is the other plus the right-aligned start
 * position. Calling it rather than reimplementing it is the point — a second
 * copy of a clamp is a second clamp to keep correct.
 *
 * VERTICAL IS BELOW, THEN FLIPPED, THEN CLAMPED, in that order, and the order
 * is the decision. Below-by-`gap` is the resting position and the one the
 * stylesheet already draws. If the box would run past the bottom margin, FLIP
 * IT ABOVE before clamping it, because a flip preserves the whole popover
 * whereas a clamp starts trading it away — a clamped box slides up over the
 * strip it belongs to and, if it is tall enough, off the top of the screen,
 * while a flipped one is intact and still visibly attached to its control.
 * Flipping is only worth it when above is genuinely roomier, which is why the
 * two rooms are compared rather than the flip being tried first: a strip near
 * the TOP of a short viewport has almost nothing above it, and flipping there
 * would trade a box that is mostly visible for one that is mostly not.
 *
 * WHEN NEITHER SIDE FITS, THE BOTTOM MARGIN WINS AND THE TOP RUNS OFF — the
 * opposite end from the horizontal rule, and deliberately so. Horizontally the
 * left edge wins because every row of content starts there. Vertically the
 * bottom wins because of what is AT the bottom: dock.ts appends this popover's
 * children in the order (faces, controls, status), so the actionable half — all
 * four labelled buttons — is below the faces. Cutting the top costs some faces
 * off a list that is already an overflow of the strip; cutting the bottom would
 * cost every button the popover exists to offer.
 *
 * AN INPUT THAT IS NOT A MEASUREMENT CANNOT ANSWER "DO NOT MOVE" ANY MORE. For
 * the absolute popover that was the whole fallback — a shift of 0 left the CSS
 * to place the box — but a fixed box has no CSS position to fall back to: this
 * IS the position, and a NaN offset is not "unchanged", it is a box the browser
 * places at its static position, i.e. back inside the pane we just escaped, or
 * nowhere useful. So the fallback is the SAFE CORNER, `(margin, margin)`:
 * certainly on-screen, obviously detached from the strip, and therefore a
 * visible oddity rather than an invisible disappearance. It is chosen per axis,
 * not for the whole box — a failed height read has no business moving the box
 * sideways.
 *
 * The corner is only reached when the ANCHOR is unreadable. An unreadable
 * VIEWPORT is different and keeps the resting position instead: without a
 * viewport there is no margin to clamp against, and the position the popover
 * has always been drawn at is a better answer than a corner. That is the same
 * judgement `placePopover` makes for an unreadable viewport width, and it is
 * the reason a not-yet-laid-out popover (0 by 0, which is what a `display:
 * none` box measures, and the state every first open passes through) still
 * comes out hung below and right-aligned rather than in the corner.
 */
export function placePopoverBox(input: {
  /** The strip's rect in viewport coordinates — the anchor. */
  readonly anchorLeft: number;
  readonly anchorRight: number;
  readonly anchorBottom: number;
  readonly anchorTop: number;
  readonly popoverWidth: number;
  readonly popoverHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** Defaults to POPOVER_EDGE_MARGIN_PX. */
  readonly margin?: number;
  /** Defaults to POPOVER_ANCHOR_GAP_PX. */
  readonly gap?: number;
}): PopoverRect {
  const margin = usableMargin(input.margin);
  const gap = usableGap(input.gap);
  return {
    left: popoverLeft(input, margin),
    top: popoverTop(input, margin, gap),
  };
}

/** The horizontal half. `anchorLeft` is deliberately NOT read: the policy is
 * right-alignment, so the left edge of the anchor does not enter it. It is in
 * the input because the caller holds a whole DOMRect and handing over the rect
 * it measured — rather than the two numbers today's policy happens to want —
 * is what keeps a future left-aligned or centred placement from being a
 * signature change at every call site. Stated here so the next reader does not
 * go looking for the use. */
function popoverLeft(
  input: { readonly anchorRight: number; readonly popoverWidth: number; readonly viewportWidth: number },
  margin: number,
): number {
  const { shift } = placePopover({ ...input, margin });
  const left = input.anchorRight - input.popoverWidth + shift;
  // `placePopover` has already refused to move for any input it could not
  // trust, so the only way out of it is a start position that was never a
  // number. One finiteness check covers every such input rather than repeating
  // that function's guards here and letting the two lists drift apart.
  return Number.isFinite(left) ? left : margin;
}

/** The vertical half. */
function popoverTop(
  input: {
    readonly anchorTop: number;
    readonly anchorBottom: number;
    readonly popoverHeight: number;
    readonly viewportHeight: number;
  },
  margin: number,
  gap: number,
): number {
  const { anchorTop, anchorBottom, popoverHeight, viewportHeight } = input;

  const below = anchorBottom + gap;
  if (!Number.isFinite(below)) return margin;
  if (!isMeasurement(popoverHeight) || !isMeasurement(viewportHeight)) return below;

  // The lowest top edge that still leaves the box's bottom on the margin. It
  // goes NEGATIVE for a box taller than the viewport's margins allow, which is
  // exactly the "bottom wins" behaviour the clamp below relies on rather than a
  // case to special-case.
  const lastTop = viewportHeight - margin - popoverHeight;
  if (below <= lastTop) return below;

  // Room measured from the same margins the box has to sit inside, so the two
  // sides are compared on equal terms and a tie keeps the resting position.
  const roomBelow = lastTop - below;
  const roomAbove = anchorTop - gap - popoverHeight - margin;
  const flipped = anchorTop - gap - popoverHeight;
  const chosen = Number.isFinite(flipped) && roomAbove > roomBelow ? flipped : below;

  // Top margin first, bottom margin LAST, so that when the two cannot both be
  // honoured the bottom is the one that survives — see the note above about
  // where this popover keeps its buttons. Written as min-of-max rather than as
  // a branch precisely so the losing edge is decided in one place.
  return Math.min(Math.max(chosen, margin), lastTop);
}
