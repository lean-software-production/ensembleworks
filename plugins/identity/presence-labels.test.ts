import { describe, expect, it } from "vitest";
import { initials, joinNames, presenceLabel } from "./presence-labels.js";

const person = (displayName: string, typing = false) => ({
  person: displayName.toLowerCase(),
  displayName,
  github: displayName.toLowerCase(),
  typing,
});

describe("joinNames", () => {
  it("joins names and a count of anonymous others", () => {
    expect(joinNames(["Matt"], 0)).toBe("Matt");
    expect(joinNames(["Matt", "Trevoke"], 0)).toBe("Matt and Trevoke");
    expect(joinNames(["Matt", "Trevoke"], 1)).toBe("Matt, Trevoke and 1 other");
    expect(joinNames(["Jeremy", "Matt", "Trevoke"], 2)).toBe("Jeremy, Matt, Trevoke and 2 others");
    expect(joinNames([], 2)).toBe("2 others");
  });
});

describe("presenceLabel", () => {
  it("keeps the anonymous wording when nobody is named", () => {
    expect(presenceLabel({ viewers: 1, typing: 0, people: [] })).toBe("1 other viewer");
    expect(presenceLabel({ viewers: 2, typing: 1, people: [] })).toBe("2 other viewers · 1 typing");
  });

  it("names the people here", () => {
    expect(presenceLabel({ viewers: 1, typing: 0, people: [person("Matt")] })).toBe("Matt is here");
    expect(presenceLabel({ viewers: 2, typing: 0, people: [person("Matt"), person("Trevoke")] }))
      .toBe("Matt and Trevoke here");
    expect(presenceLabel({ viewers: 3, typing: 0, people: [person("Matt"), person("Trevoke")] }))
      .toBe("Matt, Trevoke and 1 other here");
  });

  it("names who is typing", () => {
    expect(presenceLabel({ viewers: 2, typing: 1, people: [person("Matt", true), person("Trevoke")] }))
      .toBe("Matt is typing");
    expect(presenceLabel({ viewers: 3, typing: 2, people: [person("Matt", true), person("Trevoke", true)] }))
      .toBe("Matt and Trevoke are typing");
    expect(presenceLabel({ viewers: 3, typing: 2, people: [person("Matt", true)] }))
      .toBe("Matt and 1 other are typing");
  });
});

describe("initials", () => {
  it("takes up to two initials", () => {
    expect(initials("Matt")).toBe("M");
    expect(initials("David Laing")).toBe("DL");
    expect(initials("  ")).toBe("?");
  });
});
