import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { Frame, type Transport, decode, encode } from './protocol.js'

export interface SyncServerOpts { peerId: bigint; initialSnapshot?: Uint8Array }

// One authoritative peer per room. Transport-agnostic: server.connect(transport)
// registers a client; the server never imports ws. Every merge is followed by
// repair so the server's converged state is canonical.
export class SyncServerPeer {
  readonly doc: LoroCanvasDoc
  private clients = new Set<Transport>()
  private unsubLocal: () => void

  constructor(opts: SyncServerOpts) {
    this.doc = opts.initialSnapshot
      ? LoroCanvasDoc.fromSnapshot(opts.initialSnapshot, { peerId: opts.peerId })
      : LoroCanvasDoc.create({ peerId: opts.peerId })
    // When the server's own doc changes (e.g. repair, or an agent write), push
    // the delta to every connected client — including the client whose Update
    // triggered it, since a repair delta can touch data beyond what that
    // client sent (e.g. a cascading delete of a binding it never saw).
    this.unsubLocal = this.doc.subscribeLocalUpdates((bytes) => this.broadcast(encode(Frame.Update, bytes), null))
  }

  connect(t: Transport): void {
    this.clients.add(t)
    t.onMessage((frame) => this.onFrame(t, frame))
    t.onClose(() => this.clients.delete(t))
  }

  private onFrame(from: Transport, frame: Uint8Array): void {
    const { tag, payload } = decode(frame)
    if (tag === Frame.SyncRequest) {
      // Reply with exactly the delta this client is missing.
      from.send(encode(Frame.Update, this.doc.exportUpdate(payload)))
    } else if (tag === Frame.Update) {
      this.doc.import(payload)
      this.doc.repair()
      this.doc.commit() // fires subscribeLocalUpdates -> broadcast (see constructor)
      // Also relay the raw client delta to peers other than the sender (so peers
      // converge even on ops that produced no server-local repair delta).
      this.broadcast(frame, from)
    }
    // Frame.Presence: B5. Unknown tags: deliberately ignored.
  }

  private broadcast(frame: Uint8Array, except: Transport | null): void {
    for (const c of this.clients) if (c !== except) c.send(frame)
  }

  snapshot(): Uint8Array { return this.doc.exportSnapshot() }

  /** Release the local-updates subscription. Connected client transports are
   * left alone (the server does not own their lifecycle). */
  close(): void { this.unsubLocal() }
}
