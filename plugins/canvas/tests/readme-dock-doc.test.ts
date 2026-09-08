// Run: npx vitest run tests/readme-dock-doc.test.ts
//
// THE README IS THE ONLY PLACE SOME OF THIS PROJECT'S BEHAVIOUR IS WRITTEN
// DOWN, and it is 100KB of prose that no compiler reads. The dock's thresholds
// have now moved twice — SQUEEZE_TIGHT_MIN_PX from 480 to 576 to make room for
// a fourth tier under it — and each time the prose kept the old digits while
// the code moved. A reader following the README to reproduce a tier boundary
// then measures something the code never does, which is worse than no document
// at all: they trust it.
//
// WHAT THIS TEST DOES, EXACTLY, so nobody mistakes it for a proof-read. It
// checks the two things a machine can check about prose without judging it:
//
//   1. NUMBER ADJACENCY. Wherever the README writes a threshold's NAME, the
//      first number after it must be that threshold's value. This is the drift
//      that actually happened, and it is caught at the site of the mistake.
//   2. NAME COVERAGE. The two places that enumerate the tier ladder must name
//      every tier there is. The tier list is a `Record<SqueezeTier, ...>`, so
//      adding a fifth tier to the union is a TYPE error here — the ladder
//      cannot grow without this test being made to notice.
//
// WHAT IT DOES NOT CHECK, said plainly because a green here is easy to
// overclaim: not that a number is in the right SENTENCE (432 appearing in the
// smoke block satisfies the crossing check whether it is described as the bare
// floor or as something else), not that the surrounding prose is true, and not
// that any of it matches a running browser — there is no browser in this spike
// and every geometry claim in that document is reasoned, not observed. Prose
// review is a human's job; this only makes the DIGITS unable to rot silently.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POPOVER_ANCHOR_GAP_PX,
  POPOVER_EDGE_MARGIN_PX,
} from "../canvas/dock/popover-place.js";
import {
  SQUEEZE_BARE_MIN_PX,
  SQUEEZE_HYSTERESIS_PX,
  SQUEEZE_ROOMY_MIN_PX,
  SQUEEZE_TIGHT_MIN_PX,
  type SqueezeTier,
} from "../canvas/dock/squeeze.js";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/**
 * The constants whose value the README quotes, by the name it quotes them
 * under. Imported rather than typed, which is the whole point: this table
 * cannot be the thing that is stale.
 *
 * MAX_DOCK_BUBBLES IS DELIBERATELY ABSENT even though the README names it
 * repeatedly. It is a count, and the prose around it reads "`MAX_DOCK_BUBBLES`
 * faces at 24px" — the next number after the name is a face DIAMETER, not the
 * count, so the adjacency rule below would be asking the wrong question of it.
 * A rule that has to be argued with at one of its call sites is a rule that
 * teaches people to work around it.
 */
const QUOTED_CONSTANTS: ReadonlyArray<readonly [string, number]> = [
  ["SQUEEZE_ROOMY_MIN_PX", SQUEEZE_ROOMY_MIN_PX],
  ["SQUEEZE_TIGHT_MIN_PX", SQUEEZE_TIGHT_MIN_PX],
  ["SQUEEZE_BARE_MIN_PX", SQUEEZE_BARE_MIN_PX],
  ["SQUEEZE_HYSTERESIS_PX", SQUEEZE_HYSTERESIS_PX],
  ["POPOVER_EDGE_MARGIN_PX", POPOVER_EDGE_MARGIN_PX],
  ["POPOVER_ANCHOR_GAP_PX", POPOVER_ANCHOR_GAP_PX],
];

/**
 * How far past a constant's name to look for the number it is being quoted as.
 *
 * 24 characters, which is enough for every shape the README actually uses —
 * "` is **760**", "`, 760px)", "` (48px — " — and short enough that the NEXT
 * sentence's numbers cannot be mistaken for this one's. Chosen against the
 * document rather than in the abstract; if a future edit puts more than a couple
 * of words between a name and its value, widen this rather than dropping the
 * check.
 */
const ADJACENCY_WINDOW = 24;

