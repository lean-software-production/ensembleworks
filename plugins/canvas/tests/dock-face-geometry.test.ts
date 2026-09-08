import { describe, expect, it } from "vitest";

import {
  CAPITAL_ADVANCE_RATIO,
  FACE_GEOMETRY,
  INITIALS_FONT_PX,
  capitalAdvancePx,
  exposedSlicePx,
  initialsLeftEdgePx,
  initialsWidthPx,
  roundingInsetPx,
  runWidthPx,
} from "../canvas/dock/face-geometry.js";
import { MAX_DOCK_BUBBLES } from "../canvas/dock/model.js";
import { maxBubblesFor, type FaceTier, type SqueezeTier } from "../canvas/dock/squeeze.js";
import { DOCK_STYLES } from "../canvas/dock/styles.js";

// EVERY tier that draws faces, which since the "bare" tier arrived is no longer
// every tier — see the head of face-geometry.ts for why bare has no row in
// FACE_GEOMETRY at all. Typed as FaceTier so this list cannot silently fall
// behind that record.
const TIERS: readonly FaceTier[] = ["roomy", "tight", "cramped"];

describe("the tier that draws no faces", () => {
  it("has no geometry at all, rather than a row of zeroes", () => {
    // A runtime guard on a decision the types already make (every function here
    // takes FaceTier), because the failure mode it protects against is someone
    // reaching for the easy fix — adding `bare: { diameterPx: 0, ... }` to get
    // past a compile error — after which every invariant in this file would be
    // vacuously true for that tier while `runWidthPx("bare", 3)` answered 0 as
    // though it meant something.
    const all: readonly SqueezeTier[] = ["roomy", "tight", "cramped", "bare"];
    expect(Object.keys(FACE_GEOMETRY).sort()).toEqual(
      all.filter((tier) => tier !== "bare").sort(),
    );
  });
});

describe("the leading capital survives the overlap", () => {
  // THE ONE INVARIANT THIS MODULE EXISTS FOR. Each face is painted over by the
  // next (DOM order, no z-index anywhere in the sheet), so what a reader gets
  // of any face but the last is its LEFT slice. The circle's hue and the first
  // letter are the whole identity — there is no photograph behind it — so the
  // first letter has to fit in that slice, whole. It did not at cramped: an
  // 8px slice with a centred glyph showed x 2.8-8.0 of a capital that ran
  // 2.8-10.0, i.e. two thirds of one letter on every face but the last.
  for (const tier of TIERS) {
    it(`fits inside the exposed slice at "${tier}"`, () => {
      const right = initialsLeftEdgePx(tier) + capitalAdvancePx();
      expect(right).toBeLessThanOrEqual(exposedSlicePx(tier));
    });
  }
});

describe("the initials clear the circle's own clipping", () => {
  // `.dock-bubble` is `overflow: hidden` on a `border-radius: 50%` box, so a
  // glyph pushed towards an edge to escape the overlap can be clipped by the
  // circle instead — trading one invisible letter for another.
  for (const tier of TIERS) {
    it(`starts inside the paintable band at "${tier}"`, () => {
      expect(initialsLeftEdgePx(tier)).toBeGreaterThanOrEqual(roundingInsetPx(tier));
    });
  }
});

describe("squeezing only ever narrows the strip", () => {
  // The tiers exist to give width BACK to bb's page title (canvas/dock/
  // squeeze.ts's header). A tier that relaxes its overlap to make room for a
  // letter could in principle undo that, and the check is against the run each
  // tier actually draws — face count and geometry together — rather than
  // against the geometry alone.
  const runOf = (tier: FaceTier): number => runWidthPx(tier, maxBubblesFor(tier));

  it("narrows from roomy to tight to cramped", () => {
    expect(runOf("cramped")).toBeLessThan(runOf("tight"));
    expect(runOf("tight")).toBeLessThan(runOf("roomy"));
  });

  it("keeps the cramped run well clear of the tight one", () => {
    // Not merely "smaller": the tiers are three visibly different layouts, and
    // a cramped run that had crept up to within a few px of tight's would be a
    // tier that no longer buys anything.
    expect(runOf("tight") - runOf("cramped")).toBeGreaterThan(15);
  });

  it("draws the roomy run at the strip's own cap", () => {
    expect(runWidthPx("roomy", MAX_DOCK_BUBBLES)).toBe(runOf("roomy"));
  });
});

describe("the geometry is a stack of circles at all", () => {
  for (const tier of TIERS) {
    it(`leaves something of a covered face showing at "${tier}"`, () => {
      // A zero or negative slice is a face fully hidden behind its neighbour —
      // the run would then be a single circle with a pile behind it.
      expect(exposedSlicePx(tier)).toBeGreaterThan(0);
      expect(FACE_GEOMETRY[tier].overlapPx).toBeGreaterThan(0);
    });
  }

  it("puts a two-capital glyph inside the circle at every tier", () => {
    for (const tier of TIERS) {
      expect(initialsLeftEdgePx(tier) + initialsWidthPx()).toBeLessThanOrEqual(
        FACE_GEOMETRY[tier].diameterPx,
      );
    }
  });
});

describe("the stylesheet is drawn from these numbers", () => {
  // NOT a spot-check that some string appears in some CSS — that would assert
  // the file against itself. The point is the reverse: that the pixel literals
  // the browser gets are the ones the invariants above were proved against, so
  // the two cannot drift the way they had. If styles.ts ever stops
  // interpolating, these fail with the tier whose numbers went stale.
  it("emits each tier's face size and overlap", () => {
    for (const tier of TIERS) {
      const { diameterPx, overlapPx } = FACE_GEOMETRY[tier];
      expect(DOCK_STYLES).toContain(`width: ${diameterPx}px`);
      expect(DOCK_STYLES).toContain(`margin-left: -${overlapPx}px`);
    }
  });

  it("emits the font size the capital width was reasoned from", () => {
    expect(DOCK_STYLES).toContain(`600 ${INITIALS_FONT_PX}px/1`);
  });

  it("emits the cramped tier's glyph offset", () => {
    const cramped = FACE_GEOMETRY.cramped;
    expect(cramped.initials).not.toBe("center");
    expect(DOCK_STYLES).toContain(`margin-left: ${initialsLeftEdgePx("cramped")}px`);
  });
});

describe("the capital-width estimate is stated, not smuggled", () => {
  it("is a ratio of the font size and errs wide", () => {
    // The number is unverifiable in this project (no browser to measure a glyph
    // in), so what can be checked is that it is an over-estimate of an ordinary
    // capital rather than an average — the invariants above are only safe in
    // that direction.
    expect(CAPITAL_ADVANCE_RATIO).toBeGreaterThan(0.65);
    expect(CAPITAL_ADVANCE_RATIO).toBeLessThan(0.8);
    expect(capitalAdvancePx()).toBe(INITIALS_FONT_PX * CAPITAL_ADVANCE_RATIO);
  });
});
