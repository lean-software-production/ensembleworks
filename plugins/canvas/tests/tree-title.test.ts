// Run: npx vitest run tests/tree-title.test.ts
//
// W15's gate, and the file that closes the blind spot W14's F1 fell through.
//
// THE DEFECT. A human typing into a note dispatches canvas-editor's `SetText`
// intent, which lands in a per-shape LoroText container (`CanvasDoc.setText`,
// keyed `text:<shapeId>`). The tree read spine took a node's title from
// `plainText(shape)`, which reads `props.richText` — a DIFFERENT channel.
// Every agent-facing surface therefore said `(untitled)` for text the human
// could plainly read on screen.
//
// WHY NO TEST CAUGHT IT. Every other fixture in this feature sets
// `props.richText` directly, so the fixtures and the production write path
// agreed with each other and disagreed with the human. This suite is the one
// place that refuses to use a fixture title: EVERY title here is written
// through a path something real writes through —
//
//   - the HUMAN path: `new Editor(...).apply({ type: "SetText", ... })`, the
//     exact intent canvas/panel/session.tsx's `handleTextChange` dispatches on
//     every keystroke, against a real `LoroCanvasDoc`;
//   - the AGENT path: `TreeWriter.rename` / `addChild` / `addGoal` through
//     `treeWriterForDoc`, the same adapter server.ts wires;
//   - the LEGACY path: `props.richText`, which is what an imported document
//     and every older fixture carries.
//
// and the two live paths are asserted AGAINST EACH OTHER — a title an agent
// sets is read back by the human's channel and vice versa — rather than each
// against its own fixture. That mutual assertion is the blind spot's closure:
// it cannot pass while the two channels disagree about one field.
import { describe, expect, it } from "vitest";
import { LoroCanvasDoc, dumpModel, loadModel } from "@ensembleworks/canvas-doc";
import { Editor } from "@ensembleworks/canvas-editor";
import { treeServiceForDoc, treeWriterForDoc } from "../canvas/tree/doc-source.js";
import { nodeReferenceFor } from "../canvas/tree/discuss.js";
import { EXAMPLE, TREE, docOf } from "./lib/tree-fixture.js";

/** The fixture tree, loaded into a REAL Loro document. */
function liveDoc(): LoroCanvasDoc {
  const doc = LoroCanvasDoc.create({ peerId: 15n });
  loadModel(doc, docOf(EXAMPLE));
  doc.commit();
  return doc;
}

/**
 * A human typing a title into a note.
 *
 * Deliberately NOT `doc.setText`: this goes through the `SetText` intent, so
 * the test is pinned to the path the panel actually dispatches. If canvas-
 * editor ever routes typing somewhere else, this breaks — which is the point.
 */
function humanTypes(doc: LoroCanvasDoc, id: string, text: string): void {
  const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: TREE });
  editor.apply({ type: "SetText", id, text });
}

/** A seeded id stream, so a mint cannot collide with the fixture's own ids
 * (the write suite's generator, verbatim). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** What the human sees on the canvas: the live text container the plain-text
 * editing mount writes and canvas-react's `labelOf` reads first. */
const onScreen = (doc: LoroCanvasDoc, id: string): string => doc.getText(id);

/** What every agent surface reads: the tree service's title. */
const readTitle = (doc: LoroCanvasDoc, id: string): string => {
  const found = treeServiceForDoc(doc).node(id);
  if (!found.ok) return expect.unreachable(`no node ${id}: ${found.detail}`);
  return found.value.title;
};

describe("a title a human typed", () => {
  it("is what the agent reads", () => {
    const doc = liveDoc();
    humanTypes(doc, "shape:api", "Talk to an agent about a node");
    expect(readTitle(doc, "shape:api")).toBe("Talk to an agent about a node");
  });

  it("wins over whatever the shape's richText still says", () => {
    const doc = liveDoc();
    // The fixture already gave shape:api the richText title "Tree service".
    humanTypes(doc, "shape:api", "Fix the tree encoding");
    expect(readTitle(doc, "shape:api")).toBe("Fix the tree encoding");
  });

  it("is what the digest and the outline name it", () => {
    const doc = liveDoc();
    humanTypes(doc, "shape:goal", "Ship the discovery tree");
    const digest = treeServiceForDoc(doc).digest(TREE);
    if (!digest.ok) return expect.unreachable(digest.detail);
    expect(digest.value.text).toContain("Ship the discovery tree");
  });
});

