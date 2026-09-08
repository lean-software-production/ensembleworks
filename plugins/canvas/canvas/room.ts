// The authoritative room host: one SyncServerPeer per room, one Transport per
// connected client, and durable persistence behind both.
//
// bb has no plugin WebSocket surface, so the two directions of the canvas
// protocol ride different bb primitives:
//
//   client -> server   plugin rpc `canvas_frame` (base64 frame)  -> deliver()
//   server -> client   bb.realtime.publish(CANVAS_CHANNEL, { to, data })
//
// realtime is broadcast-only and server-publish-only, so every publish reaches
// every client; the `to` field is the address and clients drop anything that
// is not theirs. That is fine for a spike (frames are already CRDT deltas that
// a non-addressee would merely waste bytes on), but it is NOT a privacy
// boundary — noted as a known limitation.
import { SyncServerPeer, type Transport } from "@ensembleworks/canvas-sync";
import { bytesToBase64 } from "./base64.js";
import type { CanvasStore } from "./store.js";
import {
  ROOM_ID,
  type CanvasEnvelope,
  type CanvasServerMessage,
} from "./wire.js";

/** The server's own Loro peer id. Clients pick random ids and avoid this one. */
export const SERVER_PEER_ID = 1n;

/** Snapshot + truncate the log once this many updates have accumulated. */
export const COMPACT_EVERY = 200;

/**
 * A client that has neither sent a frame NOR pinged in this long is swept.
 *
 * The panel keeps itself inside this window with a `canvas_ping` keepalive
 * (CanvasPanel's KEEPALIVE_MS) precisely because a tab that is only being
 * WATCHED sends nothing: presence rides pointer movement, and doc updates ride
 * edits. Before the keepalive existed, such a tab was swept after two minutes
 * and then silently missed every subsequent update — it never learned it had
 * been dropped, so nothing re-handshook and only a page reload recovered.
 */
export const CLIENT_IDLE_MS = 2 * 60 * 1000;

/**
 * Server side of one client's connection. Honors the canvas-sync Transport
 * contract: close() is idempotent, the closed flag is set BEFORE onClose
 * callbacks run (so a reentrant close() from a listener is safe), and send()
 * after close is a silent no-op.
 */
class ClientTransport implements Transport {
  readonly clientId: string;
  #publish: (envelope: CanvasEnvelope) => void;
  #onMessage: ((bytes: Uint8Array) => void) | null = null;
  #onClose: Array<() => void> = [];
  #closed = false;

  constructor(clientId: string, publish: (envelope: CanvasEnvelope) => void) {
    this.clientId = clientId;
    this.#publish = publish;
  }

