// Run: npx vitest run tests/dock-squeeze.test.ts
//
// HOW HARD THE STRIP SQUEEZES ITS FACES, decided from one number: how wide the
// container it sits in currently is. The strip draws six 24px faces at a -6px
// overlap on a desktop header row; on a phone, or in a split pane, that same
// six-face run is wider than the row has to give and it shoves bb's own title
// and buttons around. This module is the decision half — no measuring, no DOM —
// so it is drivable from a plain unit test, which matters more here than
// usual: there is no jsdom in this project and no network to add one, so a
// threshold written inline in dock.ts is a threshold no test can reach.
//
// The cases below exist in three groups: the tiers themselves (including every
// exact boundary, which is where an off-by-one lives), the hysteresis dead band
// in BOTH directions, and the anti-flap sweep — the property the dead band
// exists to buy.
//
// THERE ARE FOUR TIERS SINCE THE SECOND REPORT. "On narrow screens the presence
// icons hide the thread title ... Thread title is important" — with a
// screenshot of a thread header carrying NO title at all, at a width where the
// strip was still drawing three faces. The bottom tier, "bare", draws none:
// the mic glyph and a count, which is the smallest thing that still says there
// are people here and still opens the popover. The tier with nothing below it
// is its own boundary case and has its own group below.
import { describe, expect, it } from "vitest";
import { runWidthPx } from "../canvas/dock/face-geometry.js";
import { MAX_DOCK_BUBBLES } from "../canvas/dock/model.js";
import {
  chooseSqueeze,
  containerWidth,
  maxBubblesFor,
  nextSqueeze,
  SQUEEZE_BARE_MIN_PX,
  SQUEEZE_HYSTERESIS_PX,
  SQUEEZE_ROOMY_MIN_PX,
  SQUEEZE_TIGHT_MIN_PX,
  type SqueezeTier,
} from "../canvas/dock/squeeze.js";

/** Play a run of widths through nextSqueeze the way a ResizeObserver would
 * during a pane drag, and report how many times the layout actually changed.
 * At module scope rather than inside one describe: the anti-flap property is
 * asserted at three boundaries now, and the bottom one is in its own group. */
const sweep = (
  start: SqueezeTier,
  widths: readonly number[],
): { readonly transitions: number; readonly last: SqueezeTier } => {
  let tier = start;
  let transitions = 0;
  for (const width of widths) {
    const next = nextSqueeze(tier, width);
    if (next !== tier) transitions += 1;
    tier = next;
  }
  return { transitions, last: tier };
};

/** Every integer from `from` to `to` inclusive, in that order — a drag in one
 * direction. */
const range = (from: number, to: number): readonly number[] =>
  Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => (to >= from ? from + i : from - i));

describe("maxBubblesFor", () => {
  it("draws the strip's full complement when there is room", () => {
    // Not a second 6 written down next to model.ts's: the roomy tier IS the
    // strip's normal cap, so if that cap ever moves this answer moves with it.
    // Two constants that must agree are one constant with a bug in waiting.
    expect(maxBubblesFor("roomy")).toBe(MAX_DOCK_BUBBLES);
  });

  it("drops to four faces when the row is tight, and three when it is cramped", () => {
    // The overflow "+N" pill absorbs whoever is dropped, so a narrower strip
    // loses faces without losing people — which is why squeezing is allowed to
    // be this blunt.
    expect(maxBubblesFor("tight")).toBe(4);
    expect(maxBubblesFor("cramped")).toBe(3);
  });

  it("draws no faces at all at the bare tier", () => {
    // The user's own first option: "Perhaps if this is about to happen we
    // should drop the presence icons and just keep the mic icon?" Zero is a
    // real answer here, not a failure — the strip still shows the mic and a
    // count, and the popover still lists everyone.
    expect(maxBubblesFor("bare")).toBe(0);
  });

  it("never answers wider than the roomy tier, and only bare answers none", () => {
    // Guards the direction of the whole feature: every tier is a SQUEEZE, so
    // none of them may ask for more faces than the unsqueezed strip draws. The
    // lower bound used to be "more than none" for every tier; it is now "more
    // than none unless you are the tier whose whole purpose is none", which
    // keeps a typo in any OTHER tier from silently emptying the strip.
    const tiers: readonly SqueezeTier[] = ["roomy", "tight", "cramped", "bare"];
    for (const tier of tiers) {
      expect(maxBubblesFor(tier)).toBeLessThanOrEqual(MAX_DOCK_BUBBLES);
      expect(maxBubblesFor(tier)).toBeGreaterThanOrEqual(0);
      if (tier !== "bare") expect(maxBubblesFor(tier)).toBeGreaterThan(0);
    }
  });

  it("is a ladder: every tier down draws no more faces than the one above", () => {
    // Derived from the tiers rather than from four written-down numbers, so a
    // future tier cannot be inserted out of order without this failing.
    const descending: readonly SqueezeTier[] = ["roomy", "tight", "cramped", "bare"];
    for (let i = 1; i < descending.length; i += 1) {
      expect(maxBubblesFor(descending[i]!)).toBeLessThan(maxBubblesFor(descending[i - 1]!));
    }
  });
});

