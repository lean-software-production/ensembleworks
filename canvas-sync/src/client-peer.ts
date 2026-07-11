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
   * made while offline). Re-wires onMessage/onClose on the new transport and
   * re-runs the sync handshake. The old transport is assumed dead (closed);
   * we do not close it here.
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
    this.transport = transport
    this.wireTransport(this.transport)
    this.requestSync()
    this.transport.send(encode(Frame.Update, this.doc.exportUpdate()))
  }

  private onFrame(frame: Uint8Array): void {
    const { tag, payload } = decode(frame)
    if (tag === Frame.Update) { this.doc.import(payload); this.doc.repair(); this.doc.commit() }
    // Frame.Presence: B5. Unknown tags: deliberately ignored.
  }

  putShape(s: Shape): void { this.doc.putShape(s); this.doc.commit() }

  close(): void { this.unsubLocal(); this.transport.close() }
}
