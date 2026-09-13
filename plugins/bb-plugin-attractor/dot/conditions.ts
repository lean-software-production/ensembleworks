/**
 * Attractor edge-condition grammar, per docs/plans/2026-09-13-attractor-runner-plan.md
 * "Condition grammar (exact)":
 *
 *   Expr     ::= Or
 *   Or       ::= And ('||' And)*
 *   And      ::= Unary ('&&' Unary)*
 *   Unary    ::= '!' Unary | Clause
 *   Clause   ::= Key Op Value | Key
 *   Op       ::= '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'matches'
 *   Key      ::= 'outcome' | 'preferred_label' | 'context.' Path | Path
 *   Value    ::= BareWord | '"' QuotedString '"'
 *
 * This module is pure: no BB imports, no I/O, no randomness.
 */

export type OutcomeStatus = "succeeded" | "failed" | "partially_succeeded" | "skipped";

export interface ConditionContext {
  outcome: OutcomeStatus;
  preferredLabel?: string;
  /** Arbitrary run context, addressed by dot-path (e.g. "response.plan"). */
  context: Record<string, unknown>;
}

export type ConditionOp = "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "matches";

export type ConditionNode =
  | { kind: "or"; left: ConditionNode; right: ConditionNode }
  | { kind: "and"; left: ConditionNode; right: ConditionNode }
  | { kind: "not"; operand: ConditionNode }
  | { kind: "clause"; key: string; op: ConditionOp; value: string }
  | { kind: "truthy"; key: string };

class ConditionSyntaxError extends Error {}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type CondTokenKind =
  | "LPAREN"
  | "RPAREN"
  | "NOT"
  | "AND"
  | "OR"
  | "OP"
  | "WORD"
  | "STRING"
  | "EOF";

interface CondToken {
  kind: CondTokenKind;
  text: string;
  pos: number;
}

const MULTI_CHAR_OPS = ["!=", ">=", "<="] as const;
const SINGLE_CHAR_OPS = ["=", ">", "<"] as const;

function tokenize(source: string): CondToken[] {
  const tokens: CondToken[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "LPAREN", text: c, pos: i });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "RPAREN", text: c, pos: i });
      i++;
      continue;
    }
    if (c === "!" && source[i + 1] === "=") {
      tokens.push({ kind: "OP", text: "!=", pos: i });
      i += 2;
      continue;
    }
    if (c === "!") {
      tokens.push({ kind: "NOT", text: "!", pos: i });
      i++;
      continue;
    }
    if (c === "&" && source[i + 1] === "&") {
      tokens.push({ kind: "AND", text: "&&", pos: i });
      i += 2;
      continue;
    }
    if (c === "|" && source[i + 1] === "|") {
      tokens.push({ kind: "OR", text: "||", pos: i });
      i += 2;
      continue;
    }
    const two = source.slice(i, i + 2);
    if ((MULTI_CHAR_OPS as readonly string[]).includes(two)) {
      tokens.push({ kind: "OP", text: two, pos: i });
      i += 2;
      continue;
    }
    if ((SINGLE_CHAR_OPS as readonly string[]).includes(c)) {
      tokens.push({ kind: "OP", text: c, pos: i });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      while (j < n && source[j] !== '"') {
        if (source[j] === "\\" && j + 1 < n) {
          const next = source[j + 1];
          if (next === "n") value += "\n";
          else if (next === "t") value += "\t";
          else if (next === '"') value += '"';
          else if (next === "\\") value += "\\";
          else value += next;
          j += 2;
        } else {
          value += source[j];
          j++;
        }
      }
      if (j >= n) {
        throw new ConditionSyntaxError(`unterminated string literal at position ${i}`);
      }
      tokens.push({ kind: "STRING", text: value, pos: i });
      i = j + 1;
      continue;
    }
    // WORD: bare key/word/operator name (contains/matches), path segments, numbers, etc.
    if (/[A-Za-z0-9_.\-]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_.\-]/.test(source[j])) j++;
      const text = source.slice(i, j);
      if (text === "contains" || text === "matches") {
        tokens.push({ kind: "OP", text, pos: i });
      } else {
        tokens.push({ kind: "WORD", text, pos: i });
      }
      i = j;
      continue;
    }

    throw new ConditionSyntaxError(`unexpected character '${c}' at position ${i}`);
  }

  tokens.push({ kind: "EOF", text: "", pos: n });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

