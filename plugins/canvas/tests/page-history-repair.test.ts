// Run: npx vitest run tests/page-history-repair.test.ts
//
// TASK C1b — the undo/redo clamp (docs/plans/2026-09-05-bb-canvas-multi-page-
// design.md, R-1). The design doc calls this "the highest-risk item in the
// whole feature": get it wrong and undo silently blanks the canvas, because
// canvas-react's ShapeLayer/EmbedLayer paint only shapes whose page IS
// currentPageId, so a currentPageId naming a page that no longer exists paints
// NOTHING while the doc is perfectly intact.
//
// BOTH FAILURES BELOW WERE OBSERVED, NOT REASONED. Written first against the
// path CanvasPanel.tsx ran before this file existed — `editor.undo()` followed
// by `pruneDanglingSelectionIntents` alone — where they failed with:
//   expected [ 'page:p' ] to include 'page:89oqgw'
//   expected [ 'page:a' ] to include 'page:b'
// i.e. currentPageId naming a page the doc no longer has, in the undo
// direction AND in the redo direction. The redo one is worth stating plainly
// because it is not the obvious one: a redo strands the page only when the
// user has SWITCHED PAGES since the undo (a SetCurrentPage is a view intent
// and does not clear the redo stack), which is exactly the case a fix written
// for the undo direction alone would miss.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { Editor } from "@ensembleworks/canvas-editor";
import type { Page, Shape } from "@ensembleworks/canvas-model";
import { deletePageIntents, newPageIntents } from "../canvas/pages/page-intents.js";
import {
  historyRepairIntents,
  redoWithRepair,
  undoWithRepair,
} from "../canvas/pages/history-repair.js";
import { countInCode, stripComments } from "./lib/source.js";

function makeEditor(pages: readonly Page[], currentPageId: string) {
  const doc = LoroCanvasDoc.create({ peerId: 1n });
  for (const p of pages) doc.putPage(p);
  doc.commit();
  const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: currentPageId });
  return { doc, editor };
}

const livePageIds = (editor: Editor) => editor.doc.listPages().map((p) => p.id);

/** A minimal valid geo shape parented onto `parentId`. */
function shape(id: `shape:${string}`, parentId: `shape:${string}` | `page:${string}`): Shape {
  return {
    id,
    kind: "geo",
    parentId,
    index: "a0",
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { w: 10, h: 10 },
  };
}

// THESE TESTS USED TO DRIVE A COPY OF THE PANEL, WHICH IS WHY THE PANEL WENT
// UNGUARDED. Until 2026-09-05 this file defined its own `undoLikeThePanel` /
// `redoLikeThePanel` helpers — three lines each, hand-written to match what
// CanvasPanel.tsx's two branches did, with a comment saying exactly that. A
// replica cannot notice the original changing: deleting the repair from the
// redo branch, and separately from the undo branch, each left `npx tsc
// --noEmit` at exit 0 and the suite at 39 files / 843 tests passed. The
// composition is now `undoWithRepair` / `redoWithRepair` in the module, so the
// calls below are the panel's own calls, and the guards at the foot of this
// file pin that the panel makes no history move around them.

describe("historyRepairIntents — the page half", () => {
  it("re-homes currentPageId after undoing a '+ new page'", () => {
    const { editor } = makeEditor([{ id: "page:p", name: "P", index: "a0" }], "page:p");
    editor.applyAll(newPageIntents(editor));
    const created = editor.get().currentPageId;
    expect(created).not.toBe("page:p");

    undoWithRepair(editor);

    expect(livePageIds(editor)).not.toContain(created);
    expect(livePageIds(editor)).toContain(editor.get().currentPageId);
    expect(editor.get().currentPageId).toBe("page:p");
  });

  it("re-homes currentPageId after redoing a DeletePage of the page the user switched back to", () => {
    const { editor } = makeEditor(
      [
        { id: "page:a", name: "A", index: "a0" },
        { id: "page:b", name: "B", index: "a1" },
      ],
      "page:a",
    );
    // Delete a page that is NOT current, so deletePageIntents emits no
    // SetCurrentPage of its own and the redo below is the only thing that can
    // strand the view.
    editor.applyAll(deletePageIntents(editor, "page:b"));
    editor.undo();
    editor.applyAll([{ type: "SetCurrentPage", pageId: "page:b" }]);

    redoWithRepair(editor);

    expect(livePageIds(editor)).not.toContain("page:b");
    expect(livePageIds(editor)).toContain(editor.get().currentPageId);
  });

  it("is silent when the undo touched no page at all", () => {
    const { editor } = makeEditor([{ id: "page:p", name: "P", index: "a0" }], "page:p");
    editor.applyAll([
      { type: "CreateShape", shape: shape("shape:s", "page:p") },
    ]);
    editor.undo();

    // No churn: the caller runs this after EVERY undo and redo, so a
    // same-value SetCurrentPage here would notify every subscriber on every
    // keystroke.
    expect(historyRepairIntents(editor)).toEqual([]);
  });
});

