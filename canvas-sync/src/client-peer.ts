import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
import { Frame, type Transport, decode, encode } from './protocol.js'
import type { PresenceStore } from './presence.js'

export interface SyncClientOpts {
  peerId: bigint
  transport: Transport
  /** Optional: wires Frame.Presence both ways. Omitted entirely for rigs that
   * only care about docs — presence-less peers simply drop Presence frames
   * (no send subscription set up, and onFrame's Presence branch is a no-op). */
  presence?: PresenceStore
}

// Headless sync client. No renderer (Phase 3): callers mutate via the doc and
// read listShapes()/dumpModel(). Repair runs after every remote merge so this
// peer converges to the same repaired state as every other.
export class SyncClientPeer {
  readonly doc: LoroCanvasDoc
  private transport: Transport
  private unsubLocal: () => void
  private presence?: PresenceStore
  private unsubPresence?: () => void
  private closed = false

  constructor(opts: SyncClientOpts) {
    this.doc = LoroCanvasDoc.create({ peerId: opts.peerId })
    this.transport = opts.transport
    this.presence = opts.presence
    // Forward every committed local op to whichever transport is CURRENT: the
    // closure reads the `this.transport` field on each fire, not a value
    // captured at subscribe time — so a later reconnect() swap is honored
    // without re-subscribing.
    this.unsubLocal = this.doc.subscribeLocalUpdates((bytes) => this.transport.send(encode(Frame.Update, bytes)))
    // Same pattern for presence: one subscription, set up once, that reads
    // `this.transport` at fire time — a reconnect() swap is honored without
    // re-subscribing here either. Only wired if a PresenceStore was injected.
    this.unsubPresence = this.presence?.onLocalUpdate((bytes) => this.transport.send(encode(Frame.Presence, bytes)))
    this.wireTransport(this.transport)
    // Ask the server for anything we're missing.
    this.requestSync()
  }

  private wireTransport(t: Transport): void {
    t.onMessage((frame) => this.onFrame(frame))
    t.onClose(() => {})
  }

  /** (Re)connect handshake: tell the server our version so it sends only the delta. */
  requestSync(): void { this.transport.send(encode(Frame.SyncRequest, this.doc.versionBytes())) }

  /**
   * Swap to a fresh transport after a disconnect, keeping the doc (and any ops
   * made while offline). Closes the OLD transport first: if it already died,
   * close() is an idempotent no-op (Transport contract), and if it's a zombie
   * (half-dead channel we gave up on) closing it fires its onClose on the
   * server side, which drops the stale entry from the server's client set —
   * otherwise every reconnect would leak one entry and double-relay down the
   * dead channel. Then re-wires onMessage/onClose on the new transport and
   * re-runs the sync handshake.
   *
   * Offline edits, and how they reach the server: while disconnected, this
   * peer's own commits still fire subscribeLocalUpdates, but that send() lands
   * on the (closed) old transport and is a silent no-op per the Transport
   * contract — so offline ops are NOT queued for automatic resend. The
   * server's reply to our SyncRequest only carries what THE SERVER is missing
   * FROM US in the other direction (nothing carries our divergent history
   * upstream by itself). So on every reconnect we ALSO push our full history
   * as a Frame.Update: Loro's import() is idempotent (ops already known to the
   * peer are no-ops), so resending everything is correct, just not
   * bandwidth-optimal. A since-last-known-server-version delta is a deferred
   * optimization (would need this peer to track the last version it knows the
   * server has acked) — left as a follow-up, noted in the execution report.
   */
  reconnect(transport: Transport): void {
    this.transport.close() // idempotent if already dead; evicts a zombie from the server's client set
    this.transport = transport
    this.wireTransport(this.transport)
    this.requestSync()
    this.transport.send(encode(Frame.Update, this.doc.exportUpdate()))
  }

  private onFrame(frame: Uint8Array): void {
    // A real ws can deliver buffered frames after the app-level close — not
    // misuse; drop them silently rather than mutating a closed peer's doc.
    if (this.closed) return
    // Malformed-frame guard, mirroring SyncServerPeer.onFrame's (see its
    // comment for the full rationale): a buggy or hostile server must not
    // crash whichever process hosts this client (a shadow driver, an agent,
    // a rig) via an uncaught decode()/import() throw inside the transport's
    // message dispatch. Log and drop. No malformedFrames counter here,
    // deliberately: client-side metrics are Phase 3's concern (the D3
    // metrics endpoint only scrapes server peers), and an unread counter is
    // dead surface until then.
    try {
      this.handleFrame(frame)
    } catch (err) {
      console.warn('[canvas-sync] client peer dropped a malformed inbound frame:', err)
    }
  }

  private handleFrame(frame: Uint8Array): void {
    const { tag, payload } = decode(frame)
    if (tag === Frame.Update) {
      // Gate repair/commit on whether the import newly applied anything:
      // repair() costs O(doc) even with an empty plan (~7ms/call at 1k shapes
      // — see LoroCanvasDoc.repair's PERF note), and redundant deliveries
      // (e.g. our own reconnect backfill echoed via a stale channel) would
      // otherwise pay it for nothing. A PENDING import (changed: false,
      // pending: true — ops dependent on unseen history) also applied nothing,
      // so it too skips repair. Unlike the server we relay to no one, so no
      // gate change is needed for pending here: Loro auto-applies the pended
      // ops when the gap-filler arrives (the server relays it), and worst case
      // the next requestSync() self-heals — the server's reply carries the
      // full missing delta.
      const r = this.doc.import(payload)
      if (r.changed) { this.doc.repair(); this.doc.commit() }
    } else if (tag === Frame.Presence) {
      // Ephemeral bytes: no changed-gating, no repair — just hand the raw
      // encoded state to the store (LWW/merge is Loro's job). A no-op if
      // this peer wasn't constructed with a presence store.
      this.presence?.apply(payload)
    }
    // Unknown tags: deliberately ignored.
  }

  putShape(s: Shape): void { this.doc.putShape(s); this.doc.commit() }

  /** Idempotent: unsubscribes local updates (doc AND presence, if wired),
   * closes the transport, and marks this peer closed so late-arriving frames
   * are ignored (see onFrame). Does NOT destroy() an injected PresenceStore —
   * this peer doesn't own its lifecycle, only its own subscription to it. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubLocal()
    this.unsubPresence?.()
    this.transport.close()
  }
}
