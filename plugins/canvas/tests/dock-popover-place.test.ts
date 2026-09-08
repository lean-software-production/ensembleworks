// Run: npx vitest run tests/dock-popover-place.test.ts
//
// KEEPING THE POPOVER ON THE SCREEN, decided from three numbers: where the
// strip's right edge is, how wide the popover laid out, and how wide the
// viewport is. The popover hangs LEFTWARD from the strip (`right: 0` against
// `#canvas-av-dock`, canvas/dock/styles.ts), and on a thread route the strip is
// the FIRST child of the header's action cluster — so its right edge sits some
// way in from the viewport's, with bb's own buttons filling the gap. At phone
// width a popover hung from there runs off the LEFT of the screen, which is the
// bug the user reported. Nothing clamps it today.
//
// This module is the decision half — no measuring, no DOM — so it is drivable
// from a plain unit test, which matters more here than usual: there is no jsdom
// in this project and no network to add one, so an arithmetic clamp written
// inline in dock.ts is a clamp no test can reach.
//
// THE MODULE HAS A SECOND HALF SINCE THE SECOND REPORT — `placePopoverBox`,
// which answers both axes in absolute viewport coordinates for a popover that
// is about to become `position: fixed` on <body>. Its cases are in their own
// groups at the foot of this file; everything down to there is the original
// horizontal-only decision, unchanged.
//
// The cases below exist in four groups: the untouched common case (including
// both exact boundaries, which is where an off-by-one lives), each edge
// overflowing in turn with the resulting edge asserted EXACTLY on the margin
// rather than merely on-screen, the degenerate popover that cannot satisfy both
// edges, and each not-a-measurement input on its own.
import { describe, expect, it } from "vitest";
import {
  placePopover,
  placePopoverBox,
  POPOVER_ANCHOR_GAP_PX,
  POPOVER_EDGE_MARGIN_PX,
} from "../canvas/dock/popover-place.js";

/** The left edge the answer puts the popover at, which is what every assertion
 * below is really about — `shift` is only how it gets there. */
const leftEdge = (anchorRight: number, popoverWidth: number, shift: number): number =>
  anchorRight - popoverWidth + shift;

/** The right edge, the same way. */
const rightEdge = (anchorRight: number, shift: number): number => anchorRight + shift;

describe("placePopover — the popover that already fits", () => {
  it("does not move a popover hung from a strip near the right of a desktop window", () => {
    // The overwhelmingly common case and the one that must stay pixel-identical
    // to today's CSS: 420px hung from a strip whose right edge is 1200px into a
    // 1440px window clears both margins with room to spare, so the module has
    // no business touching it.
    expect(placePopover({ anchorRight: 1200, popoverWidth: 420, viewportWidth: 1440 })).toEqual({
      shift: 0,
    });
  });

  it("leaves a popover whose left edge lands EXACTLY on the margin alone", () => {
    // The boundary belongs to "fits". A popover touching the margin is at the
    // closest legal position, not one pixel past it, and nudging it would move
    // something that was never in trouble.
    const popoverWidth = 300;
    const anchorRight = POPOVER_EDGE_MARGIN_PX + popoverWidth;
    const { shift } = placePopover({ anchorRight, popoverWidth, viewportWidth: 1440 });
    expect(shift).toBe(0);
    expect(leftEdge(anchorRight, popoverWidth, shift)).toBe(POPOVER_EDGE_MARGIN_PX);
  });

  it("leaves a popover whose right edge lands EXACTLY on the margin alone", () => {
    // The mirror boundary. Both are stated because a clamp written with the
    // wrong comparison passes one of them and fails the other.
    const viewportWidth = 1440;
    const popoverWidth = 300;
    const anchorRight = viewportWidth - POPOVER_EDGE_MARGIN_PX;
    const { shift } = placePopover({ anchorRight, popoverWidth, viewportWidth });
    expect(shift).toBe(0);
    expect(rightEdge(anchorRight, shift)).toBe(viewportWidth - POPOVER_EDGE_MARGIN_PX);
  });
});

