// Run: npx vitest run tests/source-guard.test.ts
//
// THE TWO TOOLS THE WIRING GUARDS ARE BUILT ON, AND WHY THEY NEEDED ONE.
//
// This project has no jsdom, so the only honest thing a test can say about
// CanvasPanel.tsx is "it calls the decision, it does not re-make it" — a
// source-text assertion. That assertion is worth exactly as much as its
// ability to FAIL, and the first version of it could not: a guard reading the
// panel as one flat string was satisfied by the panel's own DOC COMMENT
// describing the call it was meant to pin, so deleting the real call left the
// suite green. (Found by review on 2026-09-05: mutating
// `resolvePageId(peer.doc, pageIdFromSubPath(subPathRef.current))` down to
// `resolvePageId(peer.doc)` — which deletes cold-load deep linking outright —
// was reported as 751 passed.)
//
// So a guard must read CODE, not prose. `stripComments` is that, and it is
// tested here rather than trusted, because a stripper that quietly returned
// its input unchanged would restore the exact hole it exists to close.
//
// `callArguments` is the second tool, for the second version of the same
// hole: reading the whole file cannot say WHERE a value is passed. Mutation
// on 2026-09-05 emptied the `apply` port and blanked three arguments at the
// panel's two new call sites, one at a time — each left `npx tsc --noEmit` at
// exit 0 and the suite at 39 files / 868 tests passed while deleting a whole
// shipped behaviour. The guards that now catch those are bounded to one
// call's own argument list, which is what this second tool is for.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  arrowResult,
  callArguments,
  handlerStatements,
  rootCallee,
  stripComments,
  ternaryArms,
} from "./lib/source.js";

const PANEL = readFileSync(
  new URL("../canvas/CanvasPanel.tsx", import.meta.url),
  "utf8",
);

