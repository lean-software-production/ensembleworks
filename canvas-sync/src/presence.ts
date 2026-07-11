import { EphemeralStore } from 'loro-crdt'

// The presence payload one peer publishes about itself. No renderer yet
// (Phase 3), so this is the wire contract, exercised headlessly. Values are
// plain JSON (EphemeralStore requires Loro Values).
export interface Presence {
  cursor: { x: number; y: number } | null
  viewport: { x: number; y: number; w: number; h: number; z: number } | null
  stamp: { at: { x: number; y: number } } | null // the spatial stamp tool
  presenting: string[] // shape ids this peer is presenting/holding
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
  publish(p: Presence): void {
    this.store.set(this.selfKey, p as any)
  }
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
