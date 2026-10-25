import { describe, expect, it } from "vitest";
import { ROW_HEIGHT_PX, decideTier, facesForTier, placePopover } from "../src/presence/ui/layout.js";

describe("strip tiers", () => {
  it("costs one 36px line, and says so in one place", () => {
    expect(ROW_HEIGHT_PX).toBe(36);
  });

  it("follows the sidebar's width down to bb's collapsed rail", () => {
    expect(decideTier(260)).toBe("full");
    expect(decideTier(190)).toBe("full");
    expect(decideTier(189)).toBe("narrow");
    expect(decideTier(110)).toBe("narrow");
    expect(decideTier(109)).toBe("rail");
    expect(decideTier(48)).toBe("rail");
  });

  it("assumes the expanded sidebar when the width is not knowable yet", () => {
    expect(decideTier(0)).toBe("full");
    expect(decideTier(Number.NaN)).toBe("full");
  });

  it("gives each tier only the faces it has room for", () => {
    expect(facesForTier("full")).toBe(3);
    expect(facesForTier("narrow")).toBe(2);
    expect(facesForTier("rail")).toBe(0);
  });
});

describe("popover placement", () => {
  const viewport = { width: 1_280, height: 900 };
  const desired = { width: 270, height: 340 };

  it("hangs above the row, clamped inside the viewport", () => {
    const placement = placePopover({
      anchor: { top: 800, left: 12, width: 240, height: 36 },
      viewport,
      desired,
    });
    expect(placement.side).toBe("above");
    expect(placement.bottom).toBe(108);
    expect(placement.left).toBe(12);
    expect(placement.width).toBe(270);
    expect(placement.maxHeight).toBe(340);
  });

  it("flips below when there is no room above", () => {
    const placement = placePopover({
      anchor: { top: 8, left: 12, width: 240, height: 36 },
      viewport,
      desired,
    });
    expect(placement.side).toBe("below");
    expect(placement.top).toBe(52);
    expect(placement.maxHeight).toBe(340);
  });

  it("shrinks rather than overflowing a short viewport", () => {
    const placement = placePopover({
      anchor: { top: 180, left: 12, width: 240, height: 36 },
      viewport: { width: 1_280, height: 420 },
      desired,
    });
    expect(placement.maxHeight).toBeLessThanOrEqual(180);
    expect(placement.maxHeight).toBeGreaterThan(0);
  });

  it("never runs off the right edge of a narrow window", () => {
    const placement = placePopover({
      anchor: { top: 600, left: 300, width: 44, height: 36 },
      viewport: { width: 320, height: 700 },
      desired,
    });
    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.left + placement.width).toBeLessThanOrEqual(320 - 8 + 1);
  });

  it("keeps a usable width on a phone", () => {
    const placement = placePopover({
      anchor: { top: 600, left: 0, width: 300, height: 36 },
      viewport: { width: 200, height: 700 },
      desired,
    });
    expect(placement.width).toBe(184);
    expect(placement.left).toBe(8);
  });
});
