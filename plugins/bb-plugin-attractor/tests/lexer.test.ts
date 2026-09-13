import { describe, expect, it } from "vitest";
import { tokenize } from "../dot/lexer";

function kinds(source: string): string[] {
  return tokenize(source).map((t) => t.kind);
}

describe("dot/lexer", () => {
  it("tokenizes punctuation", () => {
    expect(kinds("{ } [ ] , ; = ->")).toEqual([
      "LBRACE",
      "RBRACE",
      "LBRACKET",
      "RBRACKET",
      "COMMA",
      "SEMI",
      "EQUALS",
      "ARROW",
      "EOF",
    ]);
  });

  it("tokenizes bare words (identifiers, numbers, durations)", () => {
    const tokens = tokenize("start Mdiamond 3 3.5 20m 250ms true false");
    expect(tokens.map((t) => t.kind)).toEqual([
      "BARE",
      "BARE",
      "BARE",
      "BARE",
      "BARE",
      "BARE",
      "BARE",
      "BARE",
      "EOF",
    ]);
    expect(tokens.map((t) => t.text)).toEqual([
      "start",
      "Mdiamond",
      "3",
      "3.5",
      "20m",
      "250ms",
      "true",
      "false",
      "",
    ]);
  });

  it("tokenizes quoted strings with escapes", () => {
    const tokens = tokenize(String.raw`"hello \"world\"\n\t\\end"`);
    expect(tokens[0]).toMatchObject({ kind: "STRING", text: 'hello "world"\n\t\\end' });
  });

  it("skips // line comments and /* */ block comments", () => {
    const tokens = tokenize("a // comment\nb /* block\ncomment */ c");
    expect(tokens.map((t) => t.kind)).toEqual(["BARE", "BARE", "BARE", "EOF"]);
    expect(tokens.map((t) => t.text)).toEqual(["a", "b", "c", ""]);
  });

  it("throws on an unterminated string", () => {
    expect(() => tokenize('"unterminated')).toThrow();
  });

  it("throws on an unexpected character", () => {
    expect(() => tokenize("a $ b")).toThrow();
  });

  it("tracks line and column numbers", () => {
    const tokens = tokenize("a\nb");
    expect(tokens[0]).toMatchObject({ line: 1 });
    expect(tokens[1]).toMatchObject({ line: 2 });
  });

  it("tokenizes hyphenated bare words as a single BARE token", () => {
    const tokens = tokenize("model=claude-sonnet-5");
    expect(tokens.map((t) => t.kind)).toEqual(["BARE", "EQUALS", "BARE", "EOF"]);
    expect(tokens[2]).toMatchObject({ kind: "BARE", text: "claude-sonnet-5" });
  });

  it("tokenizes a negative bare number", () => {
    const tokens = tokenize("weight=-1");
    expect(tokens.map((t) => t.kind)).toEqual(["BARE", "EQUALS", "BARE", "EOF"]);
    expect(tokens[2]).toMatchObject({ kind: "BARE", text: "-1" });
  });

  it("still splits a hyphenated word immediately followed by -> into a BARE and an ARROW", () => {
    const tokens = tokenize("foo-bar->baz");
    expect(tokens.map((t) => t.kind)).toEqual(["BARE", "ARROW", "BARE", "EOF"]);
    expect(tokens[0]).toMatchObject({ text: "foo-bar" });
    expect(tokens[2]).toMatchObject({ text: "baz" });
  });
});
