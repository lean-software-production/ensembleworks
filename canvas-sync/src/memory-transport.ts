import type { Transport } from './protocol.js'
// A synchronous, loss-free, in-order transport pair for deterministic tests.
// makePair() returns [a, b]; bytes sent on a arrive on b's onMessage, same tick.
export function makePair(): [Transport, Transport] {
  let aMsg: ((b: Uint8Array) => void) | null = null
  let bMsg: ((b: Uint8Array) => void) | null = null
  let aClose: (() => void) | null = null
  let bClose: (() => void) | null = null
  let open = true
  const a: Transport = {
    send: (bytes) => { if (open) bMsg?.(bytes) },
    onMessage: (cb) => { aMsg = cb }, onClose: (cb) => { aClose = cb },
    close: () => { if (open) { open = false; aClose?.(); bClose?.() } },
  }
  const b: Transport = {
    send: (bytes) => { if (open) aMsg?.(bytes) },
    onMessage: (cb) => { bMsg = cb }, onClose: (cb) => { bClose = cb },
    close: () => { if (open) { open = false; aClose?.(); bClose?.() } },
  }
  return [a, b]
}
