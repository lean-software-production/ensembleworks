// Client side of the bb canvas transport. Deliberately UI-framework-free: no
// React, no bb SDK import — the caller injects `sendFrame` (an rpc call) and
// pushes inbound bytes in with `deliver`, so this module is unit-testable and
// the React layer stays a thin adapter.
//
//   outbound  transport.send(frame) -> sendFrame({ clientId, data })  [rpc canvas_frame]
//   inbound   useRealtime(CANVAS_CHANNEL, p => { const b = envelopeBytesFor(id, p);
//                                                if (b) transport.deliver(b) })
import type { Transport } from "@ensembleworks/canvas-sync";
import { base64ToBytes, bytesToBase64 } from "./canvas/base64.js";
import {
  CANVAS_CHANNEL,
  ROOM_ID,
  type CanvasEnvelope,
  type CanvasFramePayload,
  type CanvasIdentities,
  type CanvasResync,
  type CanvasServerHello,
  type CanvasServerMessage,
} from "./canvas/wire.js";

export {
  CANVAS_CHANNEL,
  ROOM_ID,
  type CanvasEnvelope,
  type CanvasFramePayload,
  type CanvasIdentities,
  type CanvasResync,
  type CanvasServerHello,
  type CanvasServerMessage,
};

export interface BbTransport extends Transport {
  readonly clientId: string;
  /** Feed one inbound frame (already base64-decoded and addressed to us). */
  deliver(bytes: Uint8Array): void;
  /** Resolve once every queued outbound frame has been sent. Tests and teardown. */
  flush(): Promise<void>;
  readonly isClosed: boolean;
}

export interface CreateBbTransportOptions {
  clientId: string;
  /** Post one frame to the backend — normally `rpc.call("canvas_frame", p)`. */
  sendFrame: (payload: CanvasFramePayload) => Promise<unknown>;
  /** Send failures are reported here rather than becoming unhandled rejections. */
  onError?: (error: unknown) => void;
}

export function createBbTransport(
  options: CreateBbTransportOptions,
): BbTransport {
  const { clientId, sendFrame, onError } = options;
  let onMessageCb: ((bytes: Uint8Array) => void) | null = null;
  let onCloseCb: (() => void) | null = null;
  let closed = false;
  // rpc calls are async, but canvas-sync frames MUST arrive in order (the
  // SyncRequest handshake and every Update depend on it), so outbound frames
  // go through one serial promise chain rather than racing.
  let chain: Promise<void> = Promise.resolve();

  return {
    clientId,
    get isClosed() {
      return closed;
    },

    send(bytes: Uint8Array): void {
      if (closed) return;
      // Encode eagerly: `bytes` may alias a buffer the caller reuses, and this
      // send is not performed until the chain drains.
      const data = bytesToBase64(bytes);
      chain = chain.then(async () => {
        if (closed) return;
        try {
          await sendFrame({ clientId, data });
        } catch (error) {
          onError?.(error);
        }
      });
    },

    onMessage(cb: (bytes: Uint8Array) => void): void {
      onMessageCb = cb;
    },

    onClose(cb: () => void): void {
      onCloseCb = cb;
    },

    close(): void {
      if (closed) return;
      // Closed flag first, so a listener calling close() reentrantly is a
      // no-op and post-close sends are silently dropped (Transport contract).
      closed = true;
      const cb = onCloseCb;
      onCloseCb = null;
      cb?.();
    },

    deliver(bytes: Uint8Array): void {
      if (closed) return;
      onMessageCb?.(bytes);
    },

    async flush(): Promise<void> {
      // Awaiting can enqueue more work (a frame handler that writes), so keep
      // draining until the chain stops growing.
      let seen: Promise<void>;
      do {
        seen = chain;
        await seen;
      } while (seen !== chain);
    },
  };
}

/**
 * Decode a realtime payload addressed to `clientId`, or null when the envelope
 * is for someone else or malformed. realtime is broadcast-only, so every
 * client sees every publish and filters here.
 */
export function envelopeBytesFor(
  clientId: string,
  payload: unknown,
): Uint8Array | null {
  if (typeof payload !== "object" || payload === null) return null;
  const envelope = payload as Partial<CanvasEnvelope>;
  if (envelope.to !== clientId) return null;
  if (typeof envelope.data !== "string") return null;
  try {
    return base64ToBytes(envelope.data);
  } catch {
    return null;
  }
}

/**
 * The load epoch of a `CanvasServerHello` payload, or null when this realtime
 * payload is not one. Shares CANVAS_CHANNEL with frame envelopes, so both
 * decoders run against every publish and exactly one of them matches.
 */
export function serverHelloEpoch(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const epoch = (payload as Partial<CanvasServerHello>).hello;
  return typeof epoch === "number" ? epoch : null;
}

/**
 * The clientId -> display-name map from a `CanvasIdentities` broadcast, or null
 * when this realtime payload is not one.
 *
 * Every value is checked: the map is rendered as cursor labels, and one
 * non-string would otherwise reach React as an object. A malformed entry is
 * dropped rather than failing the whole map — a peer with a bad name should
 * lose its label, not everyone else's.
 */
export function identitiesFrom(
  payload: unknown,
): Record<string, string> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const map = (payload as Partial<CanvasIdentities>).identities;
  if (typeof map !== "object" || map === null || Array.isArray(map)) return null;
  const out: Record<string, string> = {};
  for (const [clientId, name] of Object.entries(map)) {
    if (typeof name === "string" && name.length > 0) out[clientId] = name;
  }
  return out;
}

/**
 * True when this realtime payload is a `CanvasResync` addressed to us — the
 * server telling this client it is not in its client set and must re-handshake.
 *
 * Four decoders run against every publish on CANVAS_CHANNEL and at most one
 * may match: this one requires `resync === true`, `envelopeBytesFor` requires a
 * string `data`, `serverHelloEpoch` requires a numeric `hello`, and
 * `identitiesFrom` requires an `identities` object.
 */
export function isResyncFor(clientId: string, payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const message = payload as Partial<CanvasResync>;
  return message.resync === true && message.to === clientId;
}

/** A per-tab client address. Not a peer id — that is `newPeerId()`. */
export function newClientId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A random Loro peer id. Masked to 63 bits (Loro's peer id is u64, and staying
 * off the sign bit avoids surprises round-tripping through other layers) and
 * kept clear of the server's reserved `1n`.
 */
export function newPeerId(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  value &= (1n << 63n) - 1n;
  return value <= 1n ? value + 2n : value;
}
