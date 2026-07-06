/**
 * RelayMux — a port of gateway-go/relay/relay.go's serveOnce/runChannel. Parses
 * each canvas→connector text frame, runs a per-channel FIFO ChannelQueue (depth
 * RELAY_CHANNEL_QUEUE_DEPTH, sheds rather than blocks), and dispatches into the
 * session manager; the per-channel sink writes back over the shared WS.
 *
 * Shed honesty (spec §6.2): in Go the shed branch is genuinely reachable (a slow
 * runChannel goroutine + a bursting read loop fill the 64-deep channel). In
 * single-threaded Bun ChannelQueue drains synchronously inside enqueue(), so the
 * real dispatch path never holds more than the item being pumped — the depth-64
 * shed is behaviourally unreachable except under reentrancy. The connector thus
 * has STRONGER liveness than Go (nothing can block the read loop) while keeping
 * the charter-pinned mechanism + cap as a guard rail (load-bearing again the day
 * dispatch goes async). mux.test.ts validates the structure, not a hot path.
 */
import { RELAY_CHANNEL_QUEUE_DEPTH } from '@ensembleworks/contracts/relay-parity'
import { encodeBinaryFrame } from './frame.ts'
import type { ChannelSink, ConnectorSessionManager } from './session.ts'

/** The minimal shared-WS surface the mux writes to (ws.WebSocket satisfies it). */
export interface WsLike {
	send(data: string | Buffer, opts?: { binary?: boolean }): void
}

interface Control {
	type: string
	channelId: number
	sessionId?: string
	cols?: number
	rows?: number
	msg?: unknown
}

/** A per-channel FIFO with a hard depth cap. enqueue() returns false (sheds)
 *  when full — the shared read loop must never block on one slow channel
 *  (relay.go's `default:` on the 64-deep channel). */
export class ChannelQueue {
	private items: Control[] = []
	private draining = false
	private closed = false
	constructor(private readonly onItem: (c: Control) => void, private readonly max = RELAY_CHANNEL_QUEUE_DEPTH) {}
	enqueue(c: Control): boolean {
		if (this.closed || this.items.length >= this.max) return false
		this.items.push(c)
		this.drain()
		return true
	}
	private drain(): void {
		if (this.draining) return
		this.draining = true
		while (this.items.length) this.onItem(this.items.shift()!)
		this.draining = false
	}
	close(): void {
		this.closed = true
		this.items = []
	}
}

export class RelayMux {
	private workers = new Map<number, ChannelQueue>()
	constructor(private readonly ws: WsLike, private readonly mgr: ConnectorSessionManager) {}

	/** A canvas→connector frame. Binary frames are ignored (canvas→connector is
	 *  all text); non-JSON is ignored — both mirror serveOnce. */
	handle(data: Buffer | string, isBinary: boolean): void {
		if (isBinary) return
		let ctl: Control
		try {
			ctl = JSON.parse(typeof data === 'string' ? data : data.toString())
		} catch {
			return
		}
		switch (ctl.type) {
			case 'relay-open': {
				const q = new ChannelQueue((c) => this.run(ctl.sessionId!, ctl.channelId, c))
				this.workers.set(ctl.channelId, q)
				q.enqueue(ctl) // the open action is the queue's first item
				return
			}
			case 'relay-msg':
			case 'relay-close': {
				const q = this.workers.get(ctl.channelId)
				if (!q) return
				const sent = q.enqueue(ctl)
				if (ctl.type === 'relay-close') {
					this.workers.delete(ctl.channelId)
					if (!sent) q.close() // shed close: unblock a queue nothing will drain (relay.go 213–220)
				}
				return
			}
		}
	}

	private sink(channelId: number): ChannelSink {
		return {
			sendMsg: (inner) => this.ws.send(JSON.stringify({ type: 'relay-msg', channelId, msg: inner })),
			sendOutput: (payload) => this.ws.send(encodeBinaryFrame(channelId, payload), { binary: true }),
			close: () => this.ws.send(JSON.stringify({ type: 'relay-closed', channelId })),
		}
	}

	private run(sessionId: string, channelId: number, c: Control): void {
		switch (c.type) {
			case 'relay-open': {
				const sink = this.sink(channelId)
				if (!this.mgr.attach(sessionId, channelId, c.cols ?? 80, c.rows ?? 24, sink)) {
					this.ws.send(JSON.stringify({ type: 'relay-closed', channelId })) // attach failed
				}
				return
			}
			case 'relay-msg': {
				const inner = c.msg as { type?: string; data?: string; cols?: number; rows?: number }
				if (inner?.type === 'input') this.mgr.input(sessionId, channelId, inner.data ?? '')
				else if (inner?.type === 'resize') this.mgr.resize(sessionId, inner.cols ?? 0, inner.rows ?? 0)
				return
			}
			case 'relay-close':
				this.mgr.detach(sessionId, channelId)
				return
		}
	}
}
