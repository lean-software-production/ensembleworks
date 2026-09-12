// W5's SERVER SEAM: the one function that points the tree service at a live
// room's document.
//
// Deliberately its own file, and deliberately three lines of logic. The
// service (service.ts) and the model (model.ts) take a canvas-model VALUE and
// stay testable against a fixture; everything that knows a `CanvasDoc` — a
// Loro handle, WASM, a room — is here. W6's agent tools and W13's CLI both
// call this with `room.peer.doc` and hold a `TreeService` from then on.
//
// `dumpModel` is canvas-doc's own doc -> document conversion, the same one
// canvas-editor reads through, so the tree sees exactly the document every
// other reader sees. It is called on EVERY query rather than memoised: a
// human is editing this doc while an agent reads it, and a memo would need an
// invalidation signal that has no honest source here (see service.ts's NO
// CACHE note).
import { dumpModel, type CanvasDoc } from "@ensembleworks/canvas-doc";
import { createTreeService, type TreeService } from "./service.js";
import { createTreeWriter } from "./writes.js";
import type { TreeWriter } from "./write-seam.js";
import type { TreeRepairTarget } from "./repair.js";

/**
 * A tree service reading a live room's document.
 *
 * TWO CHANNELS, and the second one is the whole of W15. `dumpModel` carries a
 * shape's `props` — but NOT the per-shape LoroText container a human's
 * keystrokes land in (`doc.getText`), which lives outside the shape tree
 * entirely. Handing the service only the document is what made every
 * agent-facing surface report `(untitled)` for a title a human had typed
 * (W14's F1). `text` is that channel, and `shape-text.ts` is the one place
 * that decides which of the two wins.
 */
export function treeServiceForDoc(doc: CanvasDoc): TreeService {
  return createTreeService({ document: () => dumpModel(doc), text: (id) => doc.getText(id) });
}

/**
 * A tree writer against a live room's document (W10).
 *
 * TWO INJECTIONS, both for the same reason the service takes a thunk — so
 * `writes.ts` stays a pure module with no Loro, no clock and no PRNG in it:
 *
 * - `commit` defaults to `doc.commit()`, which broadcasts the delta to every
 *   connected client (canvas-sync's `SyncServerPeer` subscribes to local
 *   updates). It is OVERRIDABLE because a broadcast is not durability: the
 *   room's SQLite update log is written by its inbound-frame path, which a
 *   server-local write never goes through. server.ts passes
 *   `CanvasRoomHost.commitLocalWrite`, which does both.
 * - `random` is the entropy new shape ids are drawn from, injected exactly as
 *   canvas-editor injects `random()` — so a test can name the id a write is
 *   about to mint instead of fishing it out afterwards.
 */
export function treeWriterForDoc(
  doc: CanvasDoc,
  options?: { commit?: () => void; random?: () => number },
): TreeWriter {
  const commit = options?.commit ?? (() => doc.commit());
  const random = options?.random ?? (() => Math.random());
  return createTreeWriter({
    document: () => dumpModel(doc),
    getShape: (id) => doc.getShape(id),
    putShape: (shape) => doc.putShape(shape),
    updateProps: (id, props) => doc.updateProps(id, props),
    // The title channel, read AND written — an agent's rename lands in the
    // same container a human's keystrokes do, so the two can never mean two
    // different titles for one node (W15).
    text: (id) => doc.getText(id),
    setText: (id, text) => doc.setText(id, text),
    putBinding: (binding) => doc.putBinding(binding),
    putPage: (page) => doc.putPage(page),
    commit,
    random,
  });
}

/**
 * The repair/restore target over a live room document (W11, reached at W13).
 *
 * FOUR CLOSURES, and the absence of the rest is the point: `TreeRepairTarget`
 * is `TreeWriteTarget` minus every delete, so nothing reached through this
 * handle can tombstone a shape a human drew. Quarantine and restore are both
 * one meta key, and this is the whole surface they need.
 *
 * `commit` is overridable for the same reason `treeWriterForDoc`'s is: a
 * server-local write is broadcast by canvas-sync but logged by nobody, so
 * server.ts passes `CanvasRoomHost.commitLocalWrite` to make a restore as
 * durable as a human's frame.
 */
export function treeRepairTargetForDoc(
  doc: CanvasDoc,
  options?: { commit?: () => void },
): TreeRepairTarget {
  const commit = options?.commit ?? (() => doc.commit());
  return {
    document: () => dumpModel(doc),
    getShape: (id) => doc.getShape(id),
    putShape: (shape) => doc.putShape(shape),
    commit,
  };
}
