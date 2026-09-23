import { describe, expect, it } from "vitest";
import { buildRoster, seenPhrase, SEEN_UNKNOWN_CAVEAT } from "./roster.js";
import { colorChangeAuditLine } from "./audit.js";
import { personColor } from "./ownership-labels.js";
import { DARK_INK, LIGHT_INK, parseCssColor } from "./person-colors.js";
import type { Person } from "./people.js";
import type { HostClassification } from "./hosts.js";

const alice: Person = {
  person: "alice", github: "AliceH", displayName: "Alice", emails: ["alice@example.com", "a@ex.com"],
};
const bob: Person = { person: "bob", github: "bobby", displayName: "Bob", emails: ["bob@example.com"] };
const people = [alice, bob];

function personHost(id: string, name: string, who: Person): HostClassification {
  return {
    kind: "person",
    hostId: id,
    hostName: name,
    person: { person: who.person, displayName: who.displayName, github: who.github },
    conflict: null,
  };
}

const machines: HostClassification[] = [
  personHost("h1", "ew-lsp-001-alice", alice),
  personHost("h2", "ew-lap-002-alice", alice),
  personHost("h3", "ew-lsp-001-bobby", bob),
  { kind: "team", hostId: "h4", hostName: "ew-lsp-001-main", conflict: null },
  { kind: "unclaimed", hostId: "h5", hostName: "some-box", conflict: null },
];

describe("buildRoster", () => {
  const base = { people, overrides: {}, machines, seen: {} };

  it("lists everyone in the directory, in directory order", () => {
    expect(buildRoster(base).map((row) => row.person)).toEqual(["alice", "bob"]);
  });

  it("carries the identity fields the page shows", () => {
    const [row] = buildRoster(base);
    expect(row).toMatchObject({
      person: "alice",
      displayName: "Alice",
      github: "AliceH",
      emails: ["alice@example.com", "a@ex.com"],
    });
  });

  it("deals a colour when nobody has chosen one", () => {
    const [row] = buildRoster(base);
    expect(row!.color).toBe(personColor("alice", ["alice", "bob"]));
    expect(row!.dealt).toBe(row!.color);
    expect(row!.overridden).toBe(false);
  });

  it("deals from the WHOLE directory, so a colour does not depend on who is listed first", () => {
    const reversed = buildRoster({ ...base, people: [bob, alice] });
    expect(reversed.find((row) => row.person === "alice")!.color)
      .toBe(buildRoster(base).find((row) => row.person === "alice")!.color);
  });

  it("uses a chosen colour over the dealt one, and still reports the dealt one", () => {
    const [row] = buildRoster({ ...base, overrides: { alice: "#ff0000" } });
    expect(row!.color).toBe("#ff0000");
    expect(row!.overridden).toBe(true);
    expect(row!.dealt).toBe(personColor("alice", ["alice", "bob"]));
  });

  it("carries the ink that stays legible on whatever colour is in force", () => {
    expect(buildRoster({ ...base, overrides: { alice: "#000080" } })[0]!.ink).toBe(LIGHT_INK);
    expect(buildRoster({ ...base, overrides: { alice: "#ffff99" } })[0]!.ink).toBe(DARK_INK);
  });

  it("lists a person's own machines, and nobody else's", () => {
    const rows = buildRoster(base);
    expect(rows[0]!.machines).toEqual(["ew-lsp-001-alice", "ew-lap-002-alice"]);
    expect(rows[1]!.machines).toEqual(["ew-lsp-001-bobby"]);
  });

  it("never counts the team or an unclaimed machine as anyone's", () => {
    expect(buildRoster(base).flatMap((row) => row.machines)).not.toContain("ew-lsp-001-main");
    expect(buildRoster(base).flatMap((row) => row.machines)).not.toContain("some-box");
  });

  it("reports whether Identity has seen a person", () => {
    const rows = buildRoster({ ...base, seen: { alice: 1_700_000_000_000 } });
    expect(rows[0]).toMatchObject({ seen: true, seenAt: 1_700_000_000_000 });
    expect(rows[1]).toMatchObject({ seen: false, seenAt: null });
  });

  describe("clash warnings", () => {
    it("says nothing when the colours are far apart", () => {
      expect(buildRoster(base).map((row) => row.clashesWith)).toEqual([[], []]);
    });

    it("warns BOTH people when two colours read the same", () => {
      const rows = buildRoster({ ...base, overrides: { alice: "#336699", bob: "#34679a" } });
      expect(rows[0]!.clashesWith).toEqual(["Bob"]);
      expect(rows[1]!.clashesWith).toEqual(["Alice"]);
    });

    it("warns when a CHOSEN colour collides with somebody's DEALT one", () => {
      // A chosen colour is always hex, so the realistic collision is someone picking the
      // hex equivalent of another person's dealt hsl — which means the clash check has to
      // compare across the two formats, not just within one.
      const bobsDealt = parseCssColor(personColor("bob", ["alice", "bob"]))!;
      const asHex = `#${[bobsDealt.r, bobsDealt.g, bobsDealt.b]
        .map((value) => value.toString(16).padStart(2, "0")).join("")}`;
      const rows = buildRoster({ ...base, overrides: { alice: asHex } });
      expect(rows[0]!.clashesWith).toEqual(["Bob"]);
      expect(rows[1]!.clashesWith).toEqual(["Alice"]);
    });

    it("warns, it does not refuse — the clashing colour is still the one in force", () => {
      const rows = buildRoster({ ...base, overrides: { alice: "#336699", bob: "#34679a" } });
      expect(rows[0]!.color).toBe("#336699");
      expect(rows[1]!.color).toBe("#34679a");
    });

    it("never says a person clashes with themselves", () => {
      expect(buildRoster({ ...base, people: [alice] })[0]!.clashesWith).toEqual([]);
    });
  });

  it("survives a directory with nobody in it", () => {
    expect(buildRoster({ ...base, people: [] })).toEqual([]);
  });
});

