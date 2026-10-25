// Base64 for the bb wire. Canvas sync frames are raw bytes, but bb's two
// plugin transports are JSON-only (rpc results / realtime payloads), so every
// frame rides as base64 in both directions.
//
// Isomorphic on purpose: this module is imported by the backend (server.ts,
// Node) AND by transport.ts (bundled into the frontend). btoa/atob are global
// in Node 18+ and in every browser, so neither side needs Buffer.

/** Chunked so a large frame cannot blow the argument-list limit. */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(
      ...(bytes.subarray(offset, offset + CHUNK) as unknown as number[]),
    );
  }
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