describe("placePopover — off the left edge, the reported bug", () => {
  it("slides a thread-header popover right until its left edge is on the margin", () => {
    // The reported case, in round numbers: a 390px phone, the popover capped by
    // `min(80vw, 420px)` at 312, and a strip whose right edge is 250px in
    // because a thread header carries several of bb's own buttons to the right
    // of it. Hung right-aligned the popover starts at -62, well off the screen.
    const viewportWidth = 390;
    const popoverWidth = 312;
    const anchorRight = 250;
    expect(leftEdge(anchorRight, popoverWidth, 0)).toBeLessThan(0);

    const { shift } = placePopover({ anchorRight, popoverWidth, viewportWidth });
    expect(shift).toBeGreaterThan(0);
    // EXACTLY the margin, not merely on-screen: the popover has to stay
    // visually tied to the control that opened it, so the fix is the smallest
    // movement that works and any larger one is a different bug.
    expect(leftEdge(anchorRight, popoverWidth, shift)).toBe(POPOVER_EDGE_MARGIN_PX);
    expect(rightEdge(anchorRight, shift)).toBeLessThanOrEqual(
      viewportWidth - POPOVER_EDGE_MARGIN_PX,
    );
  });

  it("slides by exactly the shortfall, one pixel over the boundary", () => {
    // One pixel past the boundary moves one pixel. Pins the direction (right is
    // positive) and the fact that the correction is the shortfall itself rather
    // than a fixed nudge or a re-centring.
    const popoverWidth = 300;
    const anchorRight = POPOVER_EDGE_MARGIN_PX + popoverWidth - 1;
    expect(placePopover({ anchorRight, popoverWidth, viewportWidth: 1440 })).toEqual({ shift: 1 });
  });

  it("treats a strip scrolled off the left as a position, not as a failed read", () => {
    // `anchorRight` is the one input whose SIGN is not checked, and that is a
    // decision rather than an omission: a header row mid horizontal-scroll, or
    // mid route transition, reports a negative `.right`, and that is a real
    // place for the strip to be — not a read that failed. So it is clamped like
    // any other position instead of short-circuiting to 0, which is the
    // difference between the popover appearing at the left margin and it
    // sliding off the screen along with the strip it is hung from.
    const popoverWidth = 300;
    const anchorRight = -50;
    const { shift } = placePopover({ anchorRight, popoverWidth, viewportWidth: 1440 });
    expect(leftEdge(anchorRight, popoverWidth, shift)).toBe(POPOVER_EDGE_MARGIN_PX);
  });

  it("respects a caller-supplied margin instead of the default", () => {
    // The margin is a parameter so a future placement with different chrome
    // around it can ask for a different one; this proves it is actually used
    // and not just defaulted over.
    const margin = POPOVER_EDGE_MARGIN_PX * 4;
    const popoverWidth = 300;
    const anchorRight = 100;
    const { shift } = placePopover({ anchorRight, popoverWidth, viewportWidth: 1440, margin });
    expect(leftEdge(anchorRight, popoverWidth, shift)).toBe(margin);
  });
});

describe("placePopover — off the right edge", () => {
  it("slides left by exactly the overhang when the strip is hard against the edge", () => {
    // Reachable from the "fixed" placement (canvas/dock/anchor.ts level 3),
    // which pins the strip into the top-right corner, and from any host that
    // ever puts the action cluster flush with the window. Right-aligning to a
    // strip whose own right edge is already past the margin hangs the popover
    // over the edge, and the answer is the mirror of the left-edge one.
    const viewportWidth = 800;
    const popoverWidth = 300;
    const anchorRight = viewportWidth - POPOVER_EDGE_MARGIN_PX + 1;
    const { shift } = placePopover({ anchorRight, popoverWidth, viewportWidth });
    expect(shift).toBe(-1);
    expect(rightEdge(anchorRight, shift)).toBe(viewportWidth - POPOVER_EDGE_MARGIN_PX);
  });

  it("slides left by the whole overhang when the strip hangs well past the edge", () => {
    // Again the exact edge, not merely "on screen", for the same
    // minimum-movement reason: the popover belongs beside its control.
    const viewportWidth = 800;
    const popoverWidth = 300;
    const anchorRight = viewportWidth + 40;
    const { shift } = placePopover({ anchorRight, popoverWidth, viewportWidth });
    expect(shift).toBe(-(40 + POPOVER_EDGE_MARGIN_PX));
    expect(rightEdge(anchorRight, shift)).toBe(viewportWidth - POPOVER_EDGE_MARGIN_PX);
    expect(leftEdge(anchorRight, popoverWidth, shift)).toBeGreaterThanOrEqual(
      POPOVER_EDGE_MARGIN_PX,
    );
  });
});