describe("seenPhrase", () => {
  it("says plainly what a sighting does and does not mean", () => {
    expect(seenPhrase(true)).toMatch(/seen/i);
    expect(seenPhrase(false)).toMatch(/not seen/i);
  });

  it("never claims a person has NEVER used this server — Identity cannot know that", () => {
    const caveat = `${seenPhrase(false)} ${SEEN_UNKNOWN_CAVEAT}`;
    expect(caveat).not.toMatch(/\bnever\b/i);
    // It must name the limit instead: retained records, and "since Identity started".
    expect(SEEN_UNKNOWN_CAVEAT).toMatch(/retain/i);
  });
});

describe("colorChangeAuditLine", () => {
  const line = colorChangeAuditLine({
    at: 1_700_000_000_000,
    requestId: "req1",
    requestMethod: "POST",
    requestPath: "/api/v1/plugins/identity/rpc/identity_set_person_color",
    mode: "off",
    by: { person: "bob", displayName: "Bob", github: "bobby" },
    byEmail: "bob@example.com",
    subject: "alice",
    from: "#111111",
    to: "#222222",
  });

  it("follows the audit schema the other streams use", () => {
    expect(line.v).toBe(2);
    expect(line.kind).toBe("person.color");
    expect(line.at).toBe(1_700_000_000_000);
    expect(line.req).toBe("req1");
  });

  it("names who changed WHOSE colour, from and to — the whole point of logging it", () => {
    expect(line).toMatchObject({
      by: "bob",
      email: "bob@example.com",
      subject: "alice",
      from: "#111111",
      to: "#222222",
    });
  });

  it("records a clear as a change to no colour, not as a missing field", () => {
    const cleared = colorChangeAuditLine({
      at: 1, requestId: null, requestMethod: null, requestPath: null, mode: "off",
      by: null, byEmail: null, subject: "alice", from: "#111111", to: null,
    });
    expect(cleared.to).toBeNull();
    expect(cleared.by).toBeNull();
  });
});
