// Run: npx vitest run tests/page-intents.test.ts
//
// THE PAGE-SWITCHER'S MATH, WITH NO SWITCHER IN SIGHT. Task 1 of
// docs/plans/2026-09-05-bb-canvas-multi-page-design.md ports
// client/src/canvas-v2/page-switcher-dom.ts into the spike. The port keeps
// upstream's shape deliberately: read the editor, return an Intent[], let the
// CALLER applyAll it. That is what makes these decisions reachable from a
// plain unit test — this project has no jsdom, so any branch that lived
// inline in CanvasPanel.tsx would be a branch no test could ever reach.
//
// A real LoroCanvasDoc + a real Editor, not fakes: the assertions that matter
// most here ("the new page sorts last", "moving left actually swaps") are
// about fractional-index ordering, and a fake doc would let a wrong index
// pass. `random` is injected and FIXED so the minted page id is deterministic
// and the id-minting path is provably fed from editor.random() rather than
// from crypto.
import { describe, expect, it } from "vitest";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { Editor } from "@ensembleworks/canvas-editor";
import { orderedPages, type Page } from "@ensembleworks/canvas-model";
import {
  clampCurrentPageIntents,
  deletePageIntents,
  dropPageIntents,
  movePageIntents,
  newPageIntents,
} from "../canvas/pages/page-intents.js";

const FIXED_RANDOM = () => 0.5;

/** A real doc seeded with `pages`, and a real Editor whose currentPageId is
 * `currentPageId` (EditorOpts.pageId is the seed for EditorState.currentPageId
 * — canvas-editor/src/editor.ts:184). */
function makeEditor(pages: readonly Page[], currentPageId: string) {
  const doc = LoroCanvasDoc.create({ peerId: 1n });
  for (const p of pages) doc.putPage(p);
  doc.commit();
  const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: currentPageId });
  return { doc, editor };
}

const THREE_PAGES: readonly Page[] = [
  { id: "page:p", name: "P", index: "a0" },
  { id: "page:q", name: "Q", index: "a1" },
  { id: "page:r", name: "R", index: "a2" },
];

const ids = (doc: LoroCanvasDoc) => orderedPages(doc.listPages()).map((p) => p.id);

describe("newPageIntents", () => {
  it("emits exactly [CreatePage, SetCurrentPage] targeting the new page", () => {
    const { editor } = makeEditor(THREE_PAGES, "page:p");
    const intents = newPageIntents(editor);

    expect(intents.map((i) => i.type)).toEqual(["CreatePage", "SetCurrentPage"]);
    const create = intents[0] as { type: "CreatePage"; page: Page };
    const setCurrent = intents[1] as { type: "SetCurrentPage"; pageId: string };
    expect(setCurrent.pageId).toBe(create.page.id);
    // Create-and-switch has to be ONE batch so it is ONE commit (and, since
    // SetCurrentPage contributes no inverse, one undo entry) — upstream D-6.
  });

  it("appends: the new page sorts after every existing page", () => {
    const { doc, editor } = makeEditor(THREE_PAGES, "page:p");
    const intents = newPageIntents(editor);
    const newId = (intents[0] as { page: Page }).page.id;

    editor.applyAll(intents);

    expect(ids(doc)).toEqual(["page:p", "page:q", "page:r", newId]);
    expect(editor.get().currentPageId).toBe(newId);
  });

  it("mints the page id from the injected random, not from crypto", () => {
    // Two independent editors, same injected random => same id. If the id
    // came from crypto.randomUUID (or Math.random) these would differ.
    const a = makeEditor(THREE_PAGES, "page:p");
    const b = makeEditor(THREE_PAGES, "page:p");

    const idA = (newPageIntents(a.editor)[0] as { page: Page }).page.id;
    const idB = (newPageIntents(b.editor)[0] as { page: Page }).page.id;

    expect(idA).toBe(idB);
    expect(idA.startsWith("page:")).toBe(true);
  });

  it("names the new page for its 1-based position", () => {
    const { editor } = makeEditor(THREE_PAGES, "page:p");
    const page = (newPageIntents(editor)[0] as { page: Page }).page;
    expect(page.name).toBe("Page 4");
  });
});