/** Every place the README writes this name, paired with the first number that
 * follows it within the window (null when there is none — a name mentioned in
 * passing, e.g. "`MAX_DOCK_BUBBLES` came from", is not a quotation of a value
 * and is not held to one). */
function numbersQuotedFor(name: string): ReadonlyArray<{ line: number; found: number | null }> {
  const out: Array<{ line: number; found: number | null }> = [];
  let at = README.indexOf(name);
  while (at !== -1) {
    const window = README.slice(at + name.length, at + name.length + ADJACENCY_WINDOW);
    const match = /\d+/.exec(window);
    out.push({
      // 1-indexed, so a failure message can be opened straight in an editor.
      line: README.slice(0, at).split("\n").length,
      found: match === null ? null : Number(match[0]),
    });
    at = README.indexOf(name, at + name.length);
  }
  return out;
}

/** The slice of the README between two markers, with a loud failure when a
 * marker has gone. The disappearance of a section is itself drift worth
 * failing on: a check that silently passes over a region that no longer exists
 * is the check being deleted by accident. */
function section(start: string, end: string): string {
  const from = README.indexOf(start);
  expect(from, `README no longer contains the marker ${JSON.stringify(start)}`).toBeGreaterThan(-1);
  const to = README.indexOf(end, from);
  expect(to, `README no longer contains the marker ${JSON.stringify(end)}`).toBeGreaterThan(-1);
  return README.slice(from, to);
}

/**
 * The tiers, as an exhaustive record so the TYPE is what keeps this list
 * complete. A fifth member of `SqueezeTier` fails to compile here rather than
 * quietly leaving the new tier undocumented — which is exactly how `bare` got
 * added to the code and not to the prose.
 */
const TIER_PRESENCE: Record<SqueezeTier, true> = {
  roomy: true,
  tight: true,
  cramped: true,
  bare: true,
};
const TIERS = Object.keys(TIER_PRESENCE) as SqueezeTier[];

describe("README: the numbers it quotes are the numbers the code uses", () => {
  for (const [name, value] of QUOTED_CONSTANTS) {
    it(`quotes ${name} as ${value} everywhere it quotes it at all`, () => {
      const quotes = numbersQuotedFor(name);
      expect(quotes.length, `${name} is never mentioned in README.md`).toBeGreaterThan(0);
      for (const quote of quotes) {
        if (quote.found === null) continue;
        expect(
          quote.found,
          `README.md:${quote.line} writes ${quote.found} beside ${name}, which is ${value}`,
        ).toBe(value);
      }
    });
  }
});

describe("README: the tier ladder is documented in full", () => {
  // The design half — the section that explains WHY the strip squeezes.
  const design = section(
    "#### Narrow screens: presence is what gives up width",
    "#### The 📜 button",
  );
  // The instruction half — the smoke steps a human walks the ladder with.
  const smoke = section(
    "**The squeeze — giving the page title its width back**",
    "**The popover stays on the screen",
  );

  for (const tier of TIERS) {
    it(`names the "${tier}" tier where the ladder is explained`, () => {
      expect(design).toContain(`\`${tier}\``);
    });

    it(`names the "${tier}" tier in the smoke checklist`, () => {
      expect(smoke).toContain(tier);
    });
  }

  // The widths a human actually watches for while dragging a divider are the
  // floors PLUS AND MINUS the band, never the floors themselves — that is what
  // hysteresis means, and a checklist quoting the bare floors would have the
  // reader disbelieving a correct implementation. Derived here so the two
  // directions cannot be half-updated.
  for (const floor of [SQUEEZE_ROOMY_MIN_PX, SQUEEZE_TIGHT_MIN_PX, SQUEEZE_BARE_MIN_PX]) {
    it(`quotes both crossings of the ${floor}px floor (${floor - SQUEEZE_HYSTERESIS_PX} down, ${floor + SQUEEZE_HYSTERESIS_PX} up)`, () => {
      expect(smoke).toContain(String(floor - SQUEEZE_HYSTERESIS_PX));
      expect(smoke).toContain(String(floor + SQUEEZE_HYSTERESIS_PX));
    });
  }
});
