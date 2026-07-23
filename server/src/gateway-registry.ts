/**
 * Gateway registry + relay splice core for remote terminal gateways
 * (spike spec: docs/superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md).
 *
 * A remote connector dials ONE outbound WS to /api/terminal/connect; browsers
 * attach at /api/terminal/relay?gateway=… and are spliced onto that WS as
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

import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
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

export type GatewayInputPolicy = 'locked' | 'shared'

/** Codespace metadata riding the registration (EW Codespaces spec §4). */
export interface GatewayMeta {
	repo?: string
	branch?: string
}

/** A spliced browser channel: the socket plus the viewer identity resolved at
 * relay attach (null = no resolvable identity → treated as non-owner). */
export interface RelayChannel {
	socket: RelaySocket
	viewer: string | null
}

export interface GatewayEntry {
	gatewayId: string
	label: string
	ws: RelaySocket
	ownerIdentity: string
	connectedAt: number
	// Codespace metadata (spec §4): present iff the registration carried it.
	repo?: string
	branch?: string
	// Owner-controlled input ACL. Default: locked for codespaces (repo present),
	// shared for plain gateways — preserving pre-SP3 behavior exactly.
	inputPolicy: GatewayInputPolicy
	channels: Map<number, RelayChannel>
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

	// Input policy keyed by gatewayId — survives reconnects AND disconnects
	// within a server lifetime; resets to the repo-derived default on restart
	// (safe direction: a codespace resets to locked). Decision log, SP3 item 3.
	private policies = new Map<string, GatewayInputPolicy>()

