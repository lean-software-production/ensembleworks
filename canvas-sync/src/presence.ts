// loro-crdt/base64 inlines its wasm as a JS string — see canvas-doc/loro-canvas-doc.ts
import { EphemeralStore } from 'loro-crdt/base64'

// The presence payload one peer publishes about itself. No renderer yet
// (Phase 3), so this is the wire contract, exercised headlessly. Values are
// plain JSON (EphemeralStore requires Loro Values).
export interface Presence {
  cursor: { x: number; y: number } | null
  viewport: { x: number; y: number; w: number; h: number; z: number } | null
  stamp: { at: { x: number; y: number } } | null // the spatial stamp tool
  presenting: string[] // OPAQUE per-entry strings the client may encode richer data into (canvas-v2's file-viewer JSON-encodes {shapeId,fraction,ts}); do NOT assume an entry is a bare shape id or that `presenting.includes(shapeId)` is meaningful — decode client-side
  /** The shape id this peer is currently text-editing, or null. Drives the
   * "someone is editing" indicator (pilot 5 — F1 owner decision: Option 1,
   * indicator-only; no lock, concurrent setText remains a documented LWW
   * stomp). Plain JSON (EphemeralStore requires Loro Values). OPTIONAL,
   * deliberately: making this required would mean migrating every
   * `Presence` construction site (there is exactly one full-object literal
   * in production code today, client/src/canvas-v2/presence.ts's
   * `createPresencePublisher`, plus this file's own test fixtures) —
   * optional keeps the change surgical. Consumers must treat an ABSENT
   * field the same as `null` ("not editing"), which is also what makes this
   * change compatible with an older publisher that predates pilot 5: it
   * simply never sets the key, and readers see "not editing" rather than a
   * decode error. */
  editing?: string | null
}

// Thin wrapper: one EphemeralStore, this peer writes its own key, reads all.
// LWW per key + timeout expiry are Loro's; we only encode/apply on the wire.
// Probe-confirmed (loro-crdt 1.13.6): subscribeLocalUpdates fires SYNCHRONOUSLY
// from set() (no microtask hop) — callers can rely on onLocalUpdate having
// fired before publish() returns.
export class PresenceStore {
  private store: EphemeralStore
  constructor(
    private selfKey: string,
    timeoutMs = 30_000,
  ) {
    this.store = new EphemeralStore(timeoutMs)
  }
  /** Callers are responsible for rate-limiting publishes (e.g. cursor moves):
   * every set() goes to the wire uncoalesced, and the server fans each frame
   * out to N-1 clients. Phase 3's renderer must throttle pointer-move-rate
   * publishes before wiring them here. */
  publish(p: Presence): void {
    this.store.set(this.selfKey, p as any)
  }
  /** Includes the caller's own published entry under `selfKey` — Phase 3
   * renderers should filter it out (rendering your own cursor from
   * round-tripped network state is a stale duplicate of the local one). */
  all(): Record<string, Presence> {
    return this.store.getAllStates() as any
  }
  /** Bytes to broadcast after a local publish (wire via Frame.Presence). */
  onLocalUpdate(cb: (bytes: Uint8Array) => void): () => void {
    return this.store.subscribeLocalUpdates(cb)
  }
  apply(bytes: Uint8Array): void {
    this.store.apply(bytes)
  }
  encodeAll(): Uint8Array {
    return this.store.encodeAll()
  }
  /** Stops the store's internal expiry-cleanup timer (EphemeralStore.destroy()).
   * Probe-confirmed: while non-empty, EphemeralStore keeps a periodic timer
   * alive that otherwise holds the process open (observed ~45s hang per test
   * file without this) — callers that own a PresenceStore's lifecycle (tests,
   * and any long-lived process shutting down) should call this to release it.
   * Peers do NOT call this from their close() — they don't own the store the
   * caller injected; they only unsubscribe their own onLocalUpdate listener. */
  destroy(): void {
    this.store.destroy()
  }
}