describe("historyRepairIntents — the selection half is still there", () => {
  it("prunes a selection whose shapes the undo removed", () => {
    const { editor } = makeEditor([{ id: "page:p", name: "P", index: "a0" }], "page:p");
    editor.applyAll([
      { type: "CreateShape", shape: shape("shape:s", "page:p") },
      { type: "SetSelection", ids: ["shape:s"] },
    ]);
    expect([...editor.get().selection]).toEqual(["shape:s"]);

    undoWithRepair(editor);

    // The whole point of folding the two repairs into one function: the panel
    // must not be able to keep one and forget the other.
    expect([...editor.get().selection]).toEqual([]);
  });

  it("emits both repairs together when an undo strands both", () => {
    const { editor } = makeEditor([{ id: "page:p", name: "P", index: "a0" }], "page:p");
    // One batch, so ONE undo entry: a new page, a shape on it, and a selection
    // naming that shape. Undoing it strands the selection AND the page.
    const create = newPageIntents(editor);
    const created = (create[0] as { type: "CreatePage"; page: Page }).page.id;
    editor.applyAll([
      ...create,
      { type: "CreateShape", shape: shape("shape:s", created) },
      { type: "SetSelection", ids: ["shape:s"] },
    ]);

    editor.undo();
    const repair = historyRepairIntents(editor);

    expect(repair.map((i) => i.type).sort()).toEqual(["SetCurrentPage", "SetSelection"]);
    editor.applyAll(repair);
    expect([...editor.get().selection]).toEqual([]);
    expect(livePageIds(editor)).toContain(editor.get().currentPageId);
  });
});

describe("undoWithRepair / redoWithRepair — the move and the repair are one call", () => {
  it("does not notify subscribers a second time when nothing dangled", () => {
    // The "apply only a non-empty repair" rule, stated as the thing it exists
    // to protect rather than as the shape of the code: `SetSelection` and
    // `SetCurrentPage` notify EVERY subscriber even when the value is
    // unchanged, and this runs on every undo keystroke. Measured against a
    // plain `editor.undo()` on an identically-prepared editor, so the
    // assertion does not depend on how many times an undo notifies by itself.
    const prepare = () => {
      const { editor } = makeEditor([{ id: "page:p", name: "P", index: "a0" }], "page:p");
      editor.applyAll([{ type: "CreateShape", shape: shape("shape:s", "page:p") }]);
      return editor;
    };

    const bare = prepare();
    let bareCount = 0;
    const stopBare = bare.subscribe(() => {
      bareCount += 1;
    });
    bare.undo();
    stopBare();

    const repaired = prepare();
    let repairedCount = 0;
    const stopRepaired = repaired.subscribe(() => {
      repairedCount += 1;
    });
    undoWithRepair(repaired);
    stopRepaired();

    expect(repairedCount).toBe(bareCount);
  });

  it("still moves history when there is a repair to apply", () => {
    // The other half of the same rule: the guard above would also pass for a
    // function that did nothing at all.
    const { editor } = makeEditor([{ id: "page:p", name: "P", index: "a0" }], "page:p");
    editor.applyAll(newPageIntents(editor));
    const created = editor.get().currentPageId;

    undoWithRepair(editor);

    expect(livePageIds(editor)).not.toContain(created);
    expect(editor.get().currentPageId).toBe("page:p");

    redoWithRepair(editor);

    expect(livePageIds(editor)).toContain(created);
    expect(livePageIds(editor)).toContain(editor.get().currentPageId);
  });
});

// ---------------------------------------------------------------------------
// THE PANEL WIRING. CanvasPanel.tsx is a .tsx and there is no jsdom here, so
// nothing behavioural can watch a keystroke run its branch. These read
// comment-stripped CODE for the reason tests/source-guard.test.ts documents.
//
// WHY THIS BLOCK EXISTS AT ALL. Verified by mutation on 2026-09-05, against the
// code as it stood before `undoWithRepair`/`redoWithRepair`: deleting
//
//     const repair = historyRepairIntents(editor);
//     if (repair.length > 0) editor.applyAll(repair);
//
// from the REDO branch, and separately from the UNDO branch, each left `npx tsc
// --noEmit` at exit 0 and the whole spike suite at 39 files / 843 tests passed.
// The failure that buys is the worst one this feature has: Ctrl+Z removes the
// page `currentPageId` still names, canvas-react's ShapeLayer/EmbedLayer paint
// only shapes on that page, and the canvas goes BLANK with the document
// perfectly intact.
//
// EACH BRANCH IS GUARDED INDEPENDENTLY, because a guard that passes while only
// one branch is wired is not a guard — that is precisely the pair of mutations
// above. Hence the branch bodies are located by their own conditions rather
// than the file being searched as a whole.
// ---------------------------------------------------------------------------