describe("chooseSqueeze", () => {
  it("is roomy on a desktop-width container", () => {
    expect(chooseSqueeze(1200)).toBe("roomy");
  });

  it("is tight on a split pane or a tablet", () => {
    expect(chooseSqueeze(600)).toBe("tight");
  });

  it("is cramped in a narrow pane, between the tight floor and the bare one", () => {
    // The tier's whole remaining range, and the reason it still exists: a row
    // this wide can afford three faces beside a title, which a phone's cannot.
    expect(chooseSqueeze(500)).toBe("cramped");
  });

  it("is bare at phone width", () => {
    // WAS "cramped" here, and that is the bug the user photographed: at this
    // width the strip drew three faces and the thread title had nothing left.
    expect(chooseSqueeze(380)).toBe("bare");
  });

  it("includes its own floor at each boundary", () => {
    // Both boundaries stated as ">= floor" so there is exactly one place an
    // off-by-one can hide, and this is it: the floor belongs to the wider tier.
    expect(chooseSqueeze(SQUEEZE_ROOMY_MIN_PX)).toBe("roomy");
    expect(chooseSqueeze(SQUEEZE_ROOMY_MIN_PX - 1)).toBe("tight");
    expect(chooseSqueeze(SQUEEZE_TIGHT_MIN_PX)).toBe("tight");
    expect(chooseSqueeze(SQUEEZE_TIGHT_MIN_PX - 1)).toBe("cramped");
    expect(chooseSqueeze(SQUEEZE_BARE_MIN_PX)).toBe("cramped");
    expect(chooseSqueeze(SQUEEZE_BARE_MIN_PX - 1)).toBe("bare");
  });

  it("answers cramped for a width that is not a measurement", () => {
    // A detached or not-yet-laid-out element measures 0, and a failed read can
    // arrive as NaN. Both are "I do not know", and with no history to fall back
    // on the safe answer is the SMALL one: three faces in a wide row look
    // sparse, six faces in a narrow one push bb's own header content out of it.
    // AND IT IS STILL "cramped", NOT THE NEW BOTTOM TIER. The bottom of the
    // ladder is no longer merely smaller, it is different in kind: bare removes
    // the faces entirely, and doing that on a guess deletes information the row
    // may well have had room for. Cramped remains the smallest layout that
    // still SHOWS who is here, which is what "safe" meant in the sentence
    // above.
    expect(chooseSqueeze(0)).toBe("cramped");
    expect(chooseSqueeze(-40)).toBe("cramped");
    expect(chooseSqueeze(Number.NaN)).toBe("cramped");
    expect(chooseSqueeze(Number.POSITIVE_INFINITY)).toBe("cramped");
  });
});

