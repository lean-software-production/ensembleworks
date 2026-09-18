import { describe, expect, it } from "vitest";
import { SittingRoster, initialsOf, MAX_PARTICIPANTS } from "../src/presence/roster.js";

function rosterAt(start = 1_000_000) {
  let clock = start;
  const roster = new SittingRoster("sitting-1", () => clock);
  return {
    roster,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
      return clock;
    },
  };
}

describe("sitting roster", () => {
  it("is unknown until it observes something, and never claims to be complete", () => {
    const { roster, now } = rosterAt();
    roster.setAvailability("live", now());
    expect(roster.completeness).toBe("unknown");
    expect(roster.participants(now())).toEqual([]);

    roster.apply({ kind: "joined", participantId: "16778240", name: "Ada", at: now() });
    // "partial" is the strongest word available on purpose: we only see arrivals
    // from the moment we connect, so a count is a floor and never a population.
    expect(roster.completeness).toBe("partial");
  });

  it("keeps the same display name for two people apart by identity, not by name", () => {
    const { roster, now } = rosterAt();
    roster.setAvailability("live", now());
    roster.apply({ kind: "joined", participantId: "16778240", name: "Alex", at: now() });
    roster.apply({ kind: "joined", participantId: "16791552", name: "Alex", at: now() + 1 });

    const people = roster.participants(now());
    expect(people.map((person) => person.label)).toEqual(["Alex (1)", "Alex (2)"]);
    expect(new Set(people.map((person) => person.id)).size).toBe(2);
  });

  it("scopes ids to the sitting, so one source id in two sittings is two people", () => {
    const first = new SittingRoster("conversation-a", () => 1);
    const second = new SittingRoster("conversation-b", () => 1);
    first.setAvailability("live", 1);
    second.setAvailability("live", 1);
    first.apply({ kind: "joined", participantId: "16778240", name: "Ada", at: 1 });
    second.apply({ kind: "joined", participantId: "16778240", name: "Sam", at: 1 });

    expect(first.participants(1)[0]!.id).not.toBe(second.participants(1)[0]!.id);
  });

  it("lets an active-speaker ring expire instead of glowing indefinitely", () => {
    const { roster, now, advance } = rosterAt();
    roster.setAvailability("live", now());
    roster.apply({ kind: "speaking", participantId: "1", name: "Ada", at: now() });
    expect(roster.participants(now())[0]!.speaking).toBe(true);

    advance(2_999);
    expect(roster.participants(now())[0]!.speaking).toBe(true);
    advance(2);
    // One event says "became the active speaker at T", which is not evidence of
    // speech a minute later.
    expect(roster.participants(now())[0]!.speaking).toBe(false);
    expect(roster.participants(now())[0]!.lastSpokeAt).toBe(1_000_000);
  });

  it("gives the ring to one person at a time", () => {
    const { roster, now, advance } = rosterAt();
    roster.setAvailability("live", now());
    roster.apply({ kind: "speaking", participantId: "1", name: "Ada", at: now() });
    advance(500);
    roster.apply({ kind: "speaking", participantId: "2", name: "Sam", at: now() });

    const speaking = roster.participants(now()).filter((person) => person.speaking);
    expect(speaking.map((person) => person.label)).toEqual(["Sam"]);
  });

  it("records a speaker it never saw join rather than dropping the observation", () => {
    const { roster, now } = rosterAt();
    roster.setAvailability("live", now());
    roster.apply({ kind: "speaking", participantId: "42", name: "Unseen", at: now() });

    expect(roster.participants(now()).map((person) => person.label)).toEqual(["Unseen"]);
    expect(roster.completeness).toBe("partial");
  });

  it("hides everybody while the signal is down, and clears the ring with it", () => {
    const { roster, now } = rosterAt();
    roster.setAvailability("live", now());
    roster.apply({ kind: "speaking", participantId: "1", name: "Ada", at: now() });

    roster.setAvailability("interrupted", now());
    // Not a frozen roster under a "reconnecting" banner: the people we last saw
    // are not evidence about the room now.
    expect(roster.participants(now())).toEqual([]);
    expect(roster.completeness).toBe("unknown");

    roster.setAvailability("live", now());
    expect(roster.participants(now())).toEqual([]);
    expect(roster.completeness).toBe("unknown");
  });

  it("does not resurrect the previous session's people after a reconnect", () => {
    const { roster, now, advance } = rosterAt();
    roster.setAvailability("live", now());
    roster.apply({ kind: "joined", participantId: "1", name: "Ada", at: now() });
    roster.setAvailability("interrupted", advance(10));
    roster.setAvailability("live", advance(10));
    roster.apply({ kind: "joined", participantId: "2", name: "Sam", at: now() });

    expect(roster.participants(now()).map((person) => person.label)).toEqual(["Sam"]);
  });

  it("ignores observations that arrive while the signal is not live", () => {
    const { roster, now } = rosterAt();
    roster.setAvailability("interrupted", now());
    roster.apply({ kind: "joined", participantId: "1", name: "Ghost", at: now() });
    roster.setAvailability("live", now());

    expect(roster.participants(now())).toEqual([]);
  });

  it("removes a participant who leaves", () => {
    const { roster, now } = rosterAt();
    roster.setAvailability("live", now());
    roster.apply({ kind: "joined", participantId: "1", name: "Ada", at: now() });
    roster.apply({ kind: "joined", participantId: "2", name: "Sam", at: now() });
    roster.apply({ kind: "left", participantId: "1", at: now() });

    expect(roster.participants(now()).map((person) => person.label)).toEqual(["Sam"]);
  });

  it("takes a mid-meeting rename without changing who somebody is", () => {
    const { roster, now } = rosterAt();
    roster.setAvailability("live", now());
    roster.apply({ kind: "joined", participantId: "1", name: "Ada", at: now() });
    const before = roster.participants(now())[0]!.id;
    roster.apply({ kind: "speaking", participantId: "1", name: "Ada Lovelace", at: now() });

    expect(roster.participants(now())[0]!.label).toBe("Ada Lovelace");
    expect(roster.participants(now())[0]!.id).toBe(before);
  });

  it("never invents a mute state from silence", () => {
    const { roster, now } = rosterAt();
    roster.setAvailability("live", now());
    roster.apply({ kind: "joined", participantId: "1", name: "Ada", at: now() });

    // Camera is "unknown" until something tells us, and there is no mute field
    // at all: we are never told one, so we never show one.
    expect(roster.participants(now())[0]!.camera).toBe("unknown");
    expect(Object.keys(roster.participants(now())[0]!)).not.toContain("muted");
  });

  it("bounds one sitting, and labels the unnamed without pretending they are one person", () => {
    const { roster, now } = rosterAt();
    roster.setAvailability("live", now());
    for (let index = 0; index < MAX_PARTICIPANTS + 5; index += 1) {
      roster.apply({ kind: "joined", participantId: `p-${index}`, name: null, at: now() + index });
    }
    const people = roster.participants(now());
    expect(people).toHaveLength(MAX_PARTICIPANTS);
    expect(people[0]!.label).toBe("Unnamed participant (1)");
    expect(people[1]!.label).toBe("Unnamed participant (2)");
    expect(people[0]!.initials).toBe("?");
  });
});

describe("initials", () => {
  it("reads a name the way a face has room for", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("Ada")).toBe("AD");
    expect(initialsOf("  spaced   out name ")).toBe("SN");
    expect(initialsOf(null)).toBe("?");
    expect(initialsOf("김")).toBe("김");
  });
});