const PANEL = readFileSync(
  new URL("../canvas/panel/session-input.ts", import.meta.url),
  "utf8",
);
const PANEL_CODE = stripComments(PANEL);

/**
 * The shortcut branch whose condition contains `marker`, from the marker to
 * that branch's `return`.
 *
 * The marker is asserted UNIQUE in code, so a second occurrence (which would
 * make "the branch" ambiguous and this slice arbitrary) fails here rather than
 * quietly guarding the wrong lines.
 */
function shortcutBranch(marker: string): string {
  expect(countInCode(PANEL, marker), `\`${marker}\` no longer identifies one branch`).toBe(1);
  const at = PANEL_CODE.indexOf(marker);
  const end = PANEL_CODE.indexOf("return true;", at);
  expect(end, `no \`return true;\` after \`${marker}\``).toBeGreaterThan(at);
  return PANEL_CODE.slice(at, end);
}

describe("the panel repairs on both history branches", () => {
  it("makes no history move that skips the repair", () => {
    // WHAT THIS ACTUALLY REACHES, stated exactly — an earlier version of this
    // comment claimed there was "no branch, present or future" in which a
    // keystroke could move history without the repair, and review disproved
    // that absolute form on 2026-09-05: with the undo branch rewritten to
    // `const ed = editor; ed.undo();` plus a decoy string literal
    // `const _decoy = "undoWithRepair(editor)";` inside the same branch, the
    // panel moved history with no repair at all and `npx tsc --noEmit` was
    // exit 0 with 39 files / 875 tests passed. `editor.undo` alone does not
    // see through an alias.
    //
    // So the reach is now the pair below, and the pair is what the claim is
    // about: no MENTION of `editor.undo`/`editor.redo` (which catches taking
    // the method as a value: `const u = editor.undo`), and no member CALL
    // named `.undo(`/`.redo(` at all, through any receiver — which is what
    // catches the alias. The panel has no other legitimate `.undo(`/`.redo(`
    // to collide with: it drives history exclusively through the two helpers.
    //
    // NOT A PROOF, and the comment will not pretend otherwise: a local
    // shadow of the imported `undoWithRepair` name, or a method taken off an
    // alias (`const u = ed.undo`), still slips past all four assertions in
    // this file. Those are deliberate acts, not the plausible edit the
    // 2026-09-05 mutations were.
    expect(countInCode(PANEL, "editor.undo")).toBe(0);
    expect(countInCode(PANEL, "editor.redo")).toBe(0);
    expect(countInCode(PANEL, ".undo(")).toBe(0);
    expect(countInCode(PANEL, ".redo(")).toBe(0);
  });

  it("wires the undo branch to undoWithRepair", () => {
    // THE TRAILING SEMICOLON IS LOAD-BEARING: `stripComments` removes comments
    // but not string literals, so `const _decoy = "undoWithRepair(editor)";`
    // satisfies a bare `toContain("undoWithRepair(editor)")` — that decoy is
    // half of the mutation review used on 2026-09-05 to disprove the
    // absolute claim above. A string ends `)";`, a statement ends `);`.
    const branch = shortcutBranch("!event.modifiers.shift");
    expect(branch).toContain("undoWithRepair(editor);");
    // Not the other direction: a redo in the undo branch typechecks fine.
    expect(branch).not.toContain("redoWithRepair");
  });

  it("wires the redo branch to redoWithRepair", () => {
    // `key === "y"` is the Ctrl+Y clause, which only the redo branch has.
    const branch = shortcutBranch('key === "y"');
    expect(branch).toContain("redoWithRepair(editor);");
    expect(branch).not.toContain("undoWithRepair");
  });

  it("calls each of them exactly once", () => {
    // A branch guard reads a slice; two call sites for one direction would
    // mean a second, unguarded place where history moves. Counted as
    // statements (see the semicolon note above), so a decoy string cannot
    // top the count back up to 1 after the real call is deleted.
    expect(countInCode(PANEL, "undoWithRepair(editor);")).toBe(1);
    expect(countInCode(PANEL, "redoWithRepair(editor);")).toBe(1);
  });

  it("recomputes no repair of its own", () => {
    // HANDS, NOT POLICY. `historyRepairIntents` composed in the .tsx is what
    // the mutations deleted; a copy of it here would be a decision no test in
    // this jsdom-free project could reach.
    expect(countInCode(PANEL, "historyRepairIntents")).toBe(0);
  });
});
