import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { Frame, type Transport, decode, encode } from './protocol.js'
import type { PresenceStore } from './presence.js'

export interface SyncServerOpts {
  peerId: bigint
  initialSnapshot?: Uint8Array
  /** Optional: wires Frame.Presence — inbound frames are applied (if this
   * store is provided) and always relayed to other clients; connect() sends
   * a late-joiner bootstrap (encodeAll()) so a client joining mid-session
   * sees existing cursors immediately. Omitted entirely for rigs that only
   * care about docs — presence-less servers still relay Presence frames
   * between clients (see the onFrame Presence branch), they just don't track
   * state themselves or bootstrap late joiners. */
  presence?: PresenceStore
  /** Fired synchronously with the raw inbound Update payload whenever the frame
   * may carry ops this peer does not durably hold — i.e. when the import newly
   * applied ops (changed) OR parked them as pending (dependent on unseen
   * history). Fires BEFORE repair/commit/relay: durable-first — a persistence
   * layer (the room-host DocumentActor, Task C2) appends here so no peer can
   * observe a delta the server hasn't durably captured. NOT fired for no-op
   * imports (all ops already known) — reconnect full-history backfills don't
   * bloat the log. Plain Uint8Array callback: engine- and server-agnostic.
   *
   * Why pending fires too (same gate as the relay, deliberately): a PENDING
   * payload's ops exist nowhere durable — the server only cached them, and the
   * later gap-filler frame carries only its own bytes, so a changed-only log
   * would lose the pended ops on recovery. Loro replay handles out-of-order
   * logs (replaying pended-then-gap-filler converges). The invariant: persist
   * and relay exactly the frames that may carry ops we don't durably hold.
   *
   * The payload ALIASES the inbound frame buffer (decode() is zero-copy) —
   * copy if you retain it beyond the callback. */
  onUpdatePayload?: (payload: Uint8Array) => void
}

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
  private presence?: PresenceStore
  private unsubPresenceLocal?: () => void
  private closed = false
  /** Count of inbound Updates whose import reported pending (ops dependent on
   * history this doc hasn't seen). Should be ~0 in healthy operation — a
   * climbing value means clients are sending deltas out of causal order
   * (broken channel ordering or a buggy sender). Intended to be surfaced by
   * the D3 shadow-metrics endpoint. */
  get pendingImports(): number { return this.pendingCount }
  private pendingCount = 0
  private onUpdatePayload?: (payload: Uint8Array) => void

  constructor(opts: SyncServerOpts) {
    this.onUpdatePayload = opts.onUpdatePayload
    this.presence = opts.presence
    this.doc = opts.initialSnapshot
      ? LoroCanvasDoc.fromSnapshot(opts.initialSnapshot, { peerId: opts.peerId })
      : LoroCanvasDoc.create({ peerId: opts.peerId })
    // When the server's own doc changes (e.g. repair, or an agent write), push
    // the delta to every connected client — including the client whose Update
    // triggered it, since a repair delta can touch data beyond what that
    // client sent (e.g. a cascading delete of a binding it never saw).
    this.unsubLocal = this.doc.subscribeLocalUpdates((bytes) => this.broadcast(encode(Frame.Update, bytes), null))
    // Same pattern for presence: if THIS process publishes its own presence
    // (e.g. a future agent avatar), broadcast it to every connected client —
    // no `except` exclusion, mirroring the doc's local-update broadcast above
    // (the server is the writer here, not relaying someone else's frame).
    this.unsubPresenceLocal = this.presence?.onLocalUpdate((bytes) => this.broadcast(encode(Frame.Presence, bytes), null))
  }

  connect(t: Transport): void {
    // Lifecycle misuse is loud (fail-loud house convention, cf. storage-geometry).
    if (this.closed) throw new Error('SyncServerPeer is closed')
    this.clients.add(t)
    t.onMessage((frame) => this.onFrame(t, frame))
    t.onClose(() => this.clients.delete(t))
    // Late-joiner bootstrap: a client connecting mid-session must see existing
    // cursors immediately, not just future publishes — send the full presence
    // snapshot as a Presence frame right away. A small, deliberate extension
    // beyond the plan text (see Task B5 execution report).
    if (this.presence) t.send(encode(Frame.Presence, this.presence.encodeAll()))
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
      // Durable-first: hand the raw payload to the persistence layer BEFORE
      // repair/commit (whose subscribeLocalUpdates broadcast is the first
      // externally-visible effect) and before the relay — no peer may observe
      // a delta the server hasn't durably captured (prod tldraw parity:
      // persist → ack → broadcast). Same gate as the relay below, deliberately
      // — see SyncServerOpts.onUpdatePayload for the pending rationale.
      if (r.changed || r.pending) this.onUpdatePayload?.(payload)
      // Repair/commit are gated on `changed` alone: repair() costs O(doc) even
      // when the plan is empty (~7ms/call at 1k shapes, mostly list*() WASM
      // marshaling — see LoroCanvasDoc.repair's PERF note), and a pending
      // import applied NOTHING, so there is nothing to repair yet (the
      // gap-filling import that later applies the pended ops reports
      // changed: true and pays for repair then).
      if (r.changed) {
        this.doc.repair()
        // commit() fires subscribeLocalUpdates -> broadcast (see constructor).
        // ORDERING NOTE: this repair-delta broadcast reaches other clients
        // BEFORE the raw-frame relay below, so a repair delta can reference
        // ops a client hasn't received yet. Benign-by-pending: the client's
        // import reports pending, and the raw frame lands one step later
        // (same tick on the sync transport), converging it immediately.
        this.doc.commit()
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
    } else if (tag === Frame.Presence) {
      // Ephemeral bytes are cheap and idempotent — no changed-gating (unlike
      // Update). Apply for this server's own tracking/bootstrap (if a
      // presence store was wired) — a no-op otherwise — then ALWAYS relay to
      // every other client, so connected peers exchange presence even when
      // this server instance doesn't itself track presence state.
      this.presence?.apply(payload)
      this.broadcast(frame, from)
    }
    // Unknown tags: deliberately ignored.
  }

  private broadcast(frame: Uint8Array, except: Transport | null): void {
    for (const c of this.clients) if (c !== except) c.send(frame)
  }

  snapshot(): Uint8Array { return this.doc.exportSnapshot() }

  /** Real close: release the local-updates subscriptions (doc AND presence,
   * if wired) and close every connected transport (their onClose handlers
   * clear the client set). After this, connect() throws and inbound frames
   * are dropped. Idempotent. Does NOT destroy() an injected PresenceStore —
   * this peer doesn't own its lifecycle, only its own subscription to it. */
  close(): void {
    if (this.closed) return
    this.closed = true // set BEFORE closing transports: reentrant onFrame during teardown must see it
    this.unsubLocal()
    this.unsubPresenceLocal?.()
    for (const t of [...this.clients]) t.close()
    this.clients.clear()
  }
}
