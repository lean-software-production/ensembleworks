import { describe, expect, it } from "vitest";
import { parseDot } from "../dot/parser";

describe("dot/parser", () => {
  it("requires a digraph header", () => {
    expect(() => parseDot("graph G { }")).toThrow(/digraph/i);
    expect(() => parseDot("strict digraph G { }")).toThrow(/digraph/i);
  });

  it("parses an empty digraph", () => {
    const ast = parseDot("digraph Empty { }");
    expect(ast.name).toBe("Empty");
    expect(ast.statements).toEqual([]);
  });

  it("parses a quoted graph name", () => {
    const ast = parseDot('digraph "My Graph" { }');
    expect(ast.name).toBe("My Graph");
  });

  it("parses node statements with attribute lists", () => {
    const ast = parseDot('digraph G { start [shape=Mdiamond, label="Start"] }');
    expect(ast.statements).toEqual([
      {
        kind: "node",
        id: "start",
        attrs: [
          { key: "shape", value: { kind: "bare", text: "Mdiamond" } },
          { key: "label", value: { kind: "string", text: "Start" } },
        ],
      },
    ]);
  });

  it("parses graph/node/edge default statements", () => {
    const ast = parseDot('digraph G { graph [goal="g"] node [timeout="20m"] edge [weight=1] }');
    expect(ast.statements).toEqual([
      { kind: "attrDefault", target: "graph", attrs: [{ key: "goal", value: { kind: "string", text: "g" } }] },
      { kind: "attrDefault", target: "node", attrs: [{ key: "timeout", value: { kind: "string", text: "20m" } }] },
      { kind: "attrDefault", target: "edge", attrs: [{ key: "weight", value: { kind: "bare", text: "1" } }] },
    ]);
  });

  it("parses an edge chain into a single edge statement with the full chain", () => {
    const ast = parseDot('digraph G { a -> b -> c [label="x"] }');
    expect(ast.statements).toEqual([
      { kind: "edge", chain: ["a", "b", "c"], attrs: [{ key: "label", value: { kind: "string", text: "x" } }] },
    ]);
  });

  it("supports semicolons as optional statement terminators", () => {
    const ast = parseDot("digraph G { a; b -> c; }");
    expect(ast.statements).toEqual([
      { kind: "node", id: "a", attrs: [] },
      { kind: "edge", chain: ["b", "c"], attrs: [] },
    ]);
  });

  it("parses subgraph blocks used to scope node[] defaults", () => {
    const ast = parseDot("digraph G { subgraph cluster0 { node [shape=box] a } b }");
    expect(ast.statements).toEqual([
      {
        kind: "subgraph",
        name: "cluster0",
        statements: [
          { kind: "attrDefault", target: "node", attrs: [{ key: "shape", value: { kind: "bare", text: "box" } }] },
          { kind: "node", id: "a", attrs: [] },
        ],
      },
      { kind: "node", id: "b", attrs: [] },
    ]);
  });

  it("supports multiple bracket groups on one statement", () => {
    const ast = parseDot("digraph G { a [x=1] [y=2] }");
    expect(ast.statements).toEqual([
      {
        kind: "node",
        id: "a",
        attrs: [
          { key: "x", value: { kind: "bare", text: "1" } },
          { key: "y", value: { kind: "bare", text: "2" } },
        ],
      },
    ]);
  });

  it("throws a helpful error on malformed input", () => {
    expect(() => parseDot("digraph G { a -> }")).toThrow();
    expect(() => parseDot("digraph G { a [shape= }")).toThrow();
    expect(() => parseDot("digraph G {")).toThrow();
  });
});