describe("nextSqueeze — with a tier already on screen", () => {
  it("agrees with chooseSqueeze once the width is nowhere near a boundary", () => {
    // Hysteresis is a dead band around the boundaries, not a memory: far from
    // one, history must not change the answer.
    expect(nextSqueeze("cramped", 1400)).toBe("roomy");
    expect(nextSqueeze("roomy", 300)).toBe("bare");
    // 700 rather than the 600 this used to use: 600 stopped being "nowhere
    // near a boundary" when SQUEEZE_TIGHT_MIN_PX moved up to 576, and a test
    // about history-free widths has to be seeded with one.
    expect(nextSqueeze("roomy", 700)).toBe("tight");
    expect(nextSqueeze("cramped", 700)).toBe("tight");
  });

  it("keeps the current tier when the width is not a measurement", () => {
    // The opposite answer from chooseSqueeze's, deliberately. A NaN or a 0
    // arriving mid-life is a measurement failure — a ResizeObserver firing on a
    // hidden ancestor, an element detached for one frame during a route change
    // — not a phone. Collapsing a working desktop strip to three faces because
    // one read came back blank is the visible bug; holding still is invisible.
    const tiers: readonly SqueezeTier[] = ["roomy", "tight", "cramped", "bare"];
    for (const tier of tiers) {
      expect(nextSqueeze(tier, Number.NaN)).toBe(tier);
      expect(nextSqueeze(tier, 0)).toBe(tier);
      expect(nextSqueeze(tier, -1)).toBe(tier);
      expect(nextSqueeze(tier, Number.POSITIVE_INFINITY)).toBe(tier);
    }
  });
});

describe("nextSqueeze — the hysteresis dead band", () => {
  it("holds a roomy strip roomy just below the roomy floor", () => {
    // A divider parked one pixel under the boundary must not cost the room two
    // faces; chooseSqueeze alone would say "tight" here.
    expect(chooseSqueeze(SQUEEZE_ROOMY_MIN_PX - 1)).toBe("tight");
    expect(nextSqueeze("roomy", SQUEEZE_ROOMY_MIN_PX - 1)).toBe("roomy");
    // Exactly the hysteresis under the floor is still "crossed by 48", not
    // "crossed by MORE than 48" — the band includes its own far edge.
    expect(nextSqueeze("roomy", SQUEEZE_ROOMY_MIN_PX - SQUEEZE_HYSTERESIS_PX)).toBe("roomy");
  });

  it("lets a roomy strip go tight once it is a whole band under the floor", () => {
    expect(nextSqueeze("roomy", SQUEEZE_ROOMY_MIN_PX - SQUEEZE_HYSTERESIS_PX - 1)).toBe(
      "tight",
    );
  });

  it("holds a tight strip tight just above the roomy floor", () => {
    // The other direction of the same boundary, and the one a naive
    // implementation gets wrong: shifting the thresholds down only would let
    // the strip widen at 761 and narrow at 759, which is the flap.
    expect(chooseSqueeze(SQUEEZE_ROOMY_MIN_PX + 1)).toBe("roomy");
    expect(nextSqueeze("tight", SQUEEZE_ROOMY_MIN_PX + 1)).toBe("tight");
    expect(nextSqueeze("tight", SQUEEZE_ROOMY_MIN_PX + SQUEEZE_HYSTERESIS_PX)).toBe("tight");
  });

  it("lets a tight strip go roomy once it is a whole band over the floor", () => {
    expect(nextSqueeze("tight", SQUEEZE_ROOMY_MIN_PX + SQUEEZE_HYSTERESIS_PX + 1)).toBe(
      "roomy",
    );
  });

  it("applies the same band to the tight/cramped boundary", () => {
    // Both boundaries or neither: the lower one is the one a phone actually
    // sits on when its on-screen keyboard opens and closes.
    expect(nextSqueeze("tight", SQUEEZE_TIGHT_MIN_PX - 1)).toBe("tight");
    expect(nextSqueeze("tight", SQUEEZE_TIGHT_MIN_PX - SQUEEZE_HYSTERESIS_PX)).toBe("tight");
    expect(nextSqueeze("tight", SQUEEZE_TIGHT_MIN_PX - SQUEEZE_HYSTERESIS_PX - 1)).toBe(
      "cramped",
    );
    expect(nextSqueeze("cramped", SQUEEZE_TIGHT_MIN_PX + 1)).toBe("cramped");
    expect(nextSqueeze("cramped", SQUEEZE_TIGHT_MIN_PX + SQUEEZE_HYSTERESIS_PX)).toBe(
      "cramped",
    );
    expect(nextSqueeze("cramped", SQUEEZE_TIGHT_MIN_PX + SQUEEZE_HYSTERESIS_PX + 1)).toBe(
      "tight",
    );
  });

  it("stops at the widest floor it has cleared by a band, not at the one it merely passed", () => {
    // A cramped strip widened past the tight floor's band is TIGHT, not roomy,
    // even though chooseSqueeze would say roomy at this width: the roomy floor
    // has not been cleared by a band, so the strip has no business sitting on
    // the far side of it yet.
    expect(chooseSqueeze(SQUEEZE_ROOMY_MIN_PX + 1)).toBe("roomy");
    expect(nextSqueeze("cramped", SQUEEZE_ROOMY_MIN_PX + 1)).toBe("tight");
    // And the other half of the same rule, which is NOT "one tier per call":
    // once the width is past BOTH bands nothing is near a boundary, so there is
    // nothing to be sticky about and the strip goes straight to roomy. Pinned
    // because a stepwise promotion would look equally reasonable in the code
    // and would leave a maximised window two resize events short of its layout.
    expect(nextSqueeze("cramped", SQUEEZE_ROOMY_MIN_PX + SQUEEZE_HYSTERESIS_PX + 1)).toBe(
      "roomy",
    );
  });
});

