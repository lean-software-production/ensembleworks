/**
 * Gateway registry + relay splice core for remote terminal gateways
 * (spike spec: docs/superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md).
 *
 * A remote connector dials ONE outbound WS to /api/gateway/connect; browsers
 * attach at /api/term/relay?gateway=… and are spliced onto that WS as
 * multiplexed channels. This module is the pure core — sockets are duck-typed
 * (RelaySocket) so the whole thing unit-tests with fakes; the HTTP/WS upgrade
 * wiring lives in createGatewayPlane() (added in the next slice).
 *
 * Wire protocol (canvas ↔ connector):
 *   text JSON  canvas→connector: {type:'relay-open',channelId,sessionId,cols,rows}
 *                                {type:'relay-close',channelId}
 *                                {type:'relay-msg',channelId,msg}   (browser's input/resize)
 *   text JSON  connector→canvas: {type:'relay-msg',channelId,msg}   (attached/resize/exit)
 *                                {type:'relay-closed',channelId}
 *   binary     connector→canvas: 4-byte BE uint32 channelId prefix + raw pty bytes
 */

import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { resolveGatewayOwner } from './whoami.ts'

export const WS_OPEN = 1
// A browser that can't drain 4 MB is closed rather than buffered forever —
// its reconnect-with-backoff re-attaches; full flow control is out of spike scope.
export const BROWSER_BUFFER_LIMIT = 4 * 1024 * 1024

// Structural socket type so ws.WebSocket satisfies it and tests can use fakes.
export interface RelaySocket {
	readyState: number
	bufferedAmount: number
	send(data: string | Buffer, opts?: { binary?: boolean }): void
	close(): void
}

export interface GatewayEntry {
	gatewayId: string
	label: string
	ws: RelaySocket
	ownerIdentity: string
	connectedAt: number
	channels: Map<number, RelaySocket>
	nextChannelId: number
}

export function encodeBinaryFrame(channelId: number, payload: Buffer): Buffer {
	const prefix = Buffer.allocUnsafe(4)
	prefix.writeUInt32BE(channelId >>> 0, 0)
	return Buffer.concat([prefix, payload])
}

export function decodeBinaryFrame(frame: Buffer): { channelId: number; payload: Buffer } | null {
	if (frame.byteLength < 4) return null
	return { channelId: frame.readUInt32BE(0), payload: frame.subarray(4) }
}

export class GatewayRegistry {
	private gateways = new Map<string, GatewayEntry>()

	/** Connect-equals-register, bound to the caller's identity. A reconnect by the
	 * SAME owner replaces the live id (old socket + riding browsers closed; their
	 * client-side backoff re-establishes channels). A connect by a DIFFERENT owner
	 * is rejected (returns null) and leaves the existing gateway untouched. */
	connect(gatewayId: string, label: string, ws: RelaySocket, ownerIdentity: string): GatewayEntry | null {
		const existing = this.gateways.get(gatewayId)
		if (existing && existing.ownerIdentity !== ownerIdentity) return null
		if (existing) {
			for (const browser of existing.channels.values()) browser.close()
			existing.channels.clear()
			existing.ws.close()
		}
		const entry: GatewayEntry = {
			gatewayId,
			label,
			ws,
			ownerIdentity,
			connectedAt: Date.now(),
			channels: new Map(),
			nextChannelId: 1,
		}
		this.gateways.set(gatewayId, entry)
		return entry
	}

	/** Deregistration checks SOCKET IDENTITY, not just id — the replaced
	 * socket's close event fires asynchronously after the new registration and
	 * must not delete it. */
	disconnect(gatewayId: string, ws: RelaySocket): void {
		const entry = this.gateways.get(gatewayId)
		if (!entry || entry.ws !== ws) return
		for (const browser of entry.channels.values()) browser.close()
		this.gateways.delete(gatewayId)
	}

	get(gatewayId: string): GatewayEntry | undefined {
		return this.gateways.get(gatewayId)
	}

	// Field names match distributed-terminals-design.md's envelope so the
	// dropdown survives the upgrade to the full design.
	list(): Array<{ gatewayId: string; label: string; relayOnly: true; connectedAt: number }> {
		return [...this.gateways.values()].map((e) => ({
			gatewayId: e.gatewayId,
			label: e.label,
			relayOnly: true,
			connectedAt: e.connectedAt,
		}))
	}
}

export function openChannel(
	entry: GatewayEntry,
	browser: RelaySocket,
	sessionId: string,
	cols: number,
	rows: number
): number {
	const channelId = entry.nextChannelId++
	entry.channels.set(channelId, browser)
	entry.ws.send(JSON.stringify({ type: 'relay-open', channelId, sessionId, cols, rows }))
	return channelId
}

export function closeChannel(entry: GatewayEntry, channelId: number): void {
	if (!entry.channels.delete(channelId)) return
	if (entry.ws.readyState === WS_OPEN) {
		entry.ws.send(JSON.stringify({ type: 'relay-close', channelId }))
	}
}

/** Browser → gateway: wrap the inner text message (input/resize) as relay-msg. */
export function onBrowserMessage(entry: GatewayEntry, channelId: number, raw: string): void {
	let msg: unknown
	try {
		msg = JSON.parse(raw)
	} catch {
		return
	}
	if (entry.ws.readyState === WS_OPEN) {
		entry.ws.send(JSON.stringify({ type: 'relay-msg', channelId, msg }))
	}
}