class ConditionParser {
  private tokens: CondToken[];
  private idx = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): CondToken {
    return this.tokens[this.idx];
  }

  private advance(): CondToken {
    return this.tokens[this.idx++];
  }

  private expect(kind: CondTokenKind): CondToken {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw new ConditionSyntaxError(
        `expected ${kind} but found ${tok.kind === "EOF" ? "end of expression" : `'${tok.text}'`} at position ${tok.pos}`,
      );
    }
    return this.advance();
  }

  parse(): ConditionNode {
    const node = this.parseOr();
    this.expect("EOF");
    return node;
  }

  private parseOr(): ConditionNode {
    let left = this.parseAnd();
    while (this.peek().kind === "OR") {
      this.advance();
      const right = this.parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  }

  private parseAnd(): ConditionNode {
    let left = this.parseUnary();
    while (this.peek().kind === "AND") {
      this.advance();
      const right = this.parseUnary();
      left = { kind: "and", left, right };
    }
    return left;
  }

  private parseUnary(): ConditionNode {
    if (this.peek().kind === "NOT") {
      this.advance();
      return { kind: "not", operand: this.parseUnary() };
    }
    if (this.peek().kind === "LPAREN") {
      this.advance();
      const inner = this.parseOr();
      this.expect("RPAREN");
      return inner;
    }
    return this.parseClause();
  }

  private parseClause(): ConditionNode {
    const keyTok = this.expect("WORD");
    // Allow "context." followed immediately by a path, e.g. "context.human.gate.selected".
    // The tokenizer already includes '.' in WORD, so "context.foo" arrives as one token.
    const key = keyTok.text;
    if (this.peek().kind !== "OP") {
      return { kind: "truthy", key };
    }
    const opTok = this.advance();
    const op = opTok.text as ConditionOp;
    const valueTok = this.peek();
    if (valueTok.kind !== "WORD" && valueTok.kind !== "STRING") {
      throw new ConditionSyntaxError(
        `expected a value after operator '${op}' at position ${valueTok.pos}`,
      );
    }
    this.advance();
    if (op === "matches") {
      // Validate the regex eagerly, at parse time, so a graph with a syntactically
      // valid condition but an invalid regex is caught by validate() (bad-condition)
      // instead of throwing an unhandled SyntaxError deep in evaluateCondition.
      try {
        void new RegExp(valueTok.text);
      } catch (err) {
        throw new ConditionSyntaxError(
          `invalid regular expression '${valueTok.text}' for 'matches' at position ${valueTok.pos}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { kind: "clause", key, op, value: valueTok.text };
  }
}

export function parseCondition(source: string): ConditionNode {
  if (source.trim() === "") {
    throw new ConditionSyntaxError("condition expression is empty");
  }
  return new ConditionParser(source).parse();
}

export type ParseConditionResult = { ok: true; node: ConditionNode } | { ok: false; error: string };

export function tryParseCondition(source: string): ParseConditionResult {
  try {
    return { ok: true, node: parseCondition(source) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function getPath(obj: unknown, path: string): unknown {
  const segments = path.split(".").filter((s) => s.length > 0);
  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    // Only resolve keys the context object actually owns: a plain index
    // lookup also resolves inherited Object.prototype members (constructor,
    // toString, hasOwnProperty, ...), which would make e.g.
    // "context.constructor" evaluate truthy even though no such context key
    // was ever set.
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveKey(key: string, ctx: ConditionContext): unknown {
  if (key === "outcome") return ctx.outcome;
  if (key === "preferred_label") return ctx.preferredLabel;
  if (key.startsWith("context.")) return getPath(ctx.context, key.slice("context.".length));
  return getPath(ctx.context, key);
}

function truthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  const s = String(value);
  return s !== "" && s !== "false" && s !== "0";
}

function toComparable(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function bothNumeric(a: unknown, b: unknown): [number, number] | null {
  const na = typeof a === "number" ? a : Number(toComparable(a));
  const nb = typeof b === "number" ? b : Number(toComparable(b));
  if (
    Number.isFinite(na) &&
    Number.isFinite(nb) &&
    toComparable(a).trim() !== "" &&
    toComparable(b).trim() !== ""
  ) {
    return [na, nb];
  }
  return null;
}

function evaluateClause(key: string, op: ConditionOp, rawValue: string, ctx: ConditionContext): boolean {
  const left = resolveKey(key, ctx);

  if (op === "contains") {
    if (Array.isArray(left)) {
      return left.some((item) => toComparable(item) === rawValue);
    }
    return toComparable(left).includes(rawValue);
  }

  if (op === "matches") {
    return new RegExp(rawValue).test(toComparable(left));
  }

  const numeric = bothNumeric(left, rawValue);
  if (numeric) {
    const [ln, rn] = numeric;
    switch (op) {
      case "=":
        return ln === rn;
      case "!=":
        return ln !== rn;
      case ">":
        return ln > rn;
      case "<":
        return ln < rn;
      case ">=":
        return ln >= rn;
      case "<=":
        return ln <= rn;
      default:
        return false;
    }
  }

  const ls = toComparable(left);
  const rs = rawValue;
  switch (op) {
    case "=":
      return ls === rs;
    case "!=":
      return ls !== rs;
    case ">":
      return ls > rs;
    case "<":
      return ls < rs;
    case ">=":
      return ls >= rs;
    case "<=":
      return ls <= rs;
    default:
      return false;
  }
}

export function evaluateCondition(node: ConditionNode, ctx: ConditionContext): boolean {
  switch (node.kind) {
    case "or":
      return evaluateCondition(node.left, ctx) || evaluateCondition(node.right, ctx);
    case "and":
      return evaluateCondition(node.left, ctx) && evaluateCondition(node.right, ctx);
    case "not":
      return !evaluateCondition(node.operand, ctx);
    case "truthy":
      return truthy(resolveKey(node.key, ctx));
    case "clause":
      return evaluateClause(node.key, node.op, node.value, ctx);
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}
