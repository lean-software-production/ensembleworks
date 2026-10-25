// Run: npx vitest run tests/dock-whereabouts.test.ts
//
// "WHICH TAB OF THIS PERSON DO WE MEAN?" — and, for the thread rows, why that
// question is not asked at all.
//
// THE DEFECT THIS FILE EXISTS TO PIN. The first cut of `locateEveryone`
// collapsed a person's tabs with `argmax(seenMs)`: the tab that most recently
// said where it was won. Every bb window polls `canvas_roster` on its own 2s
// timer, and each poll rewrites that tab's `seenMs` — so for somebody with two
// LIVE, VISIBLE windows the winner was decided by whichever of two drifting
// timers happened to fire last before the viewer's own poll. The person
// teleported between their windows with nothing in the world changing: the
// thread-row glyph blinked on and off every few seconds, their popover line
// flip-flopped between "on the canvas" and "in “…”", and the jump link's href
// changed under the pointer between clicks. Measured live: nine 0↔1 row
// transitions in 45 seconds for one person steadily reading one thread.
//
// The answer is two different answers, because they are two different
// questions:
//
//   * THE ROWS DO NOT COLLAPSE AT ALL (`locatedTabs`). A row lights up if ANY
//     live tab of yours is on that thread — the union, not a vote. There is no
//     argmax to oscillate, and `threadRowPresence` already deduplicates names,
//     so nobody gets two faces out of it.
//   * THE POPOVER LINE AND ITS LINK still need ONE place per person, so
//     `locateEveryone` ranks FOCUS above recency (a focused window is the
//     honest answer to "where are you") and, among equals, KEEPS THE TAB IT
//     LAST CHOSE unless a rival is newer by more than a poll period. Recency
//     alone is a coin flip; recency with hysteresis is stable.
import { describe, expect, it } from "vitest";
import {
  WHERE_STICKY_LEAD_MS,
  locateEveryone,
  locatedTabs,
  whereChoiceOf,
  type DockRosterEntry,
} from "../canvas/dock/model.js";
import { threadRowPresence } from "../canvas/dock/thread-status.js";
import { parseLocation } from "../canvas/dock/where.js";

const T1 = "/projects/p1/threads/t1";
const T2 = "/projects/p1/threads/t2";
const CANVAS = "/plugins/canvas/canvas";

const tab = (
  clientId: string,
  name: string,
  path: string | null,
  seenMs: number | null,
  focused = false,
): DockRosterEntry => ({ clientId, name, path, title: null, seenMs, focused });

/**
 * One round of the real-world state that broke this: two live visible tabs of
 * one person, polling on their own 2s clocks, phases drifting past each other
 * so the "most recent" one alternates. Nothing about where alice IS changes.
 */
function drifting(round: number): DockRosterEntry[] {
  const base = 10_000 * round;
  const [a, b] = round % 2 === 0 ? [900, 0] : [0, 900];
  return [
    tab("c1", "alice", T1, base + a!),
    tab("c2", "alice", CANVAS, base + b!),
  ];
}

describe("locateEveryone, when one person has several live tabs", () => {
  it("does not change its mind while their tabs take turns polling last", () => {
    // THE RED THIS ROUND WAS MISSING. Feed the answer back in, exactly as the
    // strip does between renders, and the choice must survive the drift.
    let choice = whereChoiceOf([]);
    const answers: (string | null)[] = [];
    for (let round = 0; round < 8; round += 1) {
      const where = locateEveryone(drifting(round), choice);
      choice = whereChoiceOf(where);
      answers.push(where[0]?.path ?? null);
    }
    expect(new Set(answers).size).toBe(1);
  });

  it("prefers the tab that says it has focus, however recently the others polled", () => {
    // A focused window is the honest answer to "where are you". Recency is a
    // statement about a timer; focus is a statement about a person.
    const where = locateEveryone([
      tab("c1", "alice", T1, 1_000, true),
      tab("c2", "alice", CANVAS, 99_000),
    ]);
    expect(where[0]?.path).toBe(T1);
    expect(where[0]?.clientId).toBe("c1");
  });

  it("follows the focus when the person switches windows", () => {
    // Hysteresis must not become stickiness: a REAL signal moves the answer at
    // once, and the person alt-tabbing is as real as it gets.
    const held = whereChoiceOf(
      locateEveryone([
        tab("c1", "alice", T1, 1_000, true),
        tab("c2", "alice", CANVAS, 1_000),
      ]),
    );
    const where = locateEveryone(
      [tab("c1", "alice", T1, 2_000), tab("c2", "alice", CANVAS, 2_000, true)],
      held,
    );
    expect(where[0]?.path).toBe(CANVAS);
  });

  it("lets go of a tab that has gone quiet for longer than a poll period", () => {
    // The drift between two live tabs is under one poll period by
    // construction. A rival that is ahead by MORE than that is not drift — the
    // held tab has stopped reporting, and holding on would be exactly the
    // stale answer this feature refuses to give.
    const held = whereChoiceOf(
      locateEveryone([tab("c1", "alice", T1, 1_000), tab("c2", "alice", CANVAS, 1_000)]),
    );
    expect(held.get("alice")).toBe("c1");
    const where = locateEveryone(
      [
        tab("c1", "alice", T1, 1_000),
        tab("c2", "alice", CANVAS, 1_000 + WHERE_STICKY_LEAD_MS + 1),
      ],
      held,
    );
    expect(where[0]?.path).toBe(CANVAS);
  });

  it("lets go of a tab that has left the roster", () => {
    const held = whereChoiceOf(
      locateEveryone([tab("c1", "alice", T1, 1_000), tab("c2", "alice", CANVAS, 1_000)]),
    );
    const where = locateEveryone([tab("c2", "alice", CANVAS, 1_100)], held);
    expect(where[0]?.path).toBe(CANVAS);
    expect(where[0]?.clientId).toBe("c2");
  });

  it("still refuses to let an unlocated tab win, however recent it is", () => {
    const where = locateEveryone([
      tab("c1", "alice", T1, 1_000),
      tab("c2", "alice", null, 99_000, true),
    ]);
    expect(where[0]?.path).toBe(T1);
  });

  it("names the tab it chose, which is the memory the caller holds", () => {
    const where = locateEveryone([tab("c1", "alice", T1, 1_000)]);
    expect(where[0]?.clientId).toBe("c1");
    expect([...whereChoiceOf(where)]).toEqual([["alice", "c1"]]);
  });

  it("picks the same tab twice given the same roster and no memory", () => {
    // Determinism first: without a previous choice the answer must not depend
    // on which order the server happened to serialise two equal tabs in.
    const forwards = locateEveryone([
      tab("c1", "alice", T1, 1_000),
      tab("c2", "alice", CANVAS, 1_000),
    ]);
    const backwards = locateEveryone([
      tab("c2", "alice", CANVAS, 1_000),
      tab("c1", "alice", T1, 1_000),
    ]);
    expect(forwards[0]?.clientId).toBe(backwards[0]?.clientId);
  });
});