	/** Connect-equals-register, bound to the caller's identity. A reconnect by the
	 * SAME owner replaces the live id (old socket + riding browsers closed; their
	 * client-side backoff re-establishes channels). A connect by a DIFFERENT owner
	 * is rejected (returns null) and leaves the existing gateway untouched. */
	connect(
		gatewayId: string,
		label: string,
		ws: RelaySocket,
		ownerIdentity: string,
		meta: GatewayMeta = {}
	): GatewayEntry | null {
		const existing = this.gateways.get(gatewayId)
		if (existing && existing.ownerIdentity !== ownerIdentity) return null
		if (existing) {
			for (const ch of existing.channels.values()) ch.socket.close()
			existing.channels.clear()
			existing.ws.close()
		}
		const entry: GatewayEntry = {
			gatewayId,
			label,
			ws,
			ownerIdentity,
			connectedAt: Date.now(),
			repo: meta.repo,
			branch: meta.branch,
			inputPolicy: this.policies.get(gatewayId) ?? (meta.repo ? 'locked' : 'shared'),
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
		for (const ch of entry.channels.values()) ch.socket.close()
		this.gateways.delete(gatewayId)
	}

	get(gatewayId: string): GatewayEntry | undefined {
		return this.gateways.get(gatewayId)
	}

	/** Owner-authorised policy flip (the HTTP endpoint enforces WHO may call
	 * this; the registry just records it). False when the gateway is offline. */
	setInputPolicy(gatewayId: string, policy: GatewayInputPolicy): boolean {
		const entry = this.gateways.get(gatewayId)
		if (!entry) return false
		entry.inputPolicy = policy
		this.policies.set(gatewayId, policy)
		return true
	}

	// Field names match distributed-terminals-design.md's envelope so the
	// dropdown survives the upgrade to the full design. repo/branch/inputPolicy/
	// owner are the SP3 codespace fields — live state deliberately lives HERE,
	// not in synced shape props (decision log, SP3 item 2).
	list(): Array<{
		gatewayId: string
		label: string
		relayOnly: true
		connectedAt: number
		repo?: string
		branch?: string
		inputPolicy: GatewayInputPolicy
		owner: string
	}> {
		return [...this.gateways.values()].map((e) => ({
			gatewayId: e.gatewayId,
			label: e.label,
			relayOnly: true,
			connectedAt: e.connectedAt,
			repo: e.repo,
			branch: e.branch,
			inputPolicy: e.inputPolicy,
			owner: e.ownerIdentity,
		}))
	}
}

export function openChannel(
	entry: GatewayEntry,
	browser: RelaySocket,
	sessionId: string,
	cols: number,
	rows: number,
	viewer: string | null
): number {
	const channelId = entry.nextChannelId++
	entry.channels.set(channelId, { socket: browser, viewer })
	entry.ws.send(JSON.stringify({ type: 'relay-open', channelId, sessionId, cols, rows }))
	return channelId
}

export function closeChannel(entry: GatewayEntry, channelId: number): void {
	if (!entry.channels.delete(channelId)) return
	if (entry.ws.readyState === WS_OPEN) {
		entry.ws.send(JSON.stringify({ type: 'relay-close', channelId }))
	}
}

/** Browser → gateway: wrap the inner text message (input/resize) as relay-msg.
 * THE input-ACL enforcement point (spec §4): when the gateway is locked and the
 * channel's viewer is not the owner, `input` frames are dropped HERE — output
 * and resize still flow, and client-side read-only badges are decoration only. */
export function onBrowserMessage(entry: GatewayEntry, channelId: number, raw: string): void {
	let msg: unknown
	try {
		msg = JSON.parse(raw)
	} catch {
		return
	}
	const channel = entry.channels.get(channelId)
	if (!channel) return
	if ((msg as { type?: unknown }).type === 'input' && entry.inputPolicy === 'locked') {
		const isOwner = channel.viewer !== null && channel.viewer === entry.ownerIdentity
		if (!isOwner) return // dropped at the relay — the server is the authority
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
		const channel = entry.channels.get(decoded.channelId)
		if (!channel || channel.socket.readyState !== WS_OPEN) return
		if (channel.socket.bufferedAmount > BROWSER_BUFFER_LIMIT) {
			entry.channels.delete(decoded.channelId)
			channel.socket.close()
			return
		}
		channel.socket.send(decoded.payload, { binary: true })
		return
	}
	let msg: { type?: string; channelId?: number; msg?: unknown }
	try {
		msg = JSON.parse(data.toString())
	} catch {
		return
	}
	if (typeof msg.channelId !== 'number') return
	const channel = entry.channels.get(msg.channelId)
	if (msg.type === 'relay-msg') {
		if (channel && channel.socket.readyState === WS_OPEN) channel.socket.send(JSON.stringify(msg.msg))
	} else if (msg.type === 'relay-closed') {
		entry.channels.delete(msg.channelId)
		channel?.socket.close()
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

		async listHandler(req: { headers: IncomingHttpHeaders }, res: { json(body: unknown): void }) {
			const viewer = await resolveGatewayOwner(req.headers).catch(() => null)
			res.json({
				gateways: registry.list().map((g) => ({
					...g,
					viewerIsOwner: viewer !== null && viewer === g.owner,
				})),
			})
		},

		/** Returns true when it owned the upgrade (matched path), else false. */
		handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
			if (url.pathname === '/api/terminal/connect') {
				const gatewayId = url.searchParams.get('gatewayId') ?? ''
				if (!ID_RE.test(gatewayId)) {
					socket.destroy()
					return true
				}
				const label = (url.searchParams.get('label') || gatewayId).slice(0, 64)
				// Codespace metadata (SP3): free-text, capped; absence keeps the
				// gateway on the plain/shared path (decision log item 3).
				const repo = (url.searchParams.get('repo') || '').slice(0, 128) || undefined
				const branch = (url.searchParams.get('branch') || '').slice(0, 128) || undefined
				void (async () => {
					try {
						const owner = await resolveGatewayOwner(req.headers)
						if (owner === null) {
							// No resolvable identity (config error, or an anonymous/dev connect
							// to an authenticated instance) — refuse before upgrading.
							console.warn(`[gateway ${gatewayId}] rejected: no resolvable identity`)
							socket.destroy()
							return
						}
						const ws = await accept(req, socket, head)
						const entry = registry.connect(gatewayId, label, ws, owner, { repo, branch })
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
					} catch (err) {
						// Fail closed: never leave an unidentified upgrade half-open.
						console.warn(`[gateway ${gatewayId}] connect failed:`, err)
						socket.destroy()
					}
				})()
				return true
			}

			if (url.pathname === '/api/terminal/relay') {
				const sessionId = url.searchParams.get('session') ?? ''
				const gatewayId = url.searchParams.get('gateway') ?? ''
				const cols = Number(url.searchParams.get('cols') ?? 80) || 80
				const rows = Number(url.searchParams.get('rows') ?? 24) || 24
				const entry = registry.get(gatewayId)
				if (!ID_RE.test(sessionId) || !entry || entry.ws.readyState !== WS_OPEN) {
					socket.destroy() // offline gateway → immediate destroy (client backoff handles it)
					return true
				}
				void (async () => {
					try {
						// Viewer identity for the input ACL (spec §4). null is NOT a
						// rejection here — an unidentified viewer attaches read-only on
						// locked gateways; output always flows.
						const viewer = await resolveGatewayOwner(req.headers).catch(() => null)
						const ws = await accept(req, socket, head)
						if (entry.ws.readyState !== WS_OPEN) {
							// Gateway dropped while we resolved identity.
							ws.close()
							return
						}
						const channelId = openChannel(entry, ws, sessionId, cols, rows, viewer)
						ws.on('message', (raw, isBinary) => {
							if (isBinary) return // browsers never send binary (matches terminal-gateway.ts)
							onBrowserMessage(entry, channelId, raw.toString())
						})
						ws.on('close', () => closeChannel(entry, channelId))
					} catch (err) {
						console.warn(`[relay ${gatewayId}] attach failed:`, err)
						socket.destroy()
					}
				})()
				return true
			}

			return false
		},
	}
}