/** Gateway → browser: binary output by channel prefix; relay-msg unwrapped to a
 * text frame (the client dispatches on frame type); relay-closed closes. */
export function onGatewayFrame(entry: GatewayEntry, data: Buffer, isBinary: boolean): void {
	if (isBinary) {
		const decoded = decodeBinaryFrame(data)
		if (!decoded) return
		const browser = entry.channels.get(decoded.channelId)
		if (!browser || browser.readyState !== WS_OPEN) return
		if (browser.bufferedAmount > BROWSER_BUFFER_LIMIT) {
			entry.channels.delete(decoded.channelId)
			browser.close()
			return
		}
		browser.send(decoded.payload, { binary: true })
		return
	}
	let msg: { type?: string; channelId?: number; msg?: unknown }
	try {
		msg = JSON.parse(data.toString())
	} catch {
		return
	}
	if (typeof msg.channelId !== 'number') return
	const browser = entry.channels.get(msg.channelId)
	if (msg.type === 'relay-msg') {
		if (browser && browser.readyState === WS_OPEN) browser.send(JSON.stringify(msg.msg))
	} else if (msg.type === 'relay-closed') {
		entry.channels.delete(msg.channelId)
		browser?.close()
	}
}

// ---------------------------------------------------------------------------
// HTTP/WS wiring — createSyncApp mounts listHandler and calls handleUpgrade
// before its /sync matching. Kept here so app.ts gains only two lines.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-zA-Z0-9_-]{1,48}$/
const HEARTBEAT_INTERVAL_MS = 20_000

export function createGatewayPlane() {
	const registry = new GatewayRegistry()
	const wss = new WebSocketServer({ noServer: true })
	const alive = new WeakMap<WebSocket, boolean>()

	// Same half-open detection as the terminal gateway: unanswered ping → kill.
	const heartbeat = setInterval(() => {
		for (const ws of wss.clients) {
			if (ws.readyState !== ws.OPEN) continue
			if (alive.get(ws) === false) {
				ws.terminate()
				continue
			}
			alive.set(ws, false)
			ws.ping()
		}
	}, HEARTBEAT_INTERVAL_MS)
	heartbeat.unref()

	function accept(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<WebSocket> {
		;(socket as Socket).setNoDelay(true)
		return new Promise((resolve) => {
			wss.handleUpgrade(req, socket, head, (ws) => {
				alive.set(ws, true)
				ws.on('pong', () => alive.set(ws, true))
				resolve(ws)
			})
		})
	}

	return {
		registry,

		listHandler(_req: unknown, res: { json(body: unknown): void }) {
			res.json({ gateways: registry.list() })
		},

		/** Returns true when it owned the upgrade (matched path), else false. */
		handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
			if (url.pathname === '/api/gateway/connect') {
				const gatewayId = url.searchParams.get('gatewayId') ?? ''
				if (!ID_RE.test(gatewayId)) {
					socket.destroy()
					return true
				}
				const label = (url.searchParams.get('label') || gatewayId).slice(0, 64)
				void (async () => {
					const owner = await resolveGatewayOwner(req.headers)
					if (owner === null) {
						// No resolvable identity (config error, or an anonymous/dev connect
						// to an authenticated instance) — refuse before upgrading.
						console.warn(`[gateway ${gatewayId}] rejected: no resolvable identity`)
						socket.destroy()
						return
					}
					const ws = await accept(req, socket, head)
					const entry = registry.connect(gatewayId, label, ws, owner)
					if (!entry) {
						console.warn(`[gateway ${gatewayId}] rejected: id owned by another identity`)
						ws.close(1008, 'gateway id owned by another identity')
						return
					}
					console.log(`[gateway ${gatewayId}] connected (${label}) as ${owner}`)
					ws.on('message', (data, isBinary) => onGatewayFrame(entry, data as Buffer, isBinary))
					ws.on('close', () => {
						registry.disconnect(gatewayId, ws)
						console.log(`[gateway ${gatewayId}] disconnected`)
					})
				})()
				return true
			}

			if (url.pathname === '/api/term/relay') {
				const sessionId = url.searchParams.get('session') ?? ''
				const gatewayId = url.searchParams.get('gateway') ?? ''
				const cols = Number(url.searchParams.get('cols') ?? 80) || 80
				const rows = Number(url.searchParams.get('rows') ?? 24) || 24
				const entry = registry.get(gatewayId)
				if (!ID_RE.test(sessionId) || !entry || entry.ws.readyState !== WS_OPEN) {
					socket.destroy() // offline gateway → immediate destroy (client backoff handles it)
					return true
				}
				void accept(req, socket, head).then((ws) => {
					const channelId = openChannel(entry, ws, sessionId, cols, rows)
					ws.on('message', (raw, isBinary) => {
						if (isBinary) return // browsers never send binary (matches terminal-gateway.ts)
						onBrowserMessage(entry, channelId, raw.toString())
					})
					ws.on('close', () => closeChannel(entry, channelId))
				})
				return true
			}

			return false
		},
	}
}