describe("placePopover — the degenerate popover", () => {
  it("pins the LEFT edge and lets the right overhang when both cannot be satisfied", () => {
    // A popover wider than the margins leave room for cannot sit inside both,
    // so one edge has to lose. The left wins: the popover's content is
    // left-aligned, so the left edge is where its meaning starts, and a reader
    // who can see the start of every line can still read it. This branch should
    // be unreachable once the CSS cap accounts for the margins — it exists so
    // the function is total, not because we expect to hit it.
    const viewportWidth = 320;
    const popoverWidth = 420;
    const { shift } = placePopover({ anchorRight: 300, popoverWidth, viewportWidth });
    expect(leftEdge(300, popoverWidth, shift)).toBe(POPOVER_EDGE_MARGIN_PX);
    expect(rightEdge(300, shift)).toBeGreaterThan(viewportWidth - POPOVER_EDGE_MARGIN_PX);
  });

  it("pins the same left edge whichever side the oversized popover started on", () => {
    // The degenerate answer is a position, not a correction: an oversized
    // popover ends up in the same place whether right-aligning put it off the
    // left or off the right, because there is only one legal left edge.
    const viewportWidth = 320;
    const popoverWidth = 420;
    const fromLeft = placePopover({ anchorRight: 100, popoverWidth, viewportWidth });
    const fromRight = placePopover({ anchorRight: 600, popoverWidth, viewportWidth });
    expect(leftEdge(100, popoverWidth, fromLeft.shift)).toBe(POPOVER_EDGE_MARGIN_PX);
    expect(leftEdge(600, popoverWidth, fromRight.shift)).toBe(POPOVER_EDGE_MARGIN_PX);
  });
});

describe("placePopover — inputs that are not measurements", () => {
  // Every one of these answers 0, which is today's behaviour: right-aligned to
  // the strip, exactly as the CSS already does. A read that failed must never
  // be the reason the popover jumps across the screen — being no better than
  // today is the floor, being worse is not allowed.
  const fits = { anchorRight: 1200, popoverWidth: 420, viewportWidth: 1440 } as const;

  it("does not move for a NaN anchor", () => {
    expect(placePopover({ ...fits, anchorRight: Number.NaN })).toEqual({ shift: 0 });
  });

  it("does not move for an infinite anchor", () => {
    expect(placePopover({ ...fits, anchorRight: Number.POSITIVE_INFINITY })).toEqual({ shift: 0 });
  });

  it("does not move for a NaN popover width", () => {
    expect(placePopover({ ...fits, popoverWidth: Number.NaN })).toEqual({ shift: 0 });
  });

  it("does not move for an infinite popover width", () => {
    expect(placePopover({ ...fits, popoverWidth: Number.POSITIVE_INFINITY })).toEqual({ shift: 0 });
  });

  it("does not move for a zero popover width", () => {
    // What a `display: none` or not-yet-laid-out popover reports, which is
    // exactly the state a first open passes through.
    expect(placePopover({ ...fits, popoverWidth: 0 })).toEqual({ shift: 0 });
  });

  it("does not move for a negative popover width", () => {
    expect(placePopover({ ...fits, popoverWidth: -20 })).toEqual({ shift: 0 });
  });

  it("does not move for a NaN viewport width", () => {
    expect(placePopover({ ...fits, viewportWidth: Number.NaN })).toEqual({ shift: 0 });
  });

  it("does not move for an infinite viewport width", () => {
    expect(placePopover({ ...fits, viewportWidth: Number.POSITIVE_INFINITY })).toEqual({
      shift: 0,
    });
  });

  it("does not move for a zero viewport width", () => {
    expect(placePopover({ ...fits, viewportWidth: 0 })).toEqual({ shift: 0 });
  });

  it("does not move for a negative viewport width", () => {
    expect(placePopover({ ...fits, viewportWidth: -1440 })).toEqual({ shift: 0 });
  });

  it("does not move for a margin that is not a number, or is negative", () => {
    // The margin is the one input that is a caller's constant rather than a
    // measurement, but a bad one is just as capable of throwing the popover
    // somewhere absurd, and a negative margin would ASK for the popover to hang
    // off the screen. Same answer: leave it where the CSS put it.
    const offLeft = { anchorRight: 100, popoverWidth: 300, viewportWidth: 1440 } as const;
    expect(placePopover({ ...offLeft, margin: Number.NaN })).toEqual({ shift: 0 });
    expect(placePopover({ ...offLeft, margin: Number.POSITIVE_INFINITY })).toEqual({ shift: 0 });
    expect(placePopover({ ...offLeft, margin: -POPOVER_EDGE_MARGIN_PX })).toEqual({ shift: 0 });
    // …and the same input WITH a good margin does move, so the assertions above
    // are about the margin and not about an input that was fine all along.
    expect(placePopover(offLeft).shift).toBeGreaterThan(0);
  });

  it("accepts a zero margin as a real request to touch the edge", () => {
    // Zero is not a failed read — it is a caller saying "flush is fine" — so it
    // has to keep clamping, just to the edge itself.
    const { shift } = placePopover({
      anchorRight: 100,
      popoverWidth: 300,
      viewportWidth: 1440,
      margin: 0,
    });
    expect(leftEdge(100, 300, shift)).toBe(0);
  });
});