describe("locatedTabs", () => {
  it("answers once per LOCATED TAB, so a person's tabs union rather than compete", () => {
    expect(
      locatedTabs([tab("c1", "alice", T1, 1_000), tab("c2", "alice", T2, 2_000)]),
    ).toEqual([
      { clientId: "c1", name: "alice", path: T1, title: null },
      { clientId: "c2", name: "alice", path: T2, title: null },
    ]);
  });

  it("leaves out a tab with no location", () => {
    // Present, location unknown. It is a face in the strip; it is not evidence
    // that anybody is reading anything.
    expect(locatedTabs([tab("c1", "alice", null, null), tab("c2", "bob", T1, 5)])).toEqual([
      { clientId: "c2", name: "bob", path: T1, title: null },
    ]);
  });

  it("is sorted by name then clientId, so a diff of it is stable", () => {
    expect(
      locatedTabs([
        tab("c9", "bob", T1, 1),
        tab("c2", "alice", T2, 2),
        tab("c1", "alice", T1, 3),
      ]).map((entry) => entry.clientId),
    ).toEqual(["c1", "c2", "c9"]);
  });
});

describe("the thread rows, fed from the union", () => {
  const viewers = (roster: readonly DockRosterEntry[]) =>
    locatedTabs(roster).map((entry) => ({
      name: entry.name,
      location: parseLocation(entry.path),
    }));
  // Nobody is `you` in these cases: they are about the union, not the labelling.
  const rows = (roster: readonly DockRosterEntry[]): string[] =>
    [...threadRowPresence(viewers(roster), null).keys()].sort();

  it("lights up EVERY thread a person has a tab on", () => {
    // One person, two threads, two decorations. Collapsing to one tab meant one of
    // those rows went dark for no reason a reader could see.
    expect(rows([tab("c1", "alice", T1, 1_000), tab("c2", "alice", T2, 900)])).toEqual([
      "t1",
      "t2",
    ]);
  });

  it("does not blink while a person's tabs take turns polling last", () => {
    // The live symptom: `data-dock-rows` flipping 1→0→1 nine times in 45s for
    // somebody who never left the thread.
    const seen = new Set(
      Array.from({ length: 8 }, (_, round) => rows(drifting(round)).join(",")),
    );
    expect([...seen]).toEqual(["t1"]);
  });

  it("still says one name once when that person has two tabs on one thread", () => {
    const roster = [tab("c1", "alice", T1, 1), tab("c2", "alice", T1, 2)];
    expect(threadRowPresence(viewers(roster), null).get("t1")?.label).toBe(
      "alice viewing",
    );
  });

  it("collapses YOUR two tabs on one thread to a single `you`", () => {
    // The union feeds every tab in, self included now — so the same dedup that
    // stops a teammate being named twice has to hold for `you`.
    const roster = [tab("c1", "alice", T1, 1), tab("c2", "alice", T1, 2)];
    expect(threadRowPresence(viewers(roster), "alice").get("t1")?.label).toBe(
      "you viewing",
    );
  });

  it("lights YOUR row and a shared row from the same union", () => {
    const roster = [
      tab("c1", "alice", T1, 1),
      tab("c2", "bob", T1, 2),
      tab("c3", "bob", T2, 3),
    ];
    const decorations = threadRowPresence(viewers(roster), "alice");
    expect(decorations.get("t1")?.label).toBe("you, bob viewing");
    expect(decorations.get("t2")?.label).toBe("bob viewing");
  });
});
