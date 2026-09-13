import { describe, expect, it } from "vitest";
import { evaluateCondition, parseCondition, tryParseCondition, type ConditionContext } from "../dot/conditions";

function ctx(partial: Partial<ConditionContext>): ConditionContext {
  return { outcome: "succeeded", preferredLabel: undefined, context: {}, ...partial };
}

function ev(expr: string, context: ConditionContext): boolean {
  return evaluateCondition(parseCondition(expr), context);
}

describe("conditions grammar: table test (>= 25 expressions)", () => {
  const cases: Array<[string, ConditionContext, boolean]> = [
    // bare key truthiness
    ["outcome", ctx({ outcome: "succeeded" }), true],
    ["outcome", ctx({ outcome: "failed" }), true], // non-empty string is truthy regardless of value
    ["context.missing", ctx({}), false],
    ["context.flag", ctx({ context: { flag: true } }), true],
    ["context.flag", ctx({ context: { flag: false } }), false],
    ["context.count", ctx({ context: { count: 0 } }), false],
    ["context.count", ctx({ context: { count: 1 } }), true],
    ["context.text", ctx({ context: { text: "" } }), false],
    ["context.text", ctx({ context: { text: "false" } }), false],
    ["context.text", ctx({ context: { text: "0" } }), false],
    ["context.text", ctx({ context: { text: "hi" } }), true],
    ["response.plan", ctx({ context: { response: { plan: "done" } } }), true],
    ["response.plan", ctx({ context: { response: {} } }), false],

    // equality / inequality
    ['outcome=succeeded', ctx({ outcome: "succeeded" }), true],
    ['outcome=failed', ctx({ outcome: "succeeded" }), false],
    ['outcome!=failed', ctx({ outcome: "succeeded" }), true],
    ['preferred_label=Accept', ctx({ preferredLabel: "Accept" }), true],
    ['preferred_label="Accept"', ctx({ preferredLabel: "Accept" }), true],
    ['preferred_label=Repair', ctx({ preferredLabel: "Accept" }), false],

    // numeric comparisons (numeric when both parse as numbers)
    ["context.n>5", ctx({ context: { n: 10 } }), true],
    ["context.n>5", ctx({ context: { n: 3 } }), false],
    ["context.n>=10", ctx({ context: { n: 10 } }), true],
    ["context.n<=9", ctx({ context: { n: 10 } }), false],
    ["context.n<20", ctx({ context: { n: 10 } }), true],
    // lexical fallback when not both numeric
    ["context.v>abc", ctx({ context: { v: "abd" } }), true],
    ["context.v>abc", ctx({ context: { v: "abb" } }), false],

    // contains
    ['context.text contains "ell"', ctx({ context: { text: "hello" } }), true],
    ['context.text contains "zzz"', ctx({ context: { text: "hello" } }), false],
    ["context.list contains a", ctx({ context: { list: ["a", "b"] } }), true],
    ["context.list contains z", ctx({ context: { list: ["a", "b"] } }), false],

    // matches
    ["context.text matches \"^h.*o$\"", ctx({ context: { text: "hello" } }), true],
    ["context.text matches \"^z\"", ctx({ context: { text: "hello" } }), false],

    // boolean composition
    ["outcome=succeeded && context.flag", ctx({ outcome: "succeeded", context: { flag: true } }), true],
    ["outcome=succeeded && context.flag", ctx({ outcome: "succeeded", context: { flag: false } }), false],
    ["outcome=failed || context.flag", ctx({ outcome: "succeeded", context: { flag: true } }), true],
    ["outcome=failed || context.flag", ctx({ outcome: "succeeded", context: { flag: false } }), false],
    ["!context.flag", ctx({ context: { flag: false } }), true],
    ["!context.flag", ctx({ context: { flag: true } }), false],
    ["!(outcome=failed)", ctx({ outcome: "succeeded" }), true],
    [
      "outcome=succeeded && (context.a || context.b)",
      ctx({ outcome: "succeeded", context: { a: false, b: true } }),
      true,
    ],
    [
      "outcome=succeeded && (context.a || context.b)",
      ctx({ outcome: "succeeded", context: { a: false, b: false } }),
      false,
    ],
    // && binds tighter than ||
    ["context.a || context.b && context.c", ctx({ context: { a: false, b: true, c: false } }), false],
    ["context.a || context.b && context.c", ctx({ context: { a: true, b: false, c: false } }), true],
  ];

  it.each(cases)("%s -> %j", (expr, context, expected) => {
    expect(ev(expr, context)).toBe(expected);
  });

  it("has at least 25 table cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });
});

describe("parseCondition error handling", () => {
  it("throws on malformed expressions", () => {
    expect(() => parseCondition("outcome=")).toThrow();
    expect(() => parseCondition("&&")).toThrow();
    expect(() => parseCondition("outcome==succeeded")).toThrow();
    expect(() => parseCondition("(outcome=succeeded")).toThrow();
  });

  it("tryParseCondition returns ok:false with a message instead of throwing", () => {
    const result = tryParseCondition("outcome=");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
    }
  });

  it("tryParseCondition returns ok:true for valid expressions", () => {
    const result = tryParseCondition("outcome=succeeded");
    expect(result.ok).toBe(true);
  });

  it("rejects a matches clause whose regex is syntactically invalid, at parse time", () => {
    expect(() => parseCondition('context.x matches "["')).toThrow();
    const result = tryParseCondition('context.x matches "["');
    expect(result.ok).toBe(false);
  });

  it("accepts a matches clause with a valid regex", () => {
    expect(() => parseCondition('context.x matches "^h.*o$"')).not.toThrow();
  });
});

describe("condition context path lookup does not leak the JS prototype chain", () => {
  it("does not treat inherited Object.prototype members as present context keys", () => {
    expect(ev("context.constructor", ctx({ context: {} }))).toBe(false);
    expect(ev("context.toString", ctx({ context: {} }))).toBe(false);
    expect(ev("context.hasOwnProperty", ctx({ context: {} }))).toBe(false);
  });

  it("still resolves a genuine own-property path", () => {
    expect(ev("context.plan", ctx({ context: { plan: "x" } }))).toBe(true);
  });
});