describe("deletePageIntents", () => {
  it("refuses the doc's only page", () => {
    const { editor } = makeEditor([{ id: "page:only", name: "Only", index: "a0" }], "page:only");
    // Refused HERE, not just downstream in DeletePage, so the caller never
    // emits a doomed intent.
    expect(deletePageIntents(editor, "page:only")).toEqual([]);
  });

  it("deleting a NON-current page leaves currentPageId alone", () => {
    const { editor } = makeEditor(THREE_PAGES, "page:p");
    expect(deletePageIntents(editor, "page:q")).toEqual([{ type: "DeletePage", id: "page:q" }]);
  });

  it("deleting the CURRENT page batches a switch onto the NEXT page", () => {
    const { editor } = makeEditor(THREE_PAGES, "page:q");
    expect(deletePageIntents(editor, "page:q")).toEqual([
      { type: "DeletePage", id: "page:q" },
      { type: "SetCurrentPage", pageId: "page:r" },
    ]);
  });

  it("deleting the CURRENT page when it is LAST falls back to the previous page", () => {
    const { editor } = makeEditor(THREE_PAGES, "page:r");
    expect(deletePageIntents(editor, "page:r")).toEqual([
      { type: "DeletePage", id: "page:r" },
      { type: "SetCurrentPage", pageId: "page:q" },
    ]);
  });

  it("leaves currentPageId live after applying a delete-of-current", () => {
    const { doc, editor } = makeEditor(THREE_PAGES, "page:r");
    editor.applyAll(deletePageIntents(editor, "page:r"));
    expect(ids(doc)).toEqual(["page:p", "page:q"]);
    expect(doc.listPages().some((p) => p.id === editor.get().currentPageId)).toBe(true);
  });

  it("is a tolerant no-op on an unknown id", () => {
    const { editor } = makeEditor(THREE_PAGES, "page:p");
    expect(deletePageIntents(editor, "page:nope")).toEqual([]);
  });
});

describe("movePageIntents", () => {
  it("moves a page exactly one slot left", () => {
    const { doc, editor } = makeEditor(THREE_PAGES, "page:p");
    const intents = movePageIntents(editor, "page:q", "left");
    expect(intents.map((i) => i.type)).toEqual(["ReorderPage"]);
    editor.applyAll(intents);
    expect(ids(doc)).toEqual(["page:q", "page:p", "page:r"]);
  });

  it("moves a page exactly one slot right", () => {
    const { doc, editor } = makeEditor(THREE_PAGES, "page:p");
    editor.applyAll(movePageIntents(editor, "page:q", "right"));
    expect(ids(doc)).toEqual(["page:p", "page:r", "page:q"]);
  });

  it("survives repeated moves (the fractional index keeps splitting)", () => {
    const { doc, editor } = makeEditor(THREE_PAGES, "page:p");
    editor.applyAll(movePageIntents(editor, "page:r", "left"));
    expect(ids(doc)).toEqual(["page:p", "page:r", "page:q"]);
    editor.applyAll(movePageIntents(editor, "page:r", "left"));
    expect(ids(doc)).toEqual(["page:r", "page:p", "page:q"]);
    editor.applyAll(movePageIntents(editor, "page:r", "right"));
    expect(ids(doc)).toEqual(["page:p", "page:r", "page:q"]);
  });

  it("no-ops at both boundaries", () => {
    const { editor } = makeEditor(THREE_PAGES, "page:p");
    expect(movePageIntents(editor, "page:p", "left")).toEqual([]);
    expect(movePageIntents(editor, "page:r", "right")).toEqual([]);
  });

  it("is a tolerant no-op on an unknown id", () => {
    const { editor } = makeEditor(THREE_PAGES, "page:p");
    expect(movePageIntents(editor, "page:nope", "left")).toEqual([]);
    expect(movePageIntents(editor, "page:nope", "right")).toEqual([]);
  });
});

