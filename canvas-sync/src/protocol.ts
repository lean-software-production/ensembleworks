// Wire frames between a client peer and the room server peer. All payloads are
// raw bytes (Loro updates / version vectors / ephemeral encodings). Framing is a
// single tag byte + payload — no JSON, so Loro's binary rides intact.
export const Frame = { Update: 1, Presence: 2, SyncRequest: 3 } as const
export type Frame = (typeof Frame)[keyof typeof Frame]

/**
 * The transport seam every adapter (in-memory pair, ws in `server`) must honor:
 *
 * - `close()` is idempotent: repeat calls are no-ops.
 * - `onClose` fires at most once per side, and the closed flag is set BEFORE
 *   callbacks run — so a listener calling `close()` reentrantly is safe.
 * - After close, `send()` is a silent no-op: no delivery, no throw.
 *
 * The memory pair (`makePair`) is the reference implementation of this
 * contract; B3/B4 peers and the C3 ws adapter are built to it.
 */
export interface Transport {
  send(bytes: Uint8Array): void
  onMessage(cb: (bytes: Uint8Array) => void): void
  onClose(cb: () => void): void
  close(): void
}

export function encode(tag: Frame, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1)
  out[0] = tag
  out.set(payload, 1)
  return out
}
/**
 * Zero-copy: the returned `payload` ALIASES the input frame's buffer (subarray).
 * Callers that retain the payload must copy it if the frame buffer may be reused.
 */
export function decode(frame: Uint8Array): { tag: Frame; payload: Uint8Array } {
  if (frame.length < 1) throw new Error('empty frame')
  return { tag: frame[0] as Frame, payload: frame.subarray(1) }
}
