// Run: npx vitest run tests/page-delete-confirm.test.ts
//
// Confirm-before-destructive is a BEHAVIOURAL POLICY, so it lives in a module
// a test can reach. It used to be an inline `if (!window.confirm(...)) return;`
// in canvas/pages/PageSwitcher.tsx's `remove` handler — the one place in that
// 585-line component where a decision sat in a .tsx with nothing able to check
// it, and a direct contradiction of that file's own header ("There is no
// threshold, no pixel comparison and no behavioural `if` below that is not a
// call into one of those").
//
// The extraction is not cosmetic. Writing the decision down forced the
// question the inline version never had to answer: `deletePageIntents` REFUSES
// the doc's only page (canvas/pages/page-intents.ts — `if (pages.length <= 1)
// return []`), so the old handler asked "Delete "X"? This deletes every shape
// on it." and then, whichever button the user pressed, did nothing at all. A
// modal whose two answers are indistinguishable is not a safety net; it is a
// lie about what is about to happen.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pageDeletePrompt } from "../canvas/pages/page-delete-confirm.js";
import { countInCode, stripComments } from "./lib/source.js";

const SWITCHER = readFileSync(
  new URL("../canvas/pages/switcher/actions.ts", import.meta.url),
  "utf8",
);

describe("pageDeletePrompt — whether to ask, and what to ask", () => {
  it("asks before a delete that will really happen", () => {
    const prompt = pageDeletePrompt("Sketches", true);
    expect(prompt.kind).toBe("ask");
  });

  it("names the page and says what is lost", () => {
    const prompt = pageDeletePrompt("Sketches", true);
    // The wording is carried over BYTE-IDENTICAL from the inline version this
    // module replaces; the extraction changes where the decision lives, not
    // what the user reads.
    expect(prompt.kind === "ask" && prompt.message).toBe(
      'Delete "Sketches"? This deletes every shape on it.',
    );
  });

  it("does not ask when the delete is a refusal — the doc's only page", () => {
    // `deletable: false` is the caller reporting that `deletePageIntents`
    // came back empty. There is nothing for the user to authorise, so there is
    // nothing to ask: both answers to that dialog led to the same nothing.
    expect(pageDeletePrompt("Canvas", false)).toEqual({ kind: "proceed" });
  });

  it("is a pure function of its two inputs", () => {
    // Same inputs, same answer — no clock, no doc read, no window.
    expect(pageDeletePrompt("A", true)).toEqual(pageDeletePrompt("A", true));
    expect(pageDeletePrompt("A", false)).toEqual(pageDeletePrompt("A", false));
  });

  it("carries an empty name through rather than inventing one", () => {
    // A page can be named "" (page-menu.ts's rename validation is what refuses
    // that on the WRITE path; this module is on the read path and must not
    // second-guess it). Stating the observed shape rather than asserting a
    // fallback nobody asked for.
    const prompt = pageDeletePrompt("", true);
    expect(prompt.kind === "ask" && prompt.message).toBe(
      'Delete ""? This deletes every shape on it.',
    );
  });
});

describe("PageSwitcher.tsx delegates the decision rather than making it", () => {
  // Source-text guards, for the reason tests/source-guard.test.ts's header
  // gives: no jsdom, so "the component calls the decision" is the strongest
  // honest statement available. Read through `countInCode`, never the raw
  // file — a guard satisfied by a doc comment is a guard that cannot fail
  // (that exact hole is what `stripComments` was built to close).

  it("still holds the window.confirm call itself — the hands stay in the .tsx", () => {
    expect(countInCode(SWITCHER, "window.confirm(")).toBe(1);
  });

  it("no longer spells the message out in code", () => {
    expect(countInCode(SWITCHER, "This deletes every shape on it")).toBe(0);
  });

  it("asks page-delete-confirm.ts what to do", () => {
    expect(countInCode(SWITCHER, "pageDeletePrompt(")).toBeGreaterThan(0);
  });
});

describe("the `deletable` the switcher actually feeds this module", () => {
  // WHY THIS BLOCK EXISTS. The three guards above pin that `pageDeletePrompt`
  // is CALLED and that the message no longer lives in the .tsx. Neither says
  // anything about what is handed to it — and `deletable` is the entire
  // difference between this module and the inline `if` it replaced. Found by
  // review on 2026-09-05: mutating the call to `pageDeletePrompt(row.name,
  // true)` restores the single-page bug described in this file's header (the
  // user is asked to authorise a delete that `deletePageIntents` has already
  // refused, and both answers do nothing) and the FULL suite stayed green,
  // 810/810. A guard for an extraction whose whole value is a behaviour change
  // has to die when that change is undone.
  //
  // Same shape and same justification as tests/page-tabs-fit.test.ts's "the
  // width the panel actually feeds this gate": no jsdom, so the argument at a
  // .tsx call site is reachable only as source text — and only as source text
  // read through `stripComments`, never raw, because this file's own header
  // spells out the call it is checking and would satisfy a raw-text guard on
  // its own.
  const CODE = stripComments(SWITCHER);
  const start = CODE.indexOf("const remove = useCallback(");
  // The handler runs to the start of the next `useCallback(`, which is `move`.
  // Slicing rather than parsing keeps this readable; if the component is
  // reshaped so the slice no longer holds the call, every assertion below
  // fails loudly rather than passing on an empty string.
  const after = CODE.slice(start + "const remove = useCallback(".length);
  const nextHandler = after.indexOf("useCallback(");
  const REMOVE = nextHandler === -1 ? after : after.slice(0, nextHandler);

  it("has a `remove` handler to read at all", () => {
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it("asks the doc what would happen before it asks the user", () => {
    // Order is load-bearing, not stylistic: `deletable` cannot be computed
    // after the dialog has already been put up. `deletePageIntents` is a pure
    // read of doc state (page-intents.ts), so running it first costs nothing
    // and mutates nothing.
    const intentsAt = REMOVE.indexOf("deletePageIntents(");
    const promptAt = REMOVE.indexOf("pageDeletePrompt(");
    const confirmAt = REMOVE.indexOf("window.confirm(");
    expect(intentsAt).toBeGreaterThanOrEqual(0);
    expect(promptAt).toBeGreaterThan(intentsAt);
    expect(confirmAt).toBeGreaterThan(promptAt);
  });

  it("passes the emptiness of those very intents, not a constant", () => {
    const bound = /const ([A-Za-z0-9_]+) = deletePageIntents\(/.exec(REMOVE);
    expect(bound).not.toBeNull();
    const name = bound?.[1] ?? "";
    const arg = /pageDeletePrompt\([^,)]+,\s*([^)]*)\)/.exec(REMOVE)?.[1]?.trim();
    // Stated twice on purpose, because the two failures read very differently
    // in a report. The first says "somebody substituted a literal", which is
    // the mutation that survived; the second pins the exact expression, so a
    // rewrite to something merely plausible — `>= 0`, say, which is true for
    // every list — also has to come through here.
    expect(arg).not.toBe("true");
    expect(arg).not.toBe("false");
    expect(arg).toBe(`${name}.length > 0`);
  });

  it("applies those same intents rather than re-deriving them", () => {
    // If the handler asked the doc a second time after the dialog, the list it
    // applied would no longer be the list the user was shown a message about.
    const name = /const ([A-Za-z0-9_]+) = deletePageIntents\(/.exec(REMOVE)?.[1] ?? "";
    expect(REMOVE).toContain(`editor.applyAll(${name})`);
    const reads = REMOVE.match(/deletePageIntents\(/g) ?? [];
    expect(reads).toHaveLength(1);
  });
});
