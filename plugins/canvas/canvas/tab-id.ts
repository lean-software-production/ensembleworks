// This tab's address in the room — one of them, for everything in it.
//
// WHY IT HAD TO EXIST. The canvas panel minted its clientId in `useState`, and
// the presence strip had no id at all: it read the room but never registered,
// which is why a bb tab that never opened the canvas was invisible to everyone
// else (proved during this feature's preflight — opening two fresh bb tabs left
// `canvas_debug.clientIds` completely unchanged). The strip now reports itself
// on the roster poll it was already making, and it needs an address to report
// under.
//
// WHY IT IS SHARED AND NOT A SECOND ID. If the strip minted its own, a canvas
// tab would hold two addresses — one as a sync-room member, one as a location
// reporter — and would be counted twice in "N online". One tab is one address;
// the panel and the strip are two views of the same tab.
//
// SCOPE: a module singleton, so it is per TAB per frontend generation, exactly
// like canvas/panel-bus.ts (the host mounts one plugin bundle per bb app
// window, which is what makes that trick work). Nothing is persisted —
// `sessionStorage` would survive a reload and hand the room a "member" whose
// tab has been replaced, and the whole point of an address is that it dies with
// the thing it addresses.
import { newClientId } from "../transport.js";

let id: string | null = null;

/** This tab's clientId, minted on first ask and never again. */
export function tabClientId(): string {
  id ??= newClientId();
  return id;
}
