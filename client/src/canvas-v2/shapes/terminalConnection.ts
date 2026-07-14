/**
 * The terminal shape's connection state machine — PURE (no React, no DOM,
 * no WebSocket, no timers) by design, so terminalConnection.test.ts can
 * drive every interleaving exhaustively under plain `bun`. TerminalShape.tsx
 * is a thin driver: it holds the actual Terminal/WebSocket/timer objects and
 * executes the ACTIONS this machine returns; ALL sequencing decisions —
 * what a stale socket event is, whether resume may open a socket, whether a
 * close schedules a retry — live here.
 *
 * WHY A MACHINE (review finding — the previous inline wiring's bugs all
 * stemmed from cross-effect isolation): the mount effect owned
 * connect/ended/attempt in closures the lifecycle-registration effect could
 * not reach, so onResume hand-rolled a SECOND, worse socket path — no retry
 * on drop (permanently dark tile), blind to `ended` (`tmux new -A`
 * resurrects a dead session as a fresh shell), and a resume racing the
 * suspend-close no-opped entirely (wsRef still held the closing socket),
 * leaving "Off-screen — paused" displayed while on-screen until backoff
 * expired. onmessage/onopen also lacked the disposal guard onclose had (an
 * in-flight PTY chunk could term.write() a disposed xterm).
 *
 * THE EPOCH is the whole trick: a monotonic counter bumped on every
 * connect/suspend/resume/dispose. Every socket handler captures the epoch
 * its socket was opened under and tags its events with it; the machine
 * drops any socket event whose epoch is not CURRENT. One rule kills the
 * whole class of stale-callback bugs — a suspend-closed socket's late
 * onclose can't schedule a retry over the resume's fresh socket, a
 * pre-dispose message can't reach a disposed xterm, and there is exactly
 * one connect path (resume dispatches the same 'connect'-shaped transition
 * the mount and the retry timer use, so backoff and `ended` are respected
 * everywhere by construction).
 *
 * STATUS MEANINGS:
 *   connecting — a socket is being opened (or a retry is pending; attempt>0
 *                distinguishes "reconnecting" for display)
 *   open       — gateway sent `attached` (the driver dispatches `opened` on
 *                the attached MESSAGE, not ws.onopen — "open" means the tmux
 *                session is actually usable, matching the legacy component's
 *                "live only on attached" display semantics)
 *   suspended  — off-screen; socket closed on purpose; resume reconnects
 *   ended      — gateway sent `exit`; FINAL apart from dispose (no event may
 *                open a socket again — resurrecting a dead tmux session via
 *                `tmux new -A` was interleaving (c) of the review)
 *   closed     — disposed; terminal in every sense, no event acts again
 */

export type TerminalConnStatus = 'connecting' | 'open' | 'suspended' | 'ended' | 'closed'

export interface TerminalConnState {
  /** Monotonic; bumped by connect/suspend/resume/dispose. Socket events
   * carry the epoch their socket was opened under; mismatch = stale = drop. */
  readonly epoch: number
  readonly status: TerminalConnStatus
  /** Consecutive failed connects since the last successful attach — feeds
   * reconnectDelayMs. Reset only by `opened`. */
  readonly attempt: number
}

export type TerminalConnEvent =
  | { type: 'connect' } // mount, or the retry timer firing
  | { type: 'opened'; epoch: number } // gateway `attached` received on this socket
  | { type: 'message'; epoch: number } // any socket message — guard-only (action `deliver` says "safe to touch term")
  | { type: 'closed'; epoch: number } // ws.onclose
  | { type: 'suspend' } // embed lifecycle: culled off-screen
  | { type: 'resume' } // embed lifecycle: back on-screen
  | { type: 'exit'; epoch: number } // gateway `exit` message: tmux session is gone
  | { type: 'dispose' } // React unmount

export type TerminalConnAction =
  | { type: 'openSocket'; epoch: number } // driver: open a WebSocket, tag its handlers with this epoch
  | { type: 'closeSocket' } // driver: close the current socket if any
  | { type: 'scheduleReconnect'; attempt: number } // driver: setTimeout(connect, reconnectDelayMs(attempt, rand))
  | { type: 'clearReconnect' } // driver: clear the pending retry timer
  | { type: 'deliver' } // driver: this message is current — parse it / term.write it

export interface TerminalConnTransition {
  readonly state: TerminalConnState
  readonly actions: readonly TerminalConnAction[]
}

export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 10_000