describe("nextSqueeze — the anti-flap property", () => {
  // The whole reason hysteresis exists. A ResizeObserver delivers every
  // intermediate width of a pane drag, and a bare threshold turns the pixels
  // around a boundary into a strobe: 759 tight, 760 roomy, 759 tight, at frame
  // rate. These sweep the same widths a drag would and assert the layout
  // changes at most once.
  it("changes at most once while a pane is dragged wider across the roomy floor", () => {
    const widths = range(SQUEEZE_ROOMY_MIN_PX - 60, SQUEEZE_ROOMY_MIN_PX + 60);
    const { transitions, last } = sweep(chooseSqueeze(widths[0]!), widths);
    expect(transitions).toBeLessThanOrEqual(1);
    // And it does eventually get there — a dead band that never releases is
    // just a stuck layout.
    expect(last).toBe("roomy");
  });

  it("changes at most once while the same pane is dragged narrower again", () => {
    const widths = range(SQUEEZE_ROOMY_MIN_PX + 60, SQUEEZE_ROOMY_MIN_PX - 60);
    const { transitions, last } = sweep(chooseSqueeze(widths[0]!), widths);
    expect(transitions).toBeLessThanOrEqual(1);
    expect(last).toBe("tight");
  });

  it("changes at most once across the cramped floor, in both directions", () => {
    const up = range(SQUEEZE_TIGHT_MIN_PX - 60, SQUEEZE_TIGHT_MIN_PX + 60);
    const down = range(SQUEEZE_TIGHT_MIN_PX + 60, SQUEEZE_TIGHT_MIN_PX - 60);
    expect(sweep(chooseSqueeze(up[0]!), up).transitions).toBeLessThanOrEqual(1);
    expect(sweep(chooseSqueeze(down[0]!), down).transitions).toBeLessThanOrEqual(1);
  });

  it("does not move at all while a scrollbar appears and disappears on a boundary", () => {
    // The concrete case: a container resting exactly on the roomy floor, with
    // a ~15px scrollbar toggling. Every one of these widths is inside the band,
    // so the strip must be perfectly still.
    const jitter = [
      SQUEEZE_ROOMY_MIN_PX,
      SQUEEZE_ROOMY_MIN_PX - 15,
      SQUEEZE_ROOMY_MIN_PX,
      SQUEEZE_ROOMY_MIN_PX - 15,
      SQUEEZE_ROOMY_MIN_PX + 15,
      SQUEEZE_ROOMY_MIN_PX - 15,
    ];
    expect(sweep("roomy", jitter)).toEqual({ transitions: 0, last: "roomy" });
    expect(sweep("tight", jitter)).toEqual({ transitions: 0, last: "tight" });
  });
});