describe("stripComments", () => {
  it("removes a line comment", () => {
    expect(stripComments("const a = 1; // note\n")).not.toContain("note");
  });

  it("removes a block comment, including a doc comment", () => {
    expect(stripComments("/** doc */\nconst a = 1;\n")).not.toContain("doc");
  });

  it("keeps the code that surrounded the comments", () => {
    const code = stripComments("/** doc */\nconst a = 1; // note\nconst b = 2;\n");
    expect(code).toContain("const a = 1;");
    expect(code).toContain("const b = 2;");
  });

  it("does not mistake a comment marker inside a string for a comment", () => {
    // THE CLASSIC REGEX STRIPPER BUG. A naive /\/\/.*$/ eats the rest of any
    // line holding a URL, which would silently delete real code from the
    // middle of the file being guarded — and a guard that has lost the line
    // it was checking reports a false failure, or worse, a false pass on the
    // next assertion. Hence a real TypeScript scan rather than a regex.
    const code = stripComments('const url = "https://example.test/a"; const b = 2;\n');
    expect(code).toContain('"https://example.test/a"');
    expect(code).toContain("const b = 2;");
  });

  it("does not mistake a comment marker inside a template literal for a comment", () => {
    const code = stripComments("const t = `a // b`; const c = 3;\n");
    expect(code).toContain("a // b");
    expect(code).toContain("const c = 3;");
  });

  it("handles TSX, which is what it is actually pointed at", () => {
    const code = stripComments(
      "const el = <div>{/* hidden */}<span>shown</span></div>;\n",
    );
    expect(code).not.toContain("hidden");
    expect(code).toContain("shown");
  });

  it("strips the panel's own header prose but keeps its calls", () => {
    // The end-to-end proof against the real file: the header comment names
    // `resolvePageId(peer.doc, pageIdFromSubPath(` verbatim (that is the
    // sentence that made the original guard unfalsifiable), and the code
    // makes the call. After stripping there must be exactly ONE occurrence —
    // the call.
    const panel = stripComments(PANEL);
    const hits = panel.match(/resolvePageId\(peer\.doc/g) ?? [];
    expect(hits).toHaveLength(1);
  });
});

describe("callArguments", () => {
  // The second guard tool, and it is tested here beside the stripper for the
  // same reason: every wiring guard bounded to a call site is only as honest
  // as this scan. A helper that quietly returned the whole file would make all
  // of them pass on text from somewhere else — which is precisely the hole
  // stripComments was built to close, wearing a different hat.
  //
  // It moved here from tests/page-presence.test.ts when the route and title
  // call sites needed it too; three copies of a guard tool is three places for
  // the guarantee to drift.
  it("returns only the arguments of the named call", () => {
    expect(callArguments("const r = f(a, b);\nconst z = g(c);\n", "f")).toBe("a, b");
  });

  it("does not stop at a nested call's closing paren", () => {
    expect(callArguments("f(a, g(b), c);", "f")).toBe("a, g(b), c");
  });

  it("keeps a nested arrow's own parentheses, which is the real call it guards", () => {
    // `pageRouter.reconcile({ livePageIds: snapshot.pages.map((page) => page.id) }, ...)`
    // — an arrow inside an argument inside a call, the exact shape in
    // CanvasPanel.tsx. A scan that ended at the first `)` would return a
    // truncated span and the guard built on it would fail for the wrong reason.
    expect(callArguments("f(xs.map((x) => x.id), y);", "f")).toBe("xs.map((x) => x.id), y");
  });

  it("finds a method call, not just a bare identifier", () => {
    // The two call sites this exists for are `pageRouter.reconcile(` and
    // `pageTitle.sync(` — dotted names, matched as plain text.
    expect(callArguments("obj.method(a);", "obj.method")).toBe("a");
  });

  it("throws rather than guessing when the call is never closed", () => {
    expect(() => callArguments("f(a, b", "f")).toThrow();
  });

  it("throws rather than returning nothing when the call is absent", () => {
    // A guard whose call site has been RENAMED must fail loudly. Returning ""
    // here would turn every `toContain` built on it into a silent pass on the
    // empty string... and a `not.toContain` into a silent pass on anything.
    expect(() => callArguments("g(a);", "f")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// THE FOUR STRUCTURAL TOOLS ADDED 2026-09-07, tested here for the reason the
// header gives: a helper that quietly returned the whole file, or an empty
// list, or the decoy's own body, would make every guard built on it pass on
// text from somewhere else — the exact hole `stripComments` exists to close,
// wearing a fourth hat. Each `it` below is one of the mutations that walked
// past the launch-or-attach guards while the suite reported 1183/1183 and tsc
// reported 0.

describe("ternaryArms", () => {
  it("splits a conditional initializer into its three parts", () => {
    const arms = ternaryArms('const picker = a !== "b" ? null : make(x);', "picker");
    expect(arms.condition).toBe('a !== "b"');
    expect(arms.whenTrue).toBe("null");
    expect(arms.whenFalse).toBe("make(x)");
  });

  it("reports the arm as it is WRITTEN, so a dead wrapper is visible", () => {
    // The recorded mutation: the open arm builds the portal and throws it away.
    // A helper that reached inside for the `createPortal` call would report the
    // same answer for both, which is exactly the failure it must not have.
    const arms = ternaryArms(
      "const picker = closed ? null : (() => { const built = make(x); void built; return null; })();",
      "picker",
    );
    expect(arms.whenFalse).not.toBe("make(x)");
    expect(arms.whenFalse.startsWith("(()")).toBe(true);
  });

  it("throws when the named initializer is not a ternary at all", () => {
    // Loud, not empty: a reshaped declaration must fail the guard rather than
    // silently guard nothing.
    expect(() => ternaryArms("const picker = make(x);", "picker")).toThrow();
    expect(() => ternaryArms('const other = a ? b : c;', "picker")).toThrow();
  });
});

describe("handlerStatements", () => {
  it("lists the statements a JSX handler runs, in order", () => {
    expect(handlerStatements("() => { first(); second(); }")).toEqual([
      "first();",
      "second();",
    ]);
  });

  it("does NOT descend into a decoy closure that holds the real work", () => {
    // `onClick={() => { const act = () => { …real work… }; void act; }}` — the
    // attribute still contains every asserted substring and the button does
    // nothing. A helper that recursed into `act` would report the real work and
    // the guard would stay green.
    const statements = handlerStatements(
      "() => { const act = (): void => { first(); second(); }; void act; }",
    );
    expect(statements).toHaveLength(2);
    expect(statements[1]).toBe("void act;");
    expect(statements).not.toContain("first();");
  });

  it("keeps a legitimate nested arrow inside its own statement", () => {
    // A handler that maps or subscribes is normal; only the OUTERMOST function
    // is the handler, and its statement text carries the nested one whole.
    expect(handlerStatements("() => { xs.forEach((x) => { use(x); }); }")).toEqual([
      "xs.forEach((x) => { use(x); });",
    ]);
  });

  it("throws on a concise-bodied handler, which has no statements to list", () => {
    expect(() => handlerStatements("() => attach(option)")).toThrow();
  });
});

describe("arrowResult", () => {
  it("returns a concise arrow's body", () => {
    expect(arrowResult("useCallback(() => rpc.call(a).then(f), [])")).toBe(
      "rpc.call(a).then(f)",
    );
  });

  it("returns what a block-bodied arrow actually RETURNS", () => {
    // The recorded mutation returns `Promise.resolve([])` after computing the
    // real chain into a dead local. Reporting the real chain here would make
    // the guard green on a picker that never issues its rpc.
    expect(
      arrowResult(
        "useCallback(() => { const real = () => rpc.call(a); void real; return Promise.resolve([]); }, [])",
      ),
    ).toBe("Promise.resolve([])");
  });

  it("throws when the body does not end in a return, because there is no answer", () => {
    expect(() => arrowResult("useCallback(() => { rpc.call(a); }, [])")).toThrow();
  });
});

describe("rootCallee", () => {
  it("names the call a promise chain is rooted at, not its last link", () => {
    expect(rootCallee("rpc.current.call(a, b).then(f).catch(g);")).toBe("rpc.current.call");
  });

  it("survives a chain the formatter broke across lines", () => {
    // The real statement in CanvasPanel.tsx is wrapped, so the callee's own
    // text contains a newline and an indent.
    expect(rootCallee("rpc.current\n  .call(a, b)\n  .then(f);")).toBe("rpc.current.call");
  });

  it("throws when the statement is not a call — which is the whole point", () => {
    // `void ((): void => { <the real statement> });` keeps the enclosing
    // function's statement list at length one and keeps every substring of the
    // real call inside it. Only asking what the expression IS fails on that.
    expect(() => rootCallee("void ((): void => { rpc.current.call(a, b); });")).toThrow();
    expect(() => rootCallee("const x = rpc.current.call(a);")).toThrow();
  });
});