describe("a title an agent wrote", () => {
  it("is what the human sees on the canvas", () => {
    const doc = liveDoc();
    expect(treeWriterForDoc(doc).rename({ nodeId: "shape:api", title: "Tree service (server)" }).ok)
      .toBe(true);
    expect(onScreen(doc, "shape:api")).toBe("Tree service (server)");
  });

  it("lands on a node the human has already typed into, instead of hiding behind it", () => {
    const doc = liveDoc();
    humanTypes(doc, "shape:api", "typed first");
    expect(treeWriterForDoc(doc).rename({ nodeId: "shape:api", title: "renamed after" }).ok).toBe(true);
    expect(onScreen(doc, "shape:api")).toBe("renamed after");
    expect(readTitle(doc, "shape:api")).toBe("renamed after");
  });

  it("is on a node it created, in both channels' one reading", () => {
    const doc = liveDoc();
    const done = treeWriterForDoc(doc, { random: seededRandom(15) }).addChild({
      parentId: "shape:goal",
      title: "Write the write path",
    });
    if (!done.ok) return expect.unreachable(done.detail);
    const created = done.value.createdId as string;
    expect(onScreen(doc, created)).toBe("Write the write path");
    expect(readTitle(doc, created)).toBe("Write the write path");
  });
});

describe("the human path and the agent path, against each other", () => {
  it("round-trips a title in both directions through the same field", () => {
    const doc = liveDoc();
    // Human types; agent reads it back.
    humanTypes(doc, "shape:ui", "drawn by hand");
    expect(readTitle(doc, "shape:ui")).toBe("drawn by hand");
    // Agent renames; human sees it.
    expect(treeWriterForDoc(doc).rename({ nodeId: "shape:ui", title: "renamed by the agent" }).ok)
      .toBe(true);
    expect(onScreen(doc, "shape:ui")).toBe("renamed by the agent");
    // Human types over that; the agent reads the human's, not its own.
    humanTypes(doc, "shape:ui", "and typed over again");
    expect(readTitle(doc, "shape:ui")).toBe("and typed over again");
    expect(onScreen(doc, "shape:ui")).toBe("and typed over again");
  });
});

describe("a title only an import left behind", () => {
  it("is still read, because richText is the fallback and not a second rule", () => {
    const doc = liveDoc();
    // Nobody has typed into shape:schema, so its live container is empty and
    // its fixture richText is all there is.
    expect(onScreen(doc, "shape:schema")).toBe("");
    expect(readTitle(doc, "shape:schema")).toBe("Encoding contract");
  });
});

describe("the breadcrumb W8 puts in the composer", () => {
  it("names a step by the title the human typed, not the one the import left", () => {
    const doc = liveDoc();
    humanTypes(doc, "shape:api", "Fix the tree encoding");
    const reference = nodeReferenceFor(dumpModel(doc), TREE, "shape:schema", (id) =>
      doc.getText(id),
    );
    if (!reference.ok) return expect.unreachable(reference.why);
    // The path is goal -> api -> schema; `shape:api` is the step the human
    // just retitled. This text is pasted into a thread composer, so a stale
    // step here is a wrong name in the agent's own prompt.
    expect(reference.text).toContain("Fix the tree encoding");
    expect(reference.text).not.toContain("Tree service");
  });
});

describe("a note the human blanked out", () => {
  it("reads as empty, not as the title the import left behind", () => {
    const doc = liveDoc();
    // Whitespace, which is what the canvas draws for a note someone cleared —
    // canvas-react's `labelOf` tests `length`, not `trim().length`, so the
    // note on screen is blank. The agent must not read the old richText title
    // off a note the human is looking at and seeing nothing on.
    humanTypes(doc, "shape:api", "   ");
    expect(readTitle(doc, "shape:api").trim()).toBe("");
  });
});
