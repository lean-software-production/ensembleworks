/**
 * DOT parser: token stream -> a small statement-list AST.
 *
 * Supported subset (see docs/plans/2026-09-13-attractor-runner-plan.md,
 * "Supported DOT dialect"): `digraph Name { … }` only (no `strict`, no
 * plain `graph`). Semicolons optional. Statement kinds: `graph [..]`,
 * `node [..]` and `edge [..]` defaults, node statements, edge chains
 * `a -> b -> c [..]`, and `subgraph` blocks (used only to scope `node [..]`
 * defaults — clusters carry no other semantics here).
 *
 * Pure module: no BB imports, no I/O.
 */

import { tokenize, type Token, type TokenKind } from "./lexer";

export type RawValue = { kind: "string"; text: string } | { kind: "bare"; text: string };

export interface DotAttr {
  key: string;
  value: RawValue;
}

export type DotStatement =
  | { kind: "attrDefault"; target: "graph" | "node" | "edge"; attrs: DotAttr[] }
  | { kind: "node"; id: string; attrs: DotAttr[] }
  | { kind: "edge"; chain: string[]; attrs: DotAttr[] }
  | { kind: "subgraph"; name?: string; statements: DotStatement[] };

export interface DotGraphAst {
  name: string;
  statements: DotStatement[];
}

export class DotParseError extends Error {}

const DEFAULT_TARGETS = new Set(["graph", "node", "edge"]);

class Parser {
  private tokens: Token[];
  private idx = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.idx + offset, this.tokens.length - 1)];
  }

  private advance(): Token {
    return this.tokens[this.idx++];
  }

  private fail(message: string, tok: Token = this.peek()): never {
    throw new DotParseError(`${message} (line ${tok.line}, col ${tok.col})`);
  }

  private expect(kind: TokenKind, context: string): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      this.fail(
        `expected ${kind} while parsing ${context}, found ${tok.kind === "EOF" ? "end of input" : `'${tok.text}'`}`,
      );
    }
    return this.advance();
  }

  private isBareCI(tok: Token, text: string): boolean {
    return tok.kind === "BARE" && tok.text.toLowerCase() === text;
  }

  parse(): DotGraphAst {
    const first = this.peek();
    if (this.isBareCI(first, "strict")) {
      this.fail("'strict' graphs are not supported; only 'digraph Name { ... }' is");
    }
    if (this.isBareCI(first, "graph")) {
      this.fail("undirected 'graph' is not supported; only 'digraph Name { ... }' is");
    }
    if (!this.isBareCI(first, "digraph")) {
      this.fail(`expected 'digraph', found '${first.text || "end of input"}'`);
    }
    this.advance();

    const nameTok = this.peek();
    if (nameTok.kind !== "BARE" && nameTok.kind !== "STRING") {
      this.fail("expected a graph name after 'digraph'");
    }
    this.advance();

    this.expect("LBRACE", "graph body");
    const statements = this.parseStatementList();
    this.expect("RBRACE", "graph body");
    this.expect("EOF", "end of file");

    return { name: nameTok.text, statements };
  }

  private parseStatementList(): DotStatement[] {
    const statements: DotStatement[] = [];
    while (this.peek().kind !== "RBRACE" && this.peek().kind !== "EOF") {
      statements.push(this.parseStatement());
      if (this.peek().kind === "SEMI") this.advance();
    }
    return statements;
  }

  private parseAttrList(): DotAttr[] {
    const attrs: DotAttr[] = [];
    while (this.peek().kind === "LBRACKET") {
      this.advance();
      while (this.peek().kind !== "RBRACKET") {
        if (this.peek().kind === "EOF") {
          this.fail("unterminated attribute list, expected ']'");
        }
        const keyTok = this.peek();
        if (keyTok.kind !== "BARE" && keyTok.kind !== "STRING") {
          this.fail("expected an attribute name");
        }
        this.advance();
        this.expect("EQUALS", `attribute '${keyTok.text}'`);
        const valueTok = this.peek();
        if (valueTok.kind !== "BARE" && valueTok.kind !== "STRING") {
          this.fail(`expected a value for attribute '${keyTok.text}'`);
        }
        this.advance();
        attrs.push({
          key: keyTok.text,
          value: valueTok.kind === "STRING" ? { kind: "string", text: valueTok.text } : { kind: "bare", text: valueTok.text },
        });
        if (this.peek().kind === "COMMA" || this.peek().kind === "SEMI") this.advance();
      }
      this.advance(); // consume ']'
    }
    return attrs;
  }

  private parseStatement(): DotStatement {
    const tok = this.peek();

    if (this.isBareCI(tok, "subgraph")) {
      this.advance();
      let name: string | undefined;
      const next = this.peek();
      if (next.kind === "BARE" || next.kind === "STRING") {
        name = next.text;
        this.advance();
      }
      this.expect("LBRACE", "subgraph body");
      const statements = this.parseStatementList();
      this.expect("RBRACE", "subgraph body");
      return { kind: "subgraph", name, statements };
    }

    if (tok.kind === "BARE" && DEFAULT_TARGETS.has(tok.text.toLowerCase()) && this.peek(1).kind === "LBRACKET") {
      this.advance();
      const attrs = this.parseAttrList();
      return { kind: "attrDefault", target: tok.text.toLowerCase() as "graph" | "node" | "edge", attrs };
    }

    if (tok.kind === "BARE" || tok.kind === "STRING") {
      const chain: string[] = [tok.text];
      this.advance();
      while (this.peek().kind === "ARROW") {
        this.advance();
        const next = this.peek();
        if (next.kind !== "BARE" && next.kind !== "STRING") {
          this.fail("expected a node id after '->'");
        }
        chain.push(next.text);
        this.advance();
      }
      const attrs = this.parseAttrList();
      if (chain.length === 1) {
        return { kind: "node", id: chain[0], attrs };
      }
      return { kind: "edge", chain, attrs };
    }

    this.fail(`unexpected token '${tok.text || "end of input"}' while parsing a statement`);
  }
}

export function parseDot(source: string): DotGraphAst {
  return new Parser(source).parse();
}
