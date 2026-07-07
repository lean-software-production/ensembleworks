/**
 * Byte-identical mirror of server/src/gateway-registry.ts's encodeBinaryFrame:
 * a 4-byte big-endian uint32 channelId prefix + the raw payload. Duplicated
 * (not imported) to keep the connector out of the server workspace; a later
 * slice may lift both copies into contracts (spec R3). Pinned on this side by
 * mux.test.ts, on the server side by gateway-registry.test.ts.
 */
export function encodeBinaryFrame(channelId: number, payload: Buffer): Buffer {
	const prefix = Buffer.allocUnsafe(4)
	prefix.writeUInt32BE(channelId >>> 0, 0)
	return Buffer.concat([prefix, payload])
}
