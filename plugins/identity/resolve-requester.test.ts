import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { resolveRequester, type Person } from "./people.js";
import { mintSelection, verifySelection } from "./selection.js";

const people: Person[] = [
  { person: "matt", displayName: "Matt", github: "matt", emails: ["matt@example.test"] },
  { person: "david", displayName: "David", github: "david", emails: ["david@example.test"] },
];
const key = randomBytes(32);
const origin = "https://bb.example.test";
const token = mintSelection("matt", origin, key, 1000);
const verify = (value: string) => verifySelection(value, origin, key, 1001);
const resolve = (email: string | null, selection: string | null, directory = people) =>
  resolveRequester({ people: directory, email, selection, fallbackEmail: "david@example.test", verify });

describe("requester precedence", () => {
  it("upstream matched and unmatched headers always outrank a valid selection", () => {
    expect(resolve("david@example.test", token)).toMatchObject({ provenance: "upstream-header", person: { person: "david" } });
    expect(resolve("stranger@example.test", token)).toMatchObject({ provenance: "upstream-header", person: null });
  });
  it("valid selection outranks configured fallback", () => {
    expect(resolve(null, token)).toMatchObject({ provenance: "self-selected", person: { person: "matt" }, email: null });
  });
  it("stale and tampered selections fail open to unknown", () => {
    expect(resolve(null, token, people.slice(1))).toMatchObject({ provenance: "unknown", person: null,
      selection: { status: "stale" } });
    expect(resolve(null, token + "x")).toMatchObject({ provenance: "unknown", person: null,
      selection: { status: "invalid" } });
  });
  it("uses configured fallback only when no upstream or selection exists", () => {
    expect(resolve(null, null)).toMatchObject({ provenance: "configured-fallback", person: { person: "david" } });
  });
});