  send(bytes: Uint8Array): void {
    if (this.#closed) return;
    this.#publish({ to: this.clientId, data: bytesToBase64(bytes) });
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.#onMessage = cb;
  }

  onClose(cb: () => void): void {
    this.#onClose.push(cb);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const callbacks = this.#onClose;
    this.#onClose = [];
    for (const cb of callbacks) cb();
  }

  /** Inbound frame from this client's `canvas_frame` rpc call. */
  deliver(bytes: Uint8Array): void {
    if (this.#closed) return;
    this.#onMessage?.(bytes);
  }
}

interface ClientEntry {
  transport: ClientTransport;
  lastSeenMs: number;
  /** Display name from `canvas_join`, or null for a client that never gave one
   * (an auto-join, which carries no rpc input beyond the frame). Held ON the
   * entry rather than in a second map so a name can never outlive its client:
   * whatever removes the entry removes the name with it. */
  name: string | null;
}

export interface CanvasRoomHostOptions {
  store: CanvasStore;
  /** Wired to bb.realtime.publish(CANVAS_CHANNEL, message) by server.ts. */
  publish: (message: CanvasServerMessage) => void;
  room?: string;
  log?: (message: string) => void;
  compactEvery?: number;
  clientIdleMs?: number;
}

export class CanvasRoomHost {
  readonly peer: SyncServerPeer;
  readonly room: string;
  readonly #store: CanvasStore;
  readonly #publish: (message: CanvasServerMessage) => void;
  readonly #log: (message: string) => void;
  readonly #compactEvery: number;
  readonly #clientIdleMs: number;
  readonly #clients = new Map<string, ClientEntry>();
  #updatesSinceSnapshot: number;
  /** Highest canvas_updates.seq this host has read or written; bounds compaction. */
  #lastSeq = 0;
  #closed = false;

  constructor(options: CanvasRoomHostOptions) {
    this.room = options.room ?? ROOM_ID;
    this.#store = options.store;
    this.#publish = options.publish;
    this.#log = options.log ?? (() => {});
    this.#compactEvery = options.compactEvery ?? COMPACT_EVERY;
    this.#clientIdleMs = options.clientIdleMs ?? CLIENT_IDLE_MS;

    const snapshot = this.#store.loadSnapshot(this.room);
    this.peer = new SyncServerPeer({
      peerId: SERVER_PEER_ID,
      ...(snapshot === null ? {} : { initialSnapshot: snapshot }),
      // Durable-first: canvas-sync calls this BEFORE repair/commit/relay, so
      // no client can observe a delta we have not written down yet.
      onUpdatePayload: (payload) => {
        this.#lastSeq = this.#store.appendUpdate(this.room, payload);
        this.#updatesSinceSnapshot += 1;
      },
    });

    // Replay whatever accumulated after the snapshot. These imports go
    // straight at the doc, not through a frame, so onUpdatePayload does not
    // fire and the log is not duplicated.
    const logged = this.#store.loadUpdates(this.room);
    for (const update of logged) this.peer.doc.import(update.bytes);
    if (logged.length > 0) {
      this.peer.doc.repair();
      this.peer.doc.commit();
      this.#lastSeq = logged[logged.length - 1]!.seq;
    }
    this.#updatesSinceSnapshot = logged.length;
    this.#log(
      `room "${this.room}" restored: snapshot ${snapshot?.length ?? 0} bytes, ${logged.length} logged updates, ${this.peer.doc.listShapes().length} shapes`,
    );
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  get clientIds(): string[] {
    return [...this.#clients.keys()];
  }

  get pendingUpdates(): number {
    return this.#updatesSinceSnapshot;
  }

  /** Who is in the room: clientId -> display name, for every client that gave
   * one. This is exactly what `#publishIdentities` broadcasts. */
  get identities(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [clientId, entry] of this.#clients) {
      if (entry.name !== null) out[clientId] = entry.name;
    }
    return out;
  }

  /**
   * Attach a client. Re-joining an id that is already connected closes the
   * previous transport first — a page reload reuses nothing, and the stale
   * entry would otherwise linger until the idle sweep.
   *
   * `name` is this client's display name (see CanvasIdentities). Every join
   * broadcasts the resulting map, which is also how a NEWCOMER learns everyone
   * else's names: it does not need its own query, its own join is the trigger.
   */
  join(clientId: string, nowMs: number, name?: string | null): void {
    if (this.#closed) throw new Error("CanvasRoomHost is closed");
    this.#clients.get(clientId)?.transport.close();
    const transport = new ClientTransport(clientId, this.#publish);
    // Drop our own bookkeeping when the transport dies for any reason
    // (explicit leave, sweep, or peer.close()).
    transport.onClose(() => {
      if (this.#clients.get(clientId)?.transport === transport) {
        this.#clients.delete(clientId);
      }
    });
    this.#clients.set(clientId, {
      transport,
      lastSeenMs: nowMs,
      name: name ?? null,
    });
    this.peer.connect(transport);
    this.#publishIdentities();
  }

  /**
   * Refresh a client's last-seen without delivering anything — the
   * `canvas_ping` keepalive's only job. Returns false when this room does not
   * know the client, which is the answer that tells the panel to re-handshake
   * (see CanvasResync); deliberately NOT an auto-join, because a ping carries
   * no frame and re-joining alone would leave the client's peer believing it
   * was still in sync while the server silently held a newer doc.
   */
  touch(clientId: string, nowMs: number): boolean {
    if (this.#closed) return false;
    const entry = this.#clients.get(clientId);
    if (entry === undefined) return false;
    entry.lastSeenMs = nowMs;
    return true;
  }

  /**
   * Dispatch one inbound frame.
   *
   * Unknown clientId => AUTO-JOIN. A plugin reload rebuilds this host while
   * browser clients keep their SyncClientPeer alive, so their next frame would
   * otherwise be dropped until they noticed and re-joined. Auto-join makes the
   * client's own frame the reconnect. (The alternative — erroring — would need
   * a client-side retry loop we do not want in a spike.)
   *
   * Auto-join restores the DOWNSTREAM channel but cannot repair the client's
   * doc: whatever the room relayed while that client was absent is gone, and
   * its peer is not waiting on a handshake that would re-fetch it. So an
   * auto-join also pushes a CanvasResync, and the client answers with a real
   * reconnect. Without it, an evicted tab that later moved its mouse looked
   * reconnected while still rendering a stale document.
   */
  frame(clientId: string, bytes: Uint8Array, nowMs: number): void {
    if (this.#closed) return;
    let entry = this.#clients.get(clientId);
    if (entry === undefined) {
      this.join(clientId, nowMs);
      entry = this.#clients.get(clientId);
      if (entry === undefined) return;
      this.#publish({ to: clientId, resync: true });
    }
    entry.lastSeenMs = nowMs;
    entry.transport.deliver(bytes);
    // Compact here rather than inside onUpdatePayload: by now the peer has
    // finished import + repair + commit for this frame, so the snapshot we
    // take is fully current.
    this.#maybeCompact();
  }

  leave(clientId: string): void {
    if (!this.#clients.has(clientId)) return;
    this.#clients.get(clientId)?.transport.close();
    this.#clients.delete(clientId);
    // Peers stop seeing the departed client's cursor on their own (presence
    // expires), but the name map is ours to prune.
    this.#publishIdentities();
  }

  /** Close every client silent for longer than the idle window. */
  sweep(nowMs: number): number {
    let swept = 0;
    for (const [clientId, entry] of [...this.#clients]) {
      if (nowMs - entry.lastSeenMs <= this.#clientIdleMs) continue;
      entry.transport.close();
      this.#clients.delete(clientId);
      swept += 1;
    }
    if (swept > 0) {
      this.#log(`swept ${swept} idle canvas client(s)`);
      this.#publishIdentities();
    }
    return swept;
  }

  /** Force a snapshot + truncation of the log rows that snapshot covers. */
  compact(): void {
    this.#store.compact(this.room, this.peer.snapshot(), this.#lastSeq);
    this.#updatesSinceSnapshot = 0;
  }

  /** Idempotent: compact one last time, then detach every client. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.compact();
    } catch (error) {
      this.#log(`final compaction failed: ${String(error)}`);
    }
    this.peer.close(); // closes every client transport, which clears #clients
    this.#clients.clear();
  }

  /** Broadcast the whole name map. Whole-map rather than a delta because it is
   * a handful of short strings and a client that missed one delta would carry a
   * wrong label indefinitely; the next broadcast repairs any client. */
  #publishIdentities(): void {
    if (this.#closed) return;
    this.#publish({ identities: this.identities });
  }

  #maybeCompact(): void {
    if (this.#updatesSinceSnapshot < this.#compactEvery) return;
    this.compact();
    this.#log(`compacted room "${this.room}"`);
  }
}
