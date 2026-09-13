/**
 * DOT lexer: turns source text into a flat token stream. Purely lexical —
 * it does not know about DOT grammar (statements, defaults, etc.), only
 * about punctuation, quoted strings, comments and "bare words" (which
 * cover identifiers, keywords, numbers and duration literals like `20m`;
 * the parser and graph builder decide what a bare word means from context).
 *
 * Pure module: no BB imports, no I/O.
 */

export type TokenKind =
  | "LBRACE"
  | "RBRACE"
  | "LBRACKET"
  | "RBRACKET"
  | "COMMA"
  | "SEMI"
  | "EQUALS"
  | "ARROW"
  | "BARE"
  | "STRING"
  | "EOF";

export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  col: number;
}

export class DotLexError extends Error {}

const BARE_CHAR = /[A-Za-z0-9_.+]/;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  let line = 1;
  let col = 1;

  const advance = (count = 1): void => {
    for (let k = 0; k < count; k++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  const push = (kind: TokenKind, text: string, startLine: number, startCol: number): void => {
    tokens.push({ kind, text, line: startLine, col: startCol });
  };

  while (i < n) {
    const c = source[i];

    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance();
      continue;
    }

    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") advance();
      continue;
    }

    if (c === "/" && source[i + 1] === "*") {
      const startLine = line;
      const startCol = col;
      advance(2);
      let closed = false;
      while (i < n) {
        if (source[i] === "*" && source[i + 1] === "/") {
          advance(2);
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        throw new DotLexError(`unterminated block comment starting at line ${startLine}, col ${startCol}`);
      }
      continue;
    }

    const startLine = line;
    const startCol = col;

    if (c === "{") {
      push("LBRACE", c, startLine, startCol);
      advance();
      continue;
    }
    if (c === "}") {
      push("RBRACE", c, startLine, startCol);
      advance();
      continue;
    }
    if (c === "[") {
      push("LBRACKET", c, startLine, startCol);
      advance();
      continue;
    }
    if (c === "]") {
      push("RBRACKET", c, startLine, startCol);
      advance();
      continue;
    }
    if (c === ",") {
      push("COMMA", c, startLine, startCol);
      advance();
      continue;
    }
    if (c === ";") {
      push("SEMI", c, startLine, startCol);
      advance();
      continue;
    }
    if (c === "-" && source[i + 1] === ">") {
      push("ARROW", "->", startLine, startCol);
      advance(2);
      continue;
    }
    if (c === "=") {
      push("EQUALS", c, startLine, startCol);
      advance();
      continue;
    }

    if (c === '"') {
      advance();
      let value = "";
      let closed = false;
      while (i < n) {
        if (source[i] === '"') {
          advance();
          closed = true;
          break;
        }
        if (source[i] === "\\" && i + 1 < n) {
          const next = source[i + 1];
          if (next === "n") value += "\n";
          else if (next === "t") value += "\t";
          else if (next === '"') value += '"';
          else if (next === "\\") value += "\\";
          else value += next;
          advance(2);
        } else {
          value += source[i];
          advance();
        }
      }
      if (!closed) {
        throw new DotLexError(`unterminated string literal starting at line ${startLine}, col ${startCol}`);
      }
      push("STRING", value, startLine, startCol);
      continue;
    }

    if (BARE_CHAR.test(c)) {
      let text = "";
      while (i < n && BARE_CHAR.test(source[i])) {
        text += source[i];
        advance();
      }
      push("BARE", text, startLine, startCol);
      continue;
    }

    throw new DotLexError(`unexpected character '${c}' at line ${startLine}, col ${startCol}`);
  }

  tokens.push({ kind: "EOF", text: "", line, col });
  return tokens;
}
