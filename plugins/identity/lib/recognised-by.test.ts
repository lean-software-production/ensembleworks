import { describe, expect, it } from "vitest";
import type { HostClassification } from "../hosts.js";
import type { RosterAnswer } from "../server.js";
import { recognisedBy } from "./recognised-by.js";

const alex: RosterAnswer["people"][number] = {
  person: "alex", displayName: "Alex Rivera", github: "alexr",
  emails: ["alex@example.test", "a.rivera@example.test"],
  color: "#3f7d33", dealt: "#3f7d33", overridden: false, ink: "#ffffff",
  machines: ["ew-lab-002-alex", "renamed-box"], seen: true, seenAt: 1, clashesWith: [],
};
const summary = { person: "alex", displayName: "Alex Rivera", github: "alexr" };
const machines: HostClassification[] = [
  { kind: "person", hostId: "h1", hostName: "ew-lab-002-alex", person: summary, conflict: null },
  { kind: "person", hostId: "h2", hostName: "renamed-box", person: summary, conflict: null },
  { kind: "person", hostId: "h3", hostName: "box-erin", conflict: null,
    person: { person: "erin", displayName: "Erin", github: "erin" } },
  { kind: "team", hostId: "h4", hostName: "ew-main", conflict: null },
  { kind: "unclaimed", hostId: "h5", hostName: "spare", conflict: null },
];

describe("recognisedBy", () => {
  it("lists every Access email as counting for attribution and the guardrail", () => {
    const rows = recognisedBy(alex, { machines: [], teamMachines: [], pickerOn: false });
    expect(rows).toEqual([
      { signal: "alex@example.test", from: "Access email", countsFor: "attribution and the guardrail" },
      { signal: "a.rivera@example.test", from: "Access email", countsFor: "attribution and the guardrail" },
    ]);
  });

  it("adds a browser-name row only when the picker is on", () => {
    const on = recognisedBy(alex, { machines: [], teamMachines: [], pickerOn: true });
    expect(on).toContainEqual({ signal: "Browser name", from: "This browser's picker", countsFor: "attribution only" });
    const off = recognisedBy(alex, { machines: [], teamMachines: [], pickerOn: false });
    expect(off.some((row) => row.signal === "Browser name")).toBe(false);
  });

  it("names this person's machines, telling a pin from a name suffix", () => {
    const rows = recognisedBy(alex, { machines, teamMachines: ["ew-main"], pickerOn: false });
    expect(rows.slice(2)).toEqual([
      { signal: "ew-lab-002-alex", from: "name suffix", countsFor: "machine owner (rule A)" },
      { signal: "renamed-box", from: "pin", countsFor: "machine owner (rule A)" },
    ]);
  });

  it("matches the suffix against the github handle too, case-insensitively", () => {
    const rows = recognisedBy({ ...alex, machines: ["Box-ALEXR"] }, {
      machines: [{ kind: "person", hostId: "h", hostName: "Box-ALEXR", person: summary, conflict: null }],
      teamMachines: [], pickerOn: false,
    });
    expect(rows.at(-1)).toEqual({ signal: "Box-ALEXR", from: "name suffix", countsFor: "machine owner (rule A)" });
  });

  it("never lists a team machine as a person's, even when it is named for them", () => {
    const rows = recognisedBy(alex, {
      machines: [{ kind: "person", hostId: "h", hostName: "ew-lab-002-alex", person: summary, conflict: null }],
      teamMachines: ["EW-LAB-002-ALEX"], pickerOn: false,
    });
    expect(rows.map((row) => row.signal)).toEqual(["alex@example.test", "a.rivera@example.test"]);
  });
});
