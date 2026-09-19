import { describe, expect, it } from "vitest";
import {
  CLASH_DISTANCE,
  DARK_INK,
  LIGHT_INK,
  MIN_INK_CONTRAST,
  colorDistance,
  colorsClash,
  contrastRatio,
  normalizeColorChoice,
  parseCssColor,
  readableInk,
  resolvePersonColor,
} from "./person-colors.js";
import { personColor } from "./ownership-labels.js";

describe("normalizeColorChoice", () => {
  it("normalises a six-digit hex to lowercase", () => {
    expect(normalizeColorChoice("#A1B2C3")).toBe("#a1b2c3");
  });

  it("expands a three-digit hex, because a native colour input is not the only caller", () => {
    expect(normalizeColorChoice("#abc")).toBe("#aabbcc");
  });

  it("tolerates surrounding whitespace", () => {
    expect(normalizeColorChoice("  #FFFFFF \n")).toBe("#ffffff");
  });

  it("accepts a missing leading hash", () => {
    expect(normalizeColorChoice("112233")).toBe("#112233");
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a named colour", "rebeccapurple"],
    ["an hsl string", "hsl(120 55% 38%)"],
    ["an rgb string", "rgb(1,2,3)"],
    ["a four-digit hex", "#abcd"],
    ["a non-hex digit", "#gggggg"],
    ["a css injection attempt", "#fff; background: url(x)"],
    ["something far too long", `#${"a".repeat(200)}`],
  ])("rejects %s", (_label, input) => {
    expect(normalizeColorChoice(input)).toBeNull();
  });

  it("rejects a non-string", () => {
    expect(normalizeColorChoice(undefined)).toBeNull();
    expect(normalizeColorChoice(null)).toBeNull();
    expect(normalizeColorChoice(42 as unknown as string)).toBeNull();
  });
});

describe("parseCssColor", () => {
  it("reads the stored hex format", () => {
    expect(parseCssColor("#ff8000")).toEqual({ r: 255, g: 128, b: 0 });
  });

  it("reads the dealt hsl format personColor emits, so the two can be compared", () => {
    // hsl(0 55% 38%) is a mid red: l=0.38, s=0.55 -> max .589, min .171
    expect(parseCssColor("hsl(0 55% 38%)")).toEqual({ r: 150, g: 44, b: 44 });
  });

  it("reads every hue personColor can deal", () => {
    for (let seat = 0; seat < 12; seat += 1) {
      const dealt = personColor(`p${seat}`, Array.from({ length: 12 }, (_, i) => `p${i}`));
      expect(parseCssColor(dealt), dealt).not.toBeNull();
    }
  });

  it("returns null for the no-person var(), which has no numeric colour", () => {
    expect(parseCssColor("var(--muted-foreground, #6b7280)")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("is 1 for a colour against itself", () => {
    expect(contrastRatio("#3366aa", "#3366aa")).toBeCloseTo(1, 5);
  });

  it("is null when either colour cannot be parsed", () => {
    expect(contrastRatio("nonsense", "#ffffff")).toBeNull();
  });
});

describe("readableInk", () => {
  it("puts white on a dark fill", () => {
    expect(readableInk("#111111")).toBe(LIGHT_INK);
  });

  it("puts dark ink on a very light fill — the unreadable case this exists for", () => {
    expect(readableInk("#ffff99")).toBe(DARK_INK);
  });

  it("beats fixed white ink on the dealt hues white was NOT actually legible on", () => {
    // personColor's own comment claims "white text stays legible on every hue". It is
    // not so: the yellow seat, hsl(60 55% 38%), gives white only 3.14:1 — under WCAG AA
    // for normal text, which is what the 9px badge is. Adapting the ink fixes that hue
    // (5.66:1) without touching the ones white really was fine on.
    const roster = ["a", "b", "c", "d", "e", "f"];
    const yellowSeat = personColor("b", roster);
    expect(yellowSeat).toBe("hsl(60 55% 38%)");
    expect(contrastRatio(LIGHT_INK, yellowSeat) as number).toBeLessThan(MIN_INK_CONTRAST);
    expect(readableInk(yellowSeat)).toBe(DARK_INK);

    const redSeat = personColor("a", roster);
    expect(readableInk(redSeat)).toBe(LIGHT_INK);

    for (const person of roster) {
      const ratio = contrastRatio(readableInk(personColor(person, roster)), personColor(person, roster));
      expect(ratio as number, person).toBeGreaterThanOrEqual(MIN_INK_CONTRAST);
    }
  });

  it("always reaches the legibility floor, for every colour a person could pick", () => {
    for (let r = 0; r < 256; r += 51) {
      for (let g = 0; g < 256; g += 51) {
        for (let b = 0; b < 256; b += 51) {
          const fill = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          const ratio = contrastRatio(readableInk(fill), fill);
          expect(ratio, `${fill} -> ${readableInk(fill)}`).not.toBeNull();
          expect(ratio as number, `${fill} -> ${readableInk(fill)}`).toBeGreaterThanOrEqual(MIN_INK_CONTRAST);
        }
      }
    }
  });

  it("falls back to white when the fill is not a colour it can read", () => {
    expect(readableInk("var(--muted-foreground, #6b7280)")).toBe(LIGHT_INK);
  });
});

describe("colorsClash", () => {
  it("says two identical colours clash", () => {
    expect(colorsClash("#336699", "#336699")).toBe(true);
  });

  it("says two barely-different colours clash", () => {
    expect(colorsClash("#336699", "#34679a")).toBe(true);
  });

  it("does not say two obviously different colours clash", () => {
    expect(colorsClash("#aa2222", "#2222aa")).toBe(false);
  });

  it("compares a chosen hex against a dealt hsl", () => {
    const dealt = personColor("a", ["a", "b"]);
    const parsed = parseCssColor(dealt);
    expect(parsed).not.toBeNull();
    const asHex = `#${[parsed!.r, parsed!.g, parsed!.b]
      .map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    expect(colorsClash(dealt, asHex)).toBe(true);
  });

  it("never claims a clash it cannot see (an unparseable colour)", () => {
    expect(colorsClash("var(--muted-foreground, #6b7280)", "#336699")).toBe(false);
  });

  it("exposes the threshold it judged by, so the UI can explain itself", () => {
    expect(colorDistance("#336699", "#336699")).toBe(0);
    expect(colorDistance("#000000", "#ffffff")).toBeGreaterThan(CLASH_DISTANCE);
    expect(colorDistance("nope", "#ffffff")).toBeNull();
  });
});

describe("resolvePersonColor", () => {
  const roster = ["alice", "bob", "carol"];

  it("deals a colour when nothing is overridden", () => {
    expect(resolvePersonColor("bob", roster, {})).toEqual({
      color: personColor("bob", roster),
      overridden: false,
      dealt: personColor("bob", roster),
    });
  });

  it("prefers the override, and still reports the dealt colour behind it", () => {
    expect(resolvePersonColor("bob", roster, { bob: "#ff0000" })).toEqual({
      color: "#ff0000",
      overridden: true,
      dealt: personColor("bob", roster),
    });
  });

  it("ignores an override stored in a shape it cannot use, rather than rendering it", () => {
    expect(resolvePersonColor("bob", roster, { bob: "javascript:alert(1)" }).overridden).toBe(false);
  });

  it("resolves nobody to the neutral colour and never calls it overridden", () => {
    const resolved = resolvePersonColor(null, roster, { bob: "#ff0000" });
    expect(resolved.overridden).toBe(false);
    expect(resolved.color).toBe(personColor(null, roster));
  });
});
