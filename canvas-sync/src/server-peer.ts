import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { Frame, type Transport, decode, encode } from './protocol.js'

export interface SyncServerOpts { peerId: bigint; initialSnapshot?: Uint8Array }

// One authoritative peer per room. Transport-agnostic: server.connect(transport)
// registers a client; the server never imports ws. Every merge is followed by
// repair so the server's converged state is canonical. close() detaches
// everything (unsubscribes, closes every client transport): a closed peer
// neither serves nor mutates — connect() after close throws, in-flight frames
// during teardown are silently dropped.
export class SyncServerPeer {
  readonly doc: LoroCanvasDoc
  private clients = new Set<Transport>()
  private unsubLocal: () => void
  private closed = false
  /** Count of inbound Updates whose import reported pending (ops dependent on
   * history this doc hasn't seen). Should be ~0 in healthy operation — a
   * climbing value means clients are sending deltas out of causal order
   * (broken channel ordering or a buggy sender). Intended to be surfaced by
   * the D3 shadow-metrics endpoint. */
  get pendingImports(): number { return this.pendingCount }
  private pendingCount = 0

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
    // Lifecycle misuse is loud (fail-loud house convention, cf. storage-geometry).
    if (this.closed) throw new Error('SyncServerPeer is closed')
    this.clients.add(t)
    t.onMessage((frame) => this.onFrame(t, frame))
    t.onClose(() => this.clients.delete(t))
  }

  private onFrame(from: Transport, frame: Uint8Array): void {
    // In-flight frames during/after teardown are not misuse (a real ws can
    // deliver buffered frames post-close) — drop them silently.
    if (this.closed) return
    const { tag, payload } = decode(frame)
    if (tag === Frame.SyncRequest) {
      // Reply with exactly the delta this client is missing.
      from.send(encode(Frame.Update, this.doc.exportUpdate(payload)))
    } else if (tag === Frame.Update) {
      const r = this.doc.import(payload)
      if (r.pending) this.pendingCount++
      // Repair/commit are gated on `changed` alone: repair() costs O(doc) even
      // when the plan is empty (~7ms/call at 1k shapes, mostly list*() WASM
      // marshaling — see LoroCanvasDoc.repair's PERF note), and a pending
      // import applied NOTHING, so there is nothing to repair yet (the
      // gap-filling import that later applies the pended ops reports
      // changed: true and pays for repair then).
      if (r.changed) {
        this.doc.repair()
        this.doc.commit() // fires subscribeLocalUpdates -> broadcast (see constructor)
      }
      // Relay the raw client delta to peers other than the sender (so peers
      // converge even on ops that produced no server-local repair delta).
      // changed: false covers TWO very different cases and only one may skip:
      // - No-op import (changed: false, pending: false): the server already
      //   had every op, and each was already propagated when the server FIRST
      //   acquired it — via this relay + the repair-delta broadcast (client
      //   Update), via the local-updates broadcast (server-local write), or
      //   via the SyncRequest handshake reply every client performs on
      //   connect/reconnect (ops predating the client's connection, incl.
      //   initialSnapshot history). Re-relaying would only multiply redundant
      //   frames — skip.
      // - PENDING import (changed: false, pending: true): the ops are only
      //   CACHED, dependent on history the server hasn't seen — the server
      //   does NOT hold them, so nothing else will ever carry them to the
      //   other clients (the later gap-filler relay carries only its own
      //   bytes). MUST relay, so observers pend the same frame identically
      //   and converge the moment the gap fills.
      if (r.changed || r.pending) this.broadcast(frame, from)
    }
    // Frame.Presence: B5. Unknown tags: deliberately ignored.
  }

  private broadcast(frame: Uint8Array, except: Transport | null): void {
    for (const c of this.clients) if (c !== except) c.send(frame)
  }

  snapshot(): Uint8Array { return this.doc.exportSnapshot() }

  /** Real close: release the local-updates subscription and close every
   * connected transport (their onClose handlers clear the client set). After
   * this, connect() throws and inbound frames are dropped. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true // set BEFORE closing transports: reentrant onFrame during teardown must see it
    this.unsubLocal()
    for (const t of [...this.clients]) t.close()
    this.clients.clear()
  }
}
