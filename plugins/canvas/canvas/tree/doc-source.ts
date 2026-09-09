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

/** A tree service reading a live room's document. */
export function treeServiceForDoc(doc: CanvasDoc): TreeService {
  return createTreeService({ document: () => dumpModel(doc) });
}
