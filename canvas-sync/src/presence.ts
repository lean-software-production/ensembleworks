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
  /** The canvas PAGE this peer is currently looking at, or null. Drives
   * page-scoped presence: consumers hide a peer whose page is present and
   * differs from the local page (canvas-react's `Cursors` does exactly this
   * behind an opt-in `currentPageId` prop).
   *
   * WHY, given docs/plans/2026-07-22-canvas-v2-pages.md's D-7 explicitly
   * DEFERRED this: that deferral's reasoning was sound for the standalone
   * client — cursors are world-space, so a peer on another page just lands
   * off-content, which is harmless. It does not transfer to the bb plugin,
   * whose presence dock exists solely to answer "who is where". Reporting
   * somebody as "on the canvas" while their cursor drifts through a page
   * they are not on is the same failure that dock's own
   * `canvas/dock/where.ts` already refuses for stale locations: a stale
   * location is worse than none — it is wrong and it looks right. See
   * docs/plans/2026-09-05-bb-canvas-multi-page-design.md D-4, which reverses
   * D-7 for bb specifically without claiming the original call was wrong for
   * the client.
   *
   * OPTIONAL, deliberately — same precedent and same two reasons as
   * `editing` above. (a) An ABSENT key means "UNKNOWN", which consumers must
   * treat as "do not filter", NOT as "on some other page": erasing a peer
   * who simply has not told you where they are would be the same
   * confidently-wrong report this field exists to prevent. (b) A publisher
   * that predates this change never sets the key, so a newer reader sees
   * "unknown" rather than a decode error — presence.test.ts case (6)
   * asserts both directions, including that a page-less payload leaves the
   * key genuinely absent rather than inheriting the peer's last page. */
  page?: string | null
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