describe("placePopover — the property the whole module is for", () => {
  it("never leaves the popover off the left edge for any strip position on a phone", () => {
    // Sweeps every strip right-edge a phone-width header could produce, with
    // the popover at the 80vw cap. The left edge is the one the reported bug is
    // about, and the one the degenerate branch protects, so it must hold at
    // every position; the right edge is asserted only where it can be.
    const viewportWidth = 390;
    const popoverWidth = Math.round(viewportWidth * 0.8);
    for (let anchorRight = 0; anchorRight <= viewportWidth; anchorRight += 1) {
      const { shift } = placePopover({ anchorRight, popoverWidth, viewportWidth });
      expect(leftEdge(anchorRight, popoverWidth, shift)).toBeGreaterThanOrEqual(
        POPOVER_EDGE_MARGIN_PX,
      );
      expect(rightEdge(anchorRight, shift)).toBeLessThanOrEqual(
        viewportWidth - POPOVER_EDGE_MARGIN_PX,
      );
    }
  });

  it("never moves a popover that already fits, at any position that fits", () => {
    // The other half of the same property, and the one that guards against a
    // clamp that "fixes" everything: across every strip position where the
    // right-aligned popover is already legal, the answer must be exactly 0.
    const viewportWidth = 1440;
    const popoverWidth = 420;
    for (
      let anchorRight = POPOVER_EDGE_MARGIN_PX + popoverWidth;
      anchorRight <= viewportWidth - POPOVER_EDGE_MARGIN_PX;
      anchorRight += 1
    ) {
      expect(placePopover({ anchorRight, popoverWidth, viewportWidth }).shift).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// THE SECOND AXIS, AND ABSOLUTE COORDINATES.
//
// The popover is about to stop being an absolutely-positioned child of
// "#canvas-av-dock" and become a FIXED-POSITION element parented to <body>,
// because an absolutely-positioned child is clipped by whatever ancestor pane
// has "overflow: hidden" — which is what the user's screenshot shows: the dark
// popover sliced off dead on the vertical line where bb's left navigation panel
// ends, the faces to the left of it simply gone rather than dimmed.
//
// A fixed box needs viewport coordinates for BOTH axes, so `shift` (a
// horizontal nudge against a resting CSS position) is no longer an answer on
// its own. `placePopoverBox` answers WHERE THE BOX GOES.
//
// The cases below are in four groups: the horizontal axis agreeing with
// `placePopover` (it is the same policy because it is the same function), the
// vertical axis below/flipped/clamped, the oversized box that fits on neither
// side, and every input that is not a measurement.
/** A strip-shaped anchor, sitting where a thread header's action cluster puts
 * it: 28px tall (the height ".dock-strip" declares) at the top of the row. */
const anchor = (left: number, right: number, top: number) => ({
  anchorLeft: left,
  anchorRight: right,
  anchorTop: top,
  anchorBottom: top + 28,
});

/** A box that comfortably fits both ways, for the tests that vary one thing. */
const roomy = {
  ...anchor(1100, 1200, 10),
  popoverWidth: 420,
  popoverHeight: 200,
  viewportWidth: 1440,
  viewportHeight: 800,
} as const;

describe("placePopoverBox — the horizontal axis is placePopover's", () => {
  it("puts a popover that already fits exactly where right-aligning would have", () => {
    // The common case, and the one that must stay pixel-identical to what the
    // absolute `right: 0` rule drew: the box's right edge on the strip's.
    const { left } = placePopoverBox(roomy);
    expect(left).toBe(roomy.anchorRight - roomy.popoverWidth);
  });

  it("agrees with placePopover at every strip position on a phone", () => {
    // Not a re-implementation of the clamp, and this is the assertion that says
    // so: for every position a phone-width header could put the strip at, the
    // absolute left edge is exactly the one `placePopover`'s shift describes.
    // Two copies of a clamp drift; one copy with this test cannot.
    const viewportWidth = 390;
    const popoverWidth = Math.round(viewportWidth * 0.8);
    for (let anchorRight = 0; anchorRight <= viewportWidth; anchorRight += 1) {
      const { shift } = placePopover({ anchorRight, popoverWidth, viewportWidth });
      const { left } = placePopoverBox({
        ...anchor(anchorRight - 100, anchorRight, 10),
        popoverWidth,
        popoverHeight: 200,
        viewportWidth,
        viewportHeight: 800,
      });
      expect(left).toBe(anchorRight - popoverWidth + shift);
      expect(left).toBeGreaterThanOrEqual(POPOVER_EDGE_MARGIN_PX);
    }
  });

  it("pins the left edge for a popover too wide to satisfy both margins", () => {
    // The degenerate branch, reached through the new entry point: same answer,
    // because it is the same clamp.
    const { left } = placePopoverBox({
      ...anchor(200, 300, 10),
      popoverWidth: 420,
      popoverHeight: 200,
      viewportWidth: 320,
      viewportHeight: 800,
    });
    expect(left).toBe(POPOVER_EDGE_MARGIN_PX);
  });

  it("respects a caller-supplied margin on the horizontal axis", () => {
    const margin = POPOVER_EDGE_MARGIN_PX * 4;
    const { left } = placePopoverBox({ ...roomy, anchorRight: 100, margin });
    expect(left).toBe(margin);
  });
});

describe("placePopoverBox — the vertical axis", () => {
  it("hangs the box below the anchor by the gap", () => {
    // The resting position, and the one the stylesheet already draws:
    // "top: calc(100% + 6px)" against the strip. POPOVER_ANCHOR_GAP_PX is that
    // 6, moved to where the fixed-position arithmetic can reach it.
    const { top } = placePopoverBox(roomy);
    expect(top).toBe(roomy.anchorBottom + POPOVER_ANCHOR_GAP_PX);
  });

  it("respects a caller-supplied gap", () => {
    const { top } = placePopoverBox({ ...roomy, gap: 20 });
    expect(top).toBe(roomy.anchorBottom + 20);
  });

  it("leaves a box whose bottom lands EXACTLY on the margin alone", () => {
    // The boundary belongs to "fits", the same way it does horizontally: a box
    // touching the margin is at the closest legal position, not one past it.
    const viewportHeight = 800;
    const popoverHeight = 200;
    const anchorTop =
      viewportHeight - POPOVER_EDGE_MARGIN_PX - popoverHeight - POPOVER_ANCHOR_GAP_PX - 28;
    const box = placePopoverBox({
      ...anchor(1100, 1200, anchorTop),
      popoverWidth: 420,
      popoverHeight,
      viewportWidth: 1440,
      viewportHeight,
    });
    expect(box.top).toBe(anchorTop + 28 + POPOVER_ANCHOR_GAP_PX);
    expect(box.top + popoverHeight).toBe(viewportHeight - POPOVER_EDGE_MARGIN_PX);
  });

  it("flips above the anchor when it will not fit below and there is more room above", () => {
    // A strip low in a short viewport — a landscape phone, or a pane with the
    // header near the bottom. The flipped box's BOTTOM edge sits one gap above
    // the anchor's top, which is the mirror of the resting position.
    const viewportHeight = 400;
    const popoverHeight = 200;
    const anchorTop = 300;
    const box = placePopoverBox({
      ...anchor(1100, 1200, anchorTop),
      popoverWidth: 420,
      popoverHeight,
      viewportWidth: 1440,
      viewportHeight,
    });
    expect(box.top).toBe(anchorTop - POPOVER_ANCHOR_GAP_PX - popoverHeight);
    expect(box.top + popoverHeight).toBe(anchorTop - POPOVER_ANCHOR_GAP_PX);
    expect(box.top).toBeGreaterThanOrEqual(POPOVER_EDGE_MARGIN_PX);
  });

  it("clamps rather than flips when below is the roomier side", () => {
    // The anchor is at the top of the viewport, so flipping would put the box
    // in the 10px above it. Staying below and sliding up until the bottom edge
    // is on the margin keeps far more of it on screen — which is the whole of
    // the rule: flip only when the other side is genuinely roomier.
    const viewportHeight = 400;
    const popoverHeight = 380;
    const box = placePopoverBox({
      ...anchor(1100, 1200, 10),
      popoverWidth: 420,
      popoverHeight,
      viewportWidth: 1440,
      viewportHeight,
    });
    expect(box.top).toBe(viewportHeight - POPOVER_EDGE_MARGIN_PX - popoverHeight);
    expect(box.top).toBeGreaterThanOrEqual(POPOVER_EDGE_MARGIN_PX);
  });

  it("does NOT flip when the two sides have exactly equal room", () => {
    // THE BOUNDARY OF THE FLIP RULE, and the only width of it that is a
    // decision rather than a consequence: the comparison is "above is
    // GENUINELY roomier", so a tie has to keep the resting position. Three
    // mutants survived the suite without this case — the comparison relaxed to
    // ">=", and either of the two terms dropped out of `roomAbove` (its
    // `margin`, its `gap`), each of which tips a tie into a flip.
    //
    // WHERE THE TIE IS, derived rather than hunted for. roomBelow is
    // (viewportHeight - margin - height) - (anchorBottom + gap) and roomAbove
    // is (anchorTop - gap - height - margin); setting them equal cancels
    // everything except `anchorTop + anchorBottom === viewportHeight`, i.e. the
    // strip's own midpoint is the viewport's. Note what that means: a tie is
    // only ever reachable in the does-not-fit-below branch, because roomBelow
    // < 0 is what got us there and a tie makes roomAbove negative too. There is
    // no tie between two sides that both fit.
    const viewportHeight = 800;
    const popoverHeight = 400;
    const stripHeight = anchor(0, 0, 0).anchorBottom;
    const anchorTop = (viewportHeight - stripHeight) / 2;
    const seed = {
      ...anchor(1100, 1200, anchorTop),
      popoverWidth: 420,
      popoverHeight,
      viewportWidth: 1440,
      viewportHeight,
    };
    // THE SEED IS CHECKED BEFORE IT IS TRUSTED, the same way the test below
    // this group had to be: it is worth nothing unless it really is a tie and
    // really is in the branch where the flip is considered at all.
    const lastTop = viewportHeight - POPOVER_EDGE_MARGIN_PX - popoverHeight;
    const below = seed.anchorBottom + POPOVER_ANCHOR_GAP_PX;
    expect(below).toBeGreaterThan(lastTop);
    expect(anchorTop - POPOVER_ANCHOR_GAP_PX - popoverHeight - POPOVER_EDGE_MARGIN_PX).toBe(
      lastTop - below,
    );

    // Below, clamped to the bottom margin — NOT the flipped position, which
    // would be off the top of the screen and land on the top margin instead.
    expect(placePopoverBox(seed).top).toBe(lastTop);
    expect(placePopoverBox(seed).top).not.toBe(POPOVER_EDGE_MARGIN_PX);
  });

  it("flips as soon as above is roomier by a single pixel, and not before", () => {
    // The other half of the same boundary, one pixel either side of it, so the
    // tie above is pinned as a tie rather than as a wide flat region: the rule
    // is strict, so 1px of extra room above is enough to flip and 1px less is
    // not.
    const viewportHeight = 800;
    const popoverHeight = 400;
    const stripHeight = anchor(0, 0, 0).anchorBottom;
    const tie = (viewportHeight - stripHeight) / 2;
    const at = (anchorTop: number) =>
      placePopoverBox({
        ...anchor(1100, 1200, anchorTop),
        popoverWidth: 420,
        popoverHeight,
        viewportWidth: 1440,
        viewportHeight,
      }).top;

    // Raising the strip by a pixel gives above a pixel and takes one from
    // below, so the flip wins — and, this tall, the flipped box still does not
    // fit, so it comes to rest on the TOP margin.
    expect(at(tie + 1)).toBe(POPOVER_EDGE_MARGIN_PX);
    // Lowering it does the reverse, and the box stays below.
    expect(at(tie - 1)).toBe(viewportHeight - POPOVER_EDGE_MARGIN_PX - popoverHeight);
  });

  it("clamps into the top margin when above is roomier but still not roomy enough", () => {
    // Above wins the comparison and then does not fit either. The box goes as
    // high as it is allowed and overlaps the strip it belongs to — which is
    // ugly and is still the right answer: an on-screen popover covering its own
    // control can be read and dismissed; one placed above the viewport cannot.
    //
    // THE SEED HAS TO BE CHECKED, and the first one written here was not: with
    // the strip at 360 the flipped box lands at 14, i.e. it FITS above with 6px
    // to spare, and the test passed through the branch above this one. 300 is
    // the strip position where above is still the roomier side (-54px of
    // shortfall against below's -282) and the flip lands at -46, off the top.
    const viewportHeight = 400;
    const popoverHeight = 340;
    const box = placePopoverBox({
      ...anchor(1100, 1200, 300),
      popoverWidth: 420,
      popoverHeight,
      viewportWidth: 1440,
      viewportHeight,
    });
    expect(box.top).toBe(POPOVER_EDGE_MARGIN_PX);
  });
});

describe("placePopoverBox — the box that fits on neither side", () => {
  it("pins the BOTTOM margin and lets the top run off, keeping the buttons", () => {
    // Taller than the viewport's margins leave room for, so one end has to
    // lose, and vertically it is the TOP — the opposite end from the horizontal
    // rule, deliberately. dock.ts appends the popover's children in the order
    // (faces, controls, status), so the actionable half of this popover is at
    // its BOTTOM: cutting the top costs some faces, cutting the bottom would
    // cost every button the popover exists to offer.
    const viewportHeight = 300;
    const popoverHeight = 400;
    const box = placePopoverBox({
      ...anchor(1100, 1200, 100),
      popoverWidth: 420,
      popoverHeight,
      viewportWidth: 1440,
      viewportHeight,
    });
    expect(box.top + popoverHeight).toBe(viewportHeight - POPOVER_EDGE_MARGIN_PX);
    expect(box.top).toBeLessThan(0);
  });
});

describe("placePopoverBox — inputs that are not measurements", () => {
  // There is no "leave it where CSS put it" any more: this IS the position, so
  // a failed read cannot answer "do not move". Every one of these must produce
  // two finite numbers, and the fallback is the viewport's safe corner —
  // on-screen, detached from the strip, and visibly odd rather than invisible.
  const coords = (box: { left: number; top: number }) => [box.left, box.top];

  it("never answers NaN or Infinity, whichever input failed", () => {
    const broken = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -50];
    const keys = [
      "anchorLeft",
      "anchorRight",
      "anchorTop",
      "anchorBottom",
      "popoverWidth",
      "popoverHeight",
      "viewportWidth",
      "viewportHeight",
      "margin",
      "gap",
    ] as const;
    for (const key of keys) {
      for (const value of broken) {
        const box = placePopoverBox({ ...roomy, [key]: value });
        for (const coord of coords(box)) {
          expect(Number.isFinite(coord)).toBe(true);
        }
      }
    }
  });

  it("falls back to the safe corner when the anchor cannot be read at all", () => {
    // A DOMRect from a detached element reports NaN, and there is nothing left
    // to be relative TO. The corner is not a good position; it is the only one
    // that is certainly on the screen.
    const box = placePopoverBox({
      ...roomy,
      anchorRight: Number.NaN,
      anchorBottom: Number.NaN,
    });
    expect(box).toEqual({ left: POPOVER_EDGE_MARGIN_PX, top: POPOVER_EDGE_MARGIN_PX });
  });

  it("uses the caller's margin for the safe corner when the margin is usable", () => {
    const margin = POPOVER_EDGE_MARGIN_PX * 3;
    const box = placePopoverBox({
      ...roomy,
      margin,
      anchorRight: Number.NaN,
      anchorBottom: Number.NaN,
    });
    expect(box).toEqual({ left: margin, top: margin });
  });

  it("falls back to the default margin when the margin itself is not usable", () => {
    // A negative margin is a request to hang the box off the edge, which is the
    // one outcome this module exists to prevent, so it is refused rather than
    // honoured — the same judgement placePopover already makes.
    for (const margin of [Number.NaN, Number.POSITIVE_INFINITY, -POPOVER_EDGE_MARGIN_PX]) {
      const box = placePopoverBox({
        ...roomy,
        margin,
        anchorRight: Number.NaN,
        anchorBottom: Number.NaN,
      });
      expect(box).toEqual({ left: POPOVER_EDGE_MARGIN_PX, top: POPOVER_EDGE_MARGIN_PX });
    }
  });

  it("accepts a zero margin and a zero gap as real requests", () => {
    // Zero is a caller saying "flush is fine", which is a position rather than
    // a failure — for both of them.
    const box = placePopoverBox({ ...roomy, anchorRight: 100, margin: 0, gap: 0 });
    expect(box.left).toBe(0);
    expect(box.top).toBe(roomy.anchorBottom);
  });

  it("refuses a gap that is not usable, the same way it refuses a margin", () => {
    // The margin's version of this is two tests up; the gap had none, and the
    // guards are not symmetric by accident — the module documents both. A
    // NEGATIVE gap is the one that matters: it does not merely mis-space the
    // box, it slides it UP over the control that opened it, so the popover
    // covers the thing you clicked. It is refused rather than honoured, and the
    // default is what gets used.
    for (const gap of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -50]) {
      const box = placePopoverBox({ ...roomy, gap });
      expect(box.top).toBe(roomy.anchorBottom + POPOVER_ANCHOR_GAP_PX);
    }
  });

  it("keeps the right-aligned resting position when the viewport WIDTH cannot be read", () => {
    // The horizontal twin of the viewport-height case below, and the reason the
    // horizontal axis is `placePopover` rather than a clamp written out again
    // here: with no viewport there is nothing to clamp against, so the answer
    // is the position the popover has always been drawn at. An inline clamp
    // that multiplied an unreadable width into its arithmetic would land the
    // box on the margin instead — an equivalent-looking rewrite of this axis
    // survived the rest of the suite and was caught only here.
    for (const viewportWidth of [0, Number.NaN, Number.POSITIVE_INFINITY, -1440]) {
      const box = placePopoverBox({ ...roomy, viewportWidth });
      expect(box.left).toBe(roomy.anchorRight - roomy.popoverWidth);
    }
  });

  it("still hangs below when the popover has not been laid out yet", () => {
    // The first open measures a `display: none` box: 0 by 0. There is nothing
    // to clamp against and the resting position needs neither number, so the
    // box goes exactly where the CSS would have put it.
    const box = placePopoverBox({ ...roomy, popoverHeight: 0, popoverWidth: 0 });
    expect(box.top).toBe(roomy.anchorBottom + POPOVER_ANCHOR_GAP_PX);
    expect(box.left).toBe(roomy.anchorRight);
  });

  it("hangs below unclamped when the viewport height cannot be read", () => {
    // Without a viewport there is no bottom margin to reason about, so the
    // honest answer is the resting position rather than a guess — the same
    // shape of answer placePopover gives for an unreadable viewport width.
    const box = placePopoverBox({ ...roomy, viewportHeight: 0 });
    expect(box.top).toBe(roomy.anchorBottom + POPOVER_ANCHOR_GAP_PX);
  });

  it("cannot flip when the anchor's top edge is unreadable, and clamps instead", () => {
    // `anchorTop` is only needed for the flip. Losing it must cost the flip,
    // not the placement.
    const viewportHeight = 400;
    const popoverHeight = 200;
    const box = placePopoverBox({
      ...anchor(1100, 1200, 300),
      anchorTop: Number.NaN,
      popoverWidth: 420,
      popoverHeight,
      viewportWidth: 1440,
      viewportHeight,
    });
    expect(box.top).toBe(viewportHeight - POPOVER_EDGE_MARGIN_PX - popoverHeight);
  });
});

// ---------------------------------------------------------------------------
// A NEW ANCHOR POSITION: THE BOTTOM-DOCKED CHROME (2026-09-05).
//
// The canvas toolbar left the column's flow and now floats bottom-centre
// (canvas/pages/chrome-dock.ts), which moves the Pages button's anchor from
// near the TOP of the panel to within a few pixels of the BOTTOM of the window.
// That is a placement this module was written before and never exercised at.
//
// THESE ARE CHARACTERISATION TESTS, NOT RED-THEN-GREEN ONES, and it matters
// that they are labelled so: `placePopoverBox` is UNCHANGED by that work. It
// already flipped above, and these were green the moment they were written.
// They are here because the flip is now load-bearing for a caller that did not
// exist when it was reasoned about, and because the third case below is what
// forces CHROME_DOCK_Z_INDEX to sit under POPOVER_Z_INDEX.
describe("placePopoverBox — anchored to the bottom-docked canvas chrome", () => {
  it("flips the whole popover above the bar rather than clamping it", () => {
    // A 24px-tall button in a bar 8px off the bottom of a 1280x800 window.
    const box = placePopoverBox({
      anchorLeft: 300,
      anchorRight: 380,
      anchorTop: 760,
      anchorBottom: 784,
      popoverWidth: 320,
      popoverHeight: 420,
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    // Exactly the flipped position — anchorTop - gap - height — so the box is
    // intact and still visibly attached to the button that opened it.
    expect(box.top).toBe(760 - POPOVER_ANCHOR_GAP_PX - 420);
  });

  it("still flips on a phone-width panel, where above is merely roomier", () => {
    const box = placePopoverBox({
      anchorLeft: 20,
      anchorRight: 100,
      anchorTop: 600,
      anchorBottom: 624,
      popoverWidth: 312,
      popoverHeight: 400,
      viewportWidth: 390,
      viewportHeight: 640,
    });
    expect(box.top).toBe(600 - POPOVER_ANCHOR_GAP_PX - 400);
    // …and the left clamp still runs, because a 312px box right-aligned to a
    // button 100px in would start off the left edge.
    expect(box.left).toBe(POPOVER_EDGE_MARGIN_PX);
  });

  it("slides back DOWN over the bar when neither side fits", () => {
    // A short viewport: 400px of popover, 300px of window. The module's stated
    // "bottom margin wins" rule puts the box's bottom on the margin and lets
    // the top run off — which means it is painted OVER the bar that opened it.
    // THIS IS WHY THE FLOATING CHROME MUST RANK UNDER POPOVER_Z_INDEX; see
    // tests/page-switcher-layering.test.ts's ladder.
    const box = placePopoverBox({
      anchorLeft: 20,
      anchorRight: 100,
      anchorTop: 260,
      anchorBottom: 284,
      popoverWidth: 312,
      popoverHeight: 400,
      viewportWidth: 390,
      viewportHeight: 300,
    });
    expect(box.top).toBe(300 - POPOVER_EDGE_MARGIN_PX - 400);
    expect(box.top).toBeLessThan(260);
  });
});