describe("clampCurrentPageIntents", () => {
  it("returns [] when currentPageId names a live page", () => {
    // Must NOT fire a same-value SetCurrentPage: the caller runs this after
    // EVERY undo/redo, and a spurious intent on every keystroke is churn.
    const { editor } = makeEditor(THREE_PAGES, "page:q");
    expect(clampCurrentPageIntents(editor)).toEqual([]);
  });

  it("clamps a dangling currentPageId onto the canonical page", () => {
    // The undo hazard (design doc R-1): SetCurrentPage has no undo inverse,
    // so undoing a CreatePage+SetCurrentPage batch removes the page while
    // currentPageId still names it, and the render filter then paints
    // nothing. canonicalPageId = the lexicographically smallest live page id.
    const { editor } = makeEditor(THREE_PAGES, "page:ghost");
    expect(clampCurrentPageIntents(editor)).toEqual([{ type: "SetCurrentPage", pageId: "page:p" }]);
  });

  it("clamps to the canonical page id, not to the first page in index order", () => {
    // Deliberately index-ordered opposite to id order, so a lazy
    // `orderedPages(...)[0]` implementation fails this.
    const { editor } = makeEditor(
      [
        { id: "page:zed", name: "Z", index: "a0" },
        { id: "page:abc", name: "A", index: "a1" },
      ],
      "page:ghost",
    );
    expect(clampCurrentPageIntents(editor)).toEqual([{ type: "SetCurrentPage", pageId: "page:abc" }]);
  });

  it("returns [] when the doc has no pages at all", () => {
    const { editor } = makeEditor([], "page:ghost");
    expect(clampCurrentPageIntents(editor)).toEqual([]);
  });

  it("recovers the real undo hazard end to end", () => {
    // Not a simulation: create+switch, then undo, then clamp.
    const { doc, editor } = makeEditor([{ id: "page:p", name: "P", index: "a0" }], "page:p");
    const created = newPageIntents(editor);
    const newId = (created[0] as { page: Page }).page.id;
    editor.applyAll(created);
    expect(editor.get().currentPageId).toBe(newId);

    editor.undo();
    expect(doc.listPages().some((p) => p.id === newId)).toBe(false);
    expect(editor.get().currentPageId).toBe(newId); // stranded — this is R-1

    editor.applyAll(clampCurrentPageIntents(editor));
    expect(editor.get().currentPageId).toBe("page:p");
  });
});

