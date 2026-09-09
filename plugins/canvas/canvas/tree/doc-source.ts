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
import { createTreeWriter, type TreeWriter } from "./writes.js";

/** A tree service reading a live room's document. */
export function treeServiceForDoc(doc: CanvasDoc): TreeService {
  return createTreeService({ document: () => dumpModel(doc) });
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
    putBinding: (binding) => doc.putBinding(binding),
    commit,
    random,
  });
}