describe("the shape of the ladder", () => {
  // The floors are not free numbers: each boundary needs a hysteresis band on
  // both sides, and two boundaries closer together than two bands would share
  // one — a width could then be inside both, and the tier between them would
  // have no run of widths it is simply, unambiguously the answer for. These are
  // the invariants the three floors have to keep, checked against each other
  // rather than against four literals written down a second time.
  const floors = [SQUEEZE_ROOMY_MIN_PX, SQUEEZE_TIGHT_MIN_PX, SQUEEZE_BARE_MIN_PX];

  it("hands the row back the 21px of face run the bare floor's derivation claims", () => {
    // SQUEEZE_BARE_MIN_PX is justified partly by what dropping from four faces
    // to three gives the header row: 21px of face run plus 4px of the strip's
    // side padding, 25px in all. The padding half lives in a CSS string and is
    // not exported, so only the run is checkable here — and the run is the half
    // that moves, because canvas/dock/face-geometry.ts has already been retuned
    // once. NOT A RED-THEN-GREEN TEST and not pretending to be one: it pins a
    // claim a comment makes about constants that were already correct, so that
    // the comment cannot quietly stop being true.
    const given =
      runWidthPx("tight", maxBubblesFor("tight")) -
      runWidthPx("cramped", maxBubblesFor("cramped"));
    expect(given).toBe(21);
  });

  it("orders the floors widest to narrowest", () => {
    for (let i = 1; i < floors.length; i += 1) {
      expect(floors[i]!).toBeLessThan(floors[i - 1]!);
    }
  });

  it("keeps MORE than two hysteresis bands between adjacent floors", () => {
    // The rule that fixed the new floor's value as much as any judgement about
    // titles did: SQUEEZE_TIGHT_MIN_PX had to move up to make room for it.
    // Strictly more, not "at least": at exactly two bands the two boundaries'
    // dead bands meet and the tier between them owns nothing — which is the
    // next test, and which is how the first draft of this floor (432 under a
    // 528 tight floor) was caught.
    for (let i = 1; i < floors.length; i += 1) {
      expect(floors[i - 1]! - floors[i]!).toBeGreaterThan(2 * SQUEEZE_HYSTERESIS_PX);
    }
  });

  it("gives every tier a run of widths that is unambiguously its own", () => {
    // The consequence of the rule above, stated as behaviour: for each floor
    // there is a width the tier owns outright — one that answers the same tier
    // whatever was on screen before it.
    const tiers: readonly SqueezeTier[] = ["roomy", "tight", "cramped", "bare"];
    const owned = [
      SQUEEZE_ROOMY_MIN_PX + SQUEEZE_HYSTERESIS_PX + 1,
      SQUEEZE_TIGHT_MIN_PX + SQUEEZE_HYSTERESIS_PX + 1,
      SQUEEZE_BARE_MIN_PX + SQUEEZE_HYSTERESIS_PX + 1,
      SQUEEZE_BARE_MIN_PX - SQUEEZE_HYSTERESIS_PX - 1,
    ];
    for (const [index, width] of owned.entries()) {
      const expected = tiers[index]!;
      for (const from of tiers) {
        expect(nextSqueeze(from, width)).toBe(expected);
      }
    }
  });
});

