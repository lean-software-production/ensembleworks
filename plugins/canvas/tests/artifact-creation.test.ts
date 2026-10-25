import { describe, expect, it } from "vitest";
import { LoroCanvasDoc, loadModel } from "@ensembleworks/canvas-doc";
import { makeDocument, validateShape, decodeClipboard } from "@ensembleworks/canvas-model";
import { Editor, pasteIntents, duplicateSelectionIntents } from "@ensembleworks/canvas-editor";
import { SyncClientPeer, SyncServerPeer, makePair } from "@ensembleworks/canvas-sync";

const artifact = { id: "shape:art", kind: "artifact", parentId: "page:p", index: "a1",
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { w: 720, h: 540, schemaVersion: 1, source: "thread-storage",
    threadId: "thr_fixture01", path: "reports/deck.html", title: "Deck" } } as const;
const clipboard = JSON.stringify({ "ensembleworks/clipboard": 1, shapes: [artifact], bindings: [] });
const create = () => {
  const doc = LoroCanvasDoc.create({ peerId: 101n, onInvalidWrite: () => {} });
  doc.putPage({ id: "page:p", name: "P" }); doc.commit();
  return doc;
};
const editorFor = (doc: LoroCanvasDoc) => new Editor({ doc, pageId: "page:p", now: () => 1, random: () => 0.5 });

describe("Release N refuses artifact origination", () => {
  it("Paste emits no artifact creation intents", () => {
    const editor = editorFor(create());
    expect(decodeClipboard(clipboard).shapes).toEqual([]);
    expect(pasteIntents(editor, clipboard)).toEqual([]);
  });
  it("Duplicate preserves the stored artifact but cannot clone it", () => {
    const doc = create();
    doc.putShapeUnchecked(artifact); doc.commit(); // stored N+1 fixture, not an N authoring API
    const editor = editorFor(doc);
    editor.apply({ type: "SetSelection", ids: [artifact.id] });
    expect(duplicateSelectionIntents(editor)).toEqual([]);
    expect(doc.getShape(artifact.id)).toEqual(artifact);
  });
  for (const route of ["putShape", "CreateShape", "model import", "kind conversion"] as const) {
    it(`refuses ${route}`, () => {
      const doc = create();
      if (route === "putShape") doc.putShape(artifact);
      if (route === "CreateShape") editorFor(doc).apply({ type: "CreateShape", shape: artifact });
      if (route === "model import") loadModel(doc, makeDocument({ pages: [], shapes: [artifact], bindings: [] }));
      if (route === "kind conversion") {
        doc.putShape({ ...artifact, kind: "note", props: {} });
        doc.putShape(artifact);
      }
      expect(doc.listShapes().filter((s) => s.kind === "artifact")).toEqual([]);
    });
  }
  it("client and server generic writes cannot originate artifacts", () => {
    const server = new SyncServerPeer({ peerId: 1n });
    const [a, b] = makePair(); server.connect(a);
    const client = new SyncClientPeer({ peerId: 2n, transport: b, onInvalidWrite: () => {} });
    client.doc.putPage({ id: "page:p", name: "P" }); client.doc.commit();
    client.putShape(artifact);
    server.doc.putShape({ ...artifact, id: "shape:server" }); server.doc.commit();
    expect(client.doc.listShapes()).toEqual([]);
    expect(server.doc.listShapes()).toEqual([]);
    client.close(); server.close();
  });
});

it("separately: stored artifacts validate, survive snapshot/update import, sync and repair", () => {
  expect(validateShape(artifact).ok).toBe(true);
  const stored = create(); stored.putShapeUnchecked(artifact); stored.commit();
  const restored = LoroCanvasDoc.fromSnapshot(stored.exportSnapshot(), { peerId: 2n });
  const imported = LoroCanvasDoc.create({ peerId: 3n }); imported.import(stored.exportUpdate());
  for (const doc of [restored, imported]) {
    expect(doc.repair()).toEqual([]);
    expect(doc.getShape(artifact.id)).toEqual(artifact);
  }
  // Restoring an artifact already seen in imported history is preservation,
  // including undo of ordinary canvas deletion, not new artifact origination.
  const editor = editorFor(restored);
  editor.apply({ type: "DeleteShapes", ids: [artifact.id] });
  expect(restored.getShape(artifact.id)).toBeUndefined();
  editor.undo();
  expect(restored.getShape(artifact.id)).toEqual(artifact);
  const server = new SyncServerPeer({ peerId: 4n, initialSnapshot: restored.exportSnapshot() });
  const [a, b] = makePair(); server.connect(a);
  const client = new SyncClientPeer({ peerId: 5n, transport: b });
  expect(client.doc.getShape(artifact.id)).toEqual(artifact);
  expect(client.doc.repair()).toEqual([]);
  client.close(); server.close();
});