// ---------------------------------------------------------------------------
// dropPageIntents — the arbitrary-position sibling of movePageIntents, added
// 2026-09-05 for the tab strip's click-and-hold reorder (owner: "click and
// hold can drag there order"). movePageIntents moves exactly ONE slot, which
// is the right shape for the popover's ◂ / ▸ buttons and the wrong one for a
// drag that can cross the whole strip in one gesture.
describe("dropPageIntents", () => {
  it("emits a single ReorderPage and no view intent", () => {
    // A REORDER IS A DOC WRITE, NOT A VIEW CHANGE. Nothing about which page
    // you are LOOKING at changes when you drag a tab past another one, so a
    // SetCurrentPage smuggled in here would put a page switch on the undo
    // stack — the mess canvas/pages/history-repair.ts exists to clean up after.
    const { editor } = makeEditor(THREE_PAGES, "page:q");
    const intents = dropPageIntents(editor, "page:p", 2);
    expect(intents.map((i) => i.type)).toEqual(["ReorderPage"]);
    editor.applyAll(intents);
    expect(editor.get().currentPageId).toBe("page:q");
  });

  it("moves the first page to the end", () => {
    const { doc, editor } = makeEditor(THREE_PAGES, "page:p");
    editor.applyAll(dropPageIntents(editor, "page:p", 2));
    expect(ids(doc)).toEqual(["page:q", "page:r", "page:p"]);
  });

  it("moves the last page to the front", () => {
    const { doc, editor } = makeEditor(THREE_PAGES, "page:p");
    editor.applyAll(dropPageIntents(editor, "page:r", 0));
    expect(ids(doc)).toEqual(["page:r", "page:p", "page:q"]);
  });

  it("moves a page between two others", () => {
    const { doc, editor } = makeEditor(THREE_PAGES, "page:p");
    editor.applyAll(dropPageIntents(editor, "page:p", 1));
    expect(ids(doc)).toEqual(["page:q", "page:p", "page:r"]);
  });

  it("computes the index against the list WITHOUT the dragged page in it", () => {
    // The off-by-one this forbids: taking the neighbours from the ORIGINAL
    // list puts the page back where it started for every rightward drop. Four
    // pages, drag the first to slot 2, and only the "removed first" reading
    // gives this answer.
    const { doc, editor } = makeEditor(
      [...THREE_PAGES, { id: "page:s", name: "S", index: "a3" }],
      "page:p",
    );
    editor.applyAll(dropPageIntents(editor, "page:p", 2));
    expect(ids(doc)).toEqual(["page:q", "page:r", "page:p", "page:s"]);
  });

  it("emits NOTHING for a drop onto the page's own position", () => {
    // Not a same-value ReorderPage: that is a doc write, a sync frame to every
    // peer and an undo entry that undoes nothing anybody can see.
    const { editor } = makeEditor(THREE_PAGES, "page:p");
    expect(dropPageIntents(editor, "page:q", 1)).toEqual([]);
  });

  it("emits nothing when the drop rule had no answer", () => {
    // `null` is what canvas/pages/tab-drag.ts's dropIndexAt returns for a drop
    // onto self, an unmeasured pointer and a single-tab strip alike, and it is
    // accepted here so the panel never has to write that `if` itself.
    const { editor } = makeEditor(THREE_PAGES, "page:p");
    expect(dropPageIntents(editor, "page:q", null)).toEqual([]);
  });

  it("is a tolerant no-op on an unknown id and on an out-of-range target", () => {
    const { editor } = makeEditor(THREE_PAGES, "page:p");
    expect(dropPageIntents(editor, "page:nope", 0)).toEqual([]);
    expect(dropPageIntents(editor, "page:p", 3)).toEqual([]);
    expect(dropPageIntents(editor, "page:p", -1)).toEqual([]);
    expect(dropPageIntents(editor, "page:p", 1.5)).toEqual([]);
  });

  it("refuses rather than throwing when the drop site's neighbours are tied", () => {
    // generateKeyBetween THROWS on `a >= b` (canvas-model/src/
    // fractional-index.ts:164), and two pages CAN share an index — orderedPages
    // breaks the tie on id, so a tie is a legal document, not a corrupt one.
    // Refusing the reorder loses a drag; throwing takes the whole panel down
    // mid-gesture. (movePageIntents above has the same hazard and does NOT
    // guard it — observed by reading, not fixed here.)
    const { editor } = makeEditor(
      [
        { id: "page:a", name: "A", index: "a1" },
        { id: "page:b", name: "B", index: "a1" },
        { id: "page:c", name: "C", index: "a5" },
      ],
      "page:a",
    );
    expect(dropPageIntents(editor, "page:c", 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE TWO PROPERTIES FRACTIONAL INDICES EXIST FOR. A drag is the first
// reorder gesture in this plugin that a user will perform casually and often,
// so these stop being theory: an order that evaporates on reload, or that two
// people fight over, is what "we should have used a list index" feels like.
describe("a dragged reorder is durable and convergent", () => {
  it("survives a reload, because it is a doc write and not view state", () => {
    const { doc, editor } = makeEditor(THREE_PAGES, "page:p");
    editor.applyAll(dropPageIntents(editor, "page:p", 2));
    doc.commit();

    const reloaded = LoroCanvasDoc.fromSnapshot(doc.exportSnapshot(), { peerId: 9n });
    expect(orderedPages(reloaded.listPages()).map((p) => p.id)).toEqual([
      "page:q",
      "page:r",
      "page:p",
    ]);
  });

  it("converges when two peers reorder at the same time, in either merge order", () => {
    // TWO CONCURRENT DRAGS, neither peer having seen the other's. With a
    // fractional index each write is an independent assignment to its own
    // page's own field, so both survive and both peers sort to the same list.
    // A positional "move to slot N" would have had to pick a loser.
    const origin = LoroCanvasDoc.create({ peerId: 1n });
    for (const p of THREE_PAGES) origin.putPage(p);
    origin.commit();
    const seed = origin.exportSnapshot();

    const docA = LoroCanvasDoc.fromSnapshot(seed, { peerId: 2n });
    const docB = LoroCanvasDoc.fromSnapshot(seed, { peerId: 3n });
    const editorA = new Editor({ doc: docA, now: () => 0, random: FIXED_RANDOM, pageId: "page:p" });
    const editorB = new Editor({ doc: docB, now: () => 0, random: FIXED_RANDOM, pageId: "page:p" });

    editorA.applyAll(dropPageIntents(editorA, "page:p", 2)); // A sends P to the end
    editorB.applyAll(dropPageIntents(editorB, "page:r", 0)); // B sends R to the front
    docA.commit();
    docB.commit();
    expect(ids(docA)).not.toEqual(ids(docB)); // genuinely divergent before the exchange

    const fromA = docA.exportUpdate();
    const fromB = docB.exportUpdate();
    docA.import(fromB);
    docB.import(fromA);

    expect(ids(docA)).toEqual(ids(docB));
    expect(ids(docA)).toEqual(["page:r", "page:q", "page:p"]);
  });
});
