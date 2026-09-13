import { describe, expect, it } from "vitest";
import { parseStylesheet, resolveStyle } from "../dot/stylesheet";

describe("parseStylesheet", () => {
  it("parses selectors and properties", () => {
    const rules = parseStylesheet(
      '* { model: claude-sonnet-5; } #review { model: claude-opus-5; reasoning_effort: high; }',
    );
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ selectorType: "*", specificity: 0, props: { model: "claude-sonnet-5" } });
    expect(rules[1]).toMatchObject({
      selectorType: "id",
      selectorValue: "review",
      specificity: 3,
      props: { model: "claude-opus-5", reasoningEffort: "high" },
    });
  });

  it("parses shape and class selectors with correct specificity", () => {
    const rules = parseStylesheet("box { model: a; } .expensive { model: b; }");
    expect(rules[0]).toMatchObject({ selectorType: "shape", selectorValue: "box", specificity: 1 });
    expect(rules[1]).toMatchObject({ selectorType: "class", selectorValue: "expensive", specificity: 2 });
  });

  it("tolerates missing trailing semicolon on the last declaration", () => {
    const rules = parseStylesheet("* { model: claude-sonnet-5 }");
    expect(rules[0].props.model).toBe("claude-sonnet-5");
  });

  it("throws on malformed stylesheet text", () => {
    expect(() => parseStylesheet("* { model claude-sonnet-5 }")).toThrow();
    expect(() => parseStylesheet("* { model: claude-sonnet-5;")).toThrow();
  });

  it("returns an empty rule list for an empty/undefined stylesheet", () => {
    expect(parseStylesheet("")).toEqual([]);
  });
});

describe("resolveStyle", () => {
  const rules = parseStylesheet(
    '* { model: claude-sonnet-5; } #review { model: claude-opus-5; reasoning_effort: high; }',
  );

  it("applies the universal selector by default", () => {
    const style = resolveStyle({ id: "plan", shape: "box", classes: [] }, rules);
    expect(style).toEqual({ model: "claude-sonnet-5" });
  });

  it("lets a higher-specificity #id selector override the universal one", () => {
    const style = resolveStyle({ id: "review", shape: "box", classes: [] }, rules);
    expect(style).toEqual({ model: "claude-opus-5", reasoningEffort: "high" });
  });

  it("breaks ties between same-specificity selectors using source order (last wins)", () => {
    const tieRules = parseStylesheet("box { model: a; } box { model: b; }");
    const style = resolveStyle({ id: "n1", shape: "box", classes: [] }, tieRules);
    expect(style.model).toBe("b");
  });

  it("orders class over shape and id over class", () => {
    const cascade = parseStylesheet(
      "box { model: shape-model; } .fast { model: class-model; } #n1 { model: id-model; }",
    );
    expect(resolveStyle({ id: "n1", shape: "box", classes: ["fast"] }, cascade).model).toBe("id-model");
    expect(resolveStyle({ id: "n2", shape: "box", classes: ["fast"] }, cascade).model).toBe("class-model");
    expect(resolveStyle({ id: "n3", shape: "box", classes: [] }, cascade).model).toBe("shape-model");
  });

  it("lets explicit node attributes override any stylesheet-resolved value", () => {
    const style = resolveStyle({ id: "review", shape: "box", classes: [] }, rules, { model: "explicit-model" });
    expect(style.model).toBe("explicit-model");
    expect(style.reasoningEffort).toBe("high");
  });

  it("returns an empty style when nothing matches and there is no explicit override", () => {
    const style = resolveStyle({ id: "n9", shape: "hexagon", classes: [] }, []);
    expect(style).toEqual({});
  });
});
