import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
import { Frame, type Transport, decode, encode } from './protocol.js'

export interface SyncClientOpts { peerId: bigint; transport: Transport }

// Headless sync client. No renderer (Phase 3): callers mutate via the doc and
// read listShapes()/dumpModel(). Repair runs after every remote merge so this
// peer converges to the same repaired state as every other.
export class SyncClientPeer {
  readonly doc: LoroCanvasDoc
  private transport: Transport
  private unsubLocal: () => void
  private closed = false

  constructor(opts: SyncClientOpts) {
    this.doc = LoroCanvasDoc.create({ peerId: opts.peerId })
    this.transport = opts.transport
    // Forward every committed local op to whichever transport is CURRENT: the
    // closure reads the `this.transport` field on each fire, not a value
    // captured at subscribe time — so a later reconnect() swap is honored
    // without re-subscribing.
    this.unsubLocal = this.doc.subscribeLocalUpdates((bytes) => this.transport.send(encode(Frame.Update, bytes)))
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
    }
    // Frame.Presence: B5. Unknown tags: deliberately ignored.
  }

  putShape(s: Shape): void { this.doc.putShape(s); this.doc.commit() }

  /** Idempotent: unsubscribes local updates, closes the transport, and marks
   * this peer closed so late-arriving frames are ignored (see onFrame). */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubLocal()
    this.transport.close()
  }
}