describe("nextSqueeze — the bottom of the ladder", () => {
  // A tier with nothing below it is a boundary case in its own right: the
  // narrowing cascade has to fall THROUGH every floor and land somewhere, and
  // the widening cascade has to have a bottom answer for a width that cleared
  // no floor at all.
  it("applies the same band to the cramped/bare boundary", () => {
    expect(nextSqueeze("cramped", SQUEEZE_BARE_MIN_PX - 1)).toBe("cramped");
    expect(nextSqueeze("cramped", SQUEEZE_BARE_MIN_PX - SQUEEZE_HYSTERESIS_PX)).toBe("cramped");
    expect(nextSqueeze("cramped", SQUEEZE_BARE_MIN_PX - SQUEEZE_HYSTERESIS_PX - 1)).toBe("bare");
    expect(nextSqueeze("bare", SQUEEZE_BARE_MIN_PX + 1)).toBe("bare");
    expect(nextSqueeze("bare", SQUEEZE_BARE_MIN_PX + SQUEEZE_HYSTERESIS_PX)).toBe("bare");
    expect(nextSqueeze("bare", SQUEEZE_BARE_MIN_PX + SQUEEZE_HYSTERESIS_PX + 1)).toBe("cramped");
  });

  it("stays bare however narrow the container gets", () => {
    // There is no tier under this one, so the answer for a container narrower
    // than the bare floor is the same answer at every width: no faces. Pinned
    // because a cascade written with one branch too few would fall off the end
    // and return the WIDEST tier for the NARROWEST container.
    for (const width of [SQUEEZE_BARE_MIN_PX - SQUEEZE_HYSTERESIS_PX - 1, 200, 100, 20, 1]) {
      expect(chooseSqueeze(width)).toBe("bare");
      expect(nextSqueeze("bare", width)).toBe("bare");
    }
  });

  it("lets a strip fall all the way to bare from any tier above it", () => {
    // Narrowing is one boundary per call by design (each floor keeps the tier
    // above it while the width is still within a band of it), so this walks the
    // same width down through the ladder the way a pane drag would.
    let tier: SqueezeTier = "roomy";
    for (const width of [SQUEEZE_ROOMY_MIN_PX, SQUEEZE_TIGHT_MIN_PX, SQUEEZE_BARE_MIN_PX, 100]) {
      tier = nextSqueeze(tier, width);
    }
    expect(tier).toBe("bare");
  });

  it("changes at most once across the bare floor, in both directions", () => {
    const up = range(SQUEEZE_BARE_MIN_PX - 60, SQUEEZE_BARE_MIN_PX + 60);
    const down = range(SQUEEZE_BARE_MIN_PX + 60, SQUEEZE_BARE_MIN_PX - 60);
    expect(sweep(chooseSqueeze(up[0]!), up)).toEqual({ transitions: 1, last: "cramped" });
    expect(sweep(chooseSqueeze(down[0]!), down)).toEqual({ transitions: 1, last: "bare" });
  });

  it("does not move while a scrollbar appears and disappears on the bare floor", () => {
    // The same concrete case the roomy floor is pinned against, at the boundary
    // a phone actually sits on.
    const jitter = [
      SQUEEZE_BARE_MIN_PX,
      SQUEEZE_BARE_MIN_PX - 15,
      SQUEEZE_BARE_MIN_PX + 15,
      SQUEEZE_BARE_MIN_PX - 15,
    ];
    expect(sweep("cramped", jitter)).toEqual({ transitions: 0, last: "cramped" });
    expect(sweep("bare", jitter)).toEqual({ transitions: 0, last: "bare" });
  });
});

describe("containerWidth — which measurement the tier is decided from", () => {
  // The strip has three placements (canvas/dock/anchor.ts): two inside bb's
  // page-header row, and "fixed" on the routes that render no header at all.
  // So "how wide is the container" has two possible answers and a rule for
  // choosing between them, and that rule is a decision — which is why it is
  // here and not inline in dock.ts, where nothing could reach it.
  it("answers the row's width whenever the row could be measured", () => {
    // The row is the real constraint in both in-row placements: it is the
    // flex line the strip's faces come out of.
    expect(containerWidth(640, 1440)).toBe(640);
  });

  it("answers the viewport when there is no row at all", () => {
    // The fixed placement, and correct there rather than a fallback: a strip
    // pinned to the top-right corner of the window is constrained by the
    // window.
    expect(containerWidth(null, 1440)).toBe(1440);
  });

  it("refuses to answer for a row that is there but unmeasurable", () => {
    // 0 is what a row inside a `display: none` ancestor reports mid route
    // change, and what a detached one reports. It is NOT a narrow window, and
    // the viewport is NOT a stand-in for it — a 500px row inside a split pane
    // sits in a 1440px window, so answering with the window would repaint the
    // strip roomy on a row that has no room. There is a right answer for "I
    // could not measure" already: hand back something that is not a
    // measurement and let nextSqueeze hold the layout it has.
    for (const unmeasurable of [0, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Number.isFinite(containerWidth(unmeasurable, 1440))).toBe(false);
    }
    const tiers: readonly SqueezeTier[] = ["roomy", "tight", "cramped", "bare"];
    for (const tier of tiers) {
      expect(nextSqueeze(tier, containerWidth(0, 1440))).toBe(tier);
    }
  });

  it("composes into the safe end of the range when it is the first measurement", () => {
    // The other consumer, and the reason "not a measurement" is expressed as a
    // number rather than as a null: at mount there is no tier to hold, and
    // chooseSqueeze already has an answer for an unknown width — the small
    // one. A strip that starts sparse and widens on the next pass is invisible;
    // one that starts six faces wide inside a phone-width row shoves bb's own
    // title out of the bar before it corrects itself.
    expect(chooseSqueeze(containerWidth(0, 1440))).toBe("cramped");
    expect(chooseSqueeze(containerWidth(null, 1440))).toBe("roomy");
  });
});