/** Pure backoff: exponential in `attempt` (1-based), clamped to the max,
 * jittered by `rand` in [0,1) exactly like the legacy component's
 * `exponential * (0.8 + Math.random() * 0.4)` — rand is a PARAMETER so
 * tests pin exact values (the machine itself never reads Math.random). */
export function reconnectDelayMs(attempt: number, rand: number): number {
  const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1))
  return exponential * (0.8 + rand * 0.4)
}

export function createInitialState(): TerminalConnState {
  // 'connecting' from birth: the driver dispatches `connect` in the same
  // tick it creates the machine, and there is no meaningful "before
  // connecting" display state.
  return { epoch: 0, status: 'connecting', attempt: 0 }
}

const noop = (state: TerminalConnState): TerminalConnTransition => ({ state, actions: [] })

export function transition(state: TerminalConnState, event: TerminalConnEvent): TerminalConnTransition {
  // closed (disposed) is TERMINAL: nothing acts, nothing changes. Checked
  // first so no later rule can accidentally revive a disposed machine.
  if (state.status === 'closed') return noop(state)

  switch (event.type) {
    case 'connect': {
      // ended is final (never resurrect); suspended must resume, not
      // connect (a stray retry timer that somehow fires while suspended
      // must not open a hidden socket).
      if (state.status === 'ended' || state.status === 'suspended') return noop(state)
      const epoch = state.epoch + 1
      return {
        state: { ...state, epoch, status: 'connecting' },
        // closeSocket first: connect always supersedes whatever socket may
        // linger (same as the legacy connect()'s "close previous" guard).
        actions: [{ type: 'clearReconnect' }, { type: 'closeSocket' }, { type: 'openSocket', epoch }],
      }
    }

    case 'opened': {
      if (event.epoch !== state.epoch || state.status !== 'connecting') return noop(state)
      return { state: { ...state, status: 'open', attempt: 0 }, actions: [] }
    }

    case 'message': {
      // Deliverable iff current-epoch AND the machine is in a socket-alive
      // status. 'connecting' is included on purpose: the gateway's attach
      // replay (and the `attached` control message itself) arrive before
      // the driver dispatches `opened`.
      if (event.epoch !== state.epoch) return noop(state)
      if (state.status !== 'connecting' && state.status !== 'open') return noop(state)
      return { state, actions: [{ type: 'deliver' }] }
    }

    case 'closed': {
      // Stale epoch: a socket WE already superseded (suspend/resume/
      // reconnect) finally closed — reviewer interleaving (b)'s second
      // half. Must be a complete no-op: no retry, no attempt bump.
      if (event.epoch !== state.epoch) return noop(state)
      // suspended/ended: the close was intentional (or moot) — no retry.
      if (state.status === 'suspended' || state.status === 'ended') return noop(state)
      const attempt = state.attempt + 1
      return {
        state: { ...state, status: 'connecting', attempt },
        actions: [{ type: 'scheduleReconnect', attempt }],
      }
    }

    case 'suspend': {
      // Never stomp 'ended' (reviewer interleaving (c): a suspended-then-
      // resumed dead session must still read "Session ended").
      if (state.status === 'ended' || state.status === 'suspended') return noop(state)
      const epoch = state.epoch + 1 // in-flight socket events go stale NOW
      return {
        state: { ...state, epoch, status: 'suspended' },
        actions: [{ type: 'clearReconnect' }, { type: 'closeSocket' }],
      }
    }

    case 'resume': {
      // Only a suspended machine resumes; ended stays ended (interleaving
      // (c)), connecting/open mean a spurious resume — no-op.
      if (state.status !== 'suspended') return noop(state)
      const epoch = state.epoch + 1
      return {
        // attempt PRESERVED: only a successful `opened` clears backoff — a
        // flapping gateway doesn't get hammered just because the user
        // scrolled away and back.
        state: { ...state, epoch, status: 'connecting' },
        actions: [{ type: 'clearReconnect' }, { type: 'openSocket', epoch }],
      }
    }

    case 'exit': {
      if (event.epoch !== state.epoch) return noop(state)
      return {
        state: { ...state, status: 'ended' },
        actions: [{ type: 'clearReconnect' }],
      }
    }

    case 'dispose': {
      return {
        state: { ...state, epoch: state.epoch + 1, status: 'closed' },
        actions: [{ type: 'clearReconnect' }, { type: 'closeSocket' }],
      }
    }
  }
}
