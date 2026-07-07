/**
 * ConnectorSessionManager — a faithful TypeScript port of
 * gateway-go/session/session.go's Manager over the shared openTmuxSession
 * primitive. One TmuxSession per canvas session, fanned out to every attached
 * relay channel, with the resize-authority + scrollback-replay + exit-broadcast
 * semantics of session.go (which itself mirrors terminal-gateway.ts).
 *
 * Go's three mutex-protected invariants (get-or-create spawns exactly one pty;
 * attach's attached→replay→subscribe is atomic; input/resize are serialized)
 * hold for free in single-threaded Bun: openTmuxSession is synchronous and the
 * onData read-loop callback plus the mux handlers all run to completion on one
 * event-loop turn, so replay can neither interleave with live output nor drop
 * bytes. The `gone` flag is a defensive mirror (onExit synchronously deletes the
 * session before any later attach), preserved for parity.
 *
 * Trust boundary: the connector deliberately does NOT re-validate sessionId from
 * relay frames — the splicer's ID_RE gate (gateway-registry.ts:184,
 * [a-zA-Z0-9_-]{1,48}) rejects any bad id before a relay-open can exist, and
 * tmux exec-array semantics with the fixed `canvas-` prefix leave no
 * flag-injection surface. This is parity with gateway-go.
 */
import type { TermServerMessage } from '@ensembleworks/contracts'
import { clampTmuxGrid, type TmuxSession } from '@ensembleworks/contracts/session-manager'

const SCROLLBACK_LIMIT = 256 * 1024 // bytes replayed to a newly attached channel (session.go)

/** One attached viewer (a relay channel). Down-messages are the inner terminal
 *  protocol (attached/resize/exit); output is raw pty bytes; close tears down. */
export interface ChannelSink {
	sendMsg(inner: TermServerMessage): void
	sendOutput(payload: Buffer): void
	close(): void
}

export type SpawnFactory = (sessionId: string, cols: number, rows: number) => TmuxSession

interface SessionState {
	pty: TmuxSession
	ring: Buffer[]
	ringBytes: number
	channels: Map<number, ChannelSink>
	gone: boolean
}

export class ConnectorSessionManager {
	private sessions = new Map<string, SessionState>()
	constructor(private readonly spawn: SpawnFactory) {}

	private getOrCreate(id: string, cols: number, rows: number): SessionState {
		const existing = this.sessions.get(id)
		if (existing) return existing
		const grid = clampTmuxGrid(cols, rows) // session.go getOrCreate clamps BEFORE spawn; attached reports the clamped grid
		const pty = this.spawn(id, grid.cols, grid.rows) // canvasTmuxSpawnSpec inside; -A reattaches
		const s: SessionState = { pty, ring: [], ringBytes: 0, channels: new Map(), gone: false }
		pty.onData((data) => {
			const buf = Buffer.from(data, 'utf8')
			s.ring.push(buf)
			s.ringBytes += buf.byteLength
			while (s.ringBytes > SCROLLBACK_LIMIT && s.ring.length > 1) s.ringBytes -= s.ring.shift()!.byteLength
			for (const sink of s.channels.values()) sink.sendOutput(buf)
		})
		pty.onExit(() => {
			s.gone = true
			for (const sink of s.channels.values()) {
				sink.sendMsg({ type: 'exit' })
				sink.close()
			}
			s.channels.clear()
			if (this.sessions.get(id) === s) this.sessions.delete(id)
		})
		this.sessions.set(id, s)
		return s
	}

	/** attached carries the SESSION's size (a newcomer's grid must not resize
	 *  existing viewers), then the scrollback ring, then subscribe. */
	attach(id: string, channelId: number, cols: number, rows: number, sink: ChannelSink): boolean {
		const s = this.getOrCreate(id, cols, rows)
		if (s.gone) return false
		sink.sendMsg({ type: 'attached', cols: s.pty.cols, rows: s.pty.rows })
		for (const chunk of s.ring) sink.sendOutput(chunk)
		s.channels.set(channelId, sink)
		return true
	}

	input(id: string, channelId: number, data: string): void {
		const s = this.sessions.get(id)
		if (s && !s.gone && s.channels.has(channelId)) s.pty.write(data)
	}

	/** Session-authoritative resize: TmuxSession.resize clamps+dedups and returns
	 *  whether the grid changed; only then fan out the new size to every viewer. */
	resize(id: string, cols: number, rows: number): void {
		const s = this.sessions.get(id)
		if (!s || s.gone) return
		if (!s.pty.resize(cols, rows)) return
		for (const sink of s.channels.values()) sink.sendMsg({ type: 'resize', cols: s.pty.cols, rows: s.pty.rows })
	}

	detach(id: string, channelId: number): void {
		this.sessions.get(id)?.channels.delete(channelId)
	}

	/** Relay disconnect: drop every viewer, keep the ptys — tmux sessions must
	 *  survive connector↔canvas link failures (session.go DetachAll). On process
	 *  exit the ptys (tmux CLIENTS) get SIGHUP and detach; the tmux server keeps
	 *  the sessions alive for the next connect (-A reattaches). */
	detachAll(): void {
		for (const s of this.sessions.values()) {
			for (const sink of s.channels.values()) sink.close()
			s.channels.clear()
		}
	}
}
