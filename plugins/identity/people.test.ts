import { describe, expect, it } from "vitest";
import { identityFor, parseDirectory, resolvePerson, type Person } from "./people.js";

const matt: Person = {
  person: "mattwynne",
  github: "mattwynne",
  displayName: "Matt",
  emails: ["Matt@Example.com", "matt@work.example"],
};
const david: Person = {
  person: "mrdavidlaing",
  github: "mrdavidlaing",
  displayName: "David",
  emails: ["david@example.com"],
};

describe("parseDirectory", () => {
  it("accepts an empty directory", () => {
    expect(parseDirectory("[]")).toEqual({ ok: true, people: [] });
  });

  it("treats blank text as an empty directory", () => {
    expect(parseDirectory("  \n")).toEqual({ ok: true, people: [] });
  });

  it("parses valid entries", () => {
    expect(parseDirectory(JSON.stringify([matt, david]))).toEqual({ ok: true, people: [matt, david] });
  });

  it("rejects malformed JSON", () => {
    const result = parseDirectory("[{");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/JSON/);
  });

  it("rejects a non-array", () => {
    expect(parseDirectory("{}").ok).toBe(false);
  });

  it.each([
    ["a bad person id", { ...matt, person: "Matt Wynne" }],
    ["an empty github", { ...matt, github: "" }],
    ["an empty displayName", { ...matt, displayName: "" }],
    ["no emails", { ...matt, emails: [] }],
    ["an invalid email", { ...matt, emails: ["not-an-email"] }],
    ["an unknown key", { ...matt, admin: true }],
  ])("rejects %s", (_label, entry) => {
    const result = parseDirectory(JSON.stringify([entry]));
    expect(result.ok).toBe(false);
  });

  it("rejects a duplicate person", () => {
    const result = parseDirectory(JSON.stringify([matt, { ...david, person: "mattwynne" }]));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/mattwynne/);
  });

  it("rejects the same email on two people, case-insensitively", () => {
    const result = parseDirectory(JSON.stringify([matt, { ...david, emails: ["MATT@example.com"] }]));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/matt@example\.com/);
  });
});

describe("resolvePerson", () => {
  it("matches emails case-insensitively and ignores surrounding space", () => {
    expect(resolvePerson([matt, david], " matt@EXAMPLE.com ")).toBe(matt);
    expect(resolvePerson([matt, david], "matt@work.example")).toBe(matt);
  });

  it("returns null for unknown or missing emails", () => {
    expect(resolvePerson([matt, david], "stranger@example.com")).toBeNull();
    expect(resolvePerson([matt, david], null)).toBeNull();
    expect(resolvePerson([matt, david], "")).toBeNull();
  });
});

describe("identityFor", () => {
  it("uses the request email when present", () => {
    expect(identityFor([matt, david], "david@example.com", "matt@example.com"))
      .toEqual({ email: "david@example.com", person: david, viaFallback: false });
  });

  it("reports an email not in the directory without a person", () => {
    expect(identityFor([matt], "stranger@example.com", ""))
      .toEqual({ email: "stranger@example.com", person: null, viaFallback: false });
  });

  it("falls back to fallbackEmail when the request has no email", () => {
    expect(identityFor([matt, david], null, " Matt@example.com "))
      .toEqual({ email: "matt@example.com", person: matt, viaFallback: true });
  });

  it("is anonymous with neither a request email nor a fallback", () => {
    expect(identityFor([matt], null, "")).toEqual({ email: null, person: null, viaFallback: false });
    expect(identityFor([matt], undefined, undefined)).toEqual({ email: null, person: null, viaFallback: false });
  });
});
