// Run: bun src/canvas-v2/shapes/terminalConnection.test.ts
//
// Exhaustive unit test of the terminal connection state machine
// (terminalConnection.ts) — the PURE core the TerminalShape React effect
// drives. Written RED-FIRST against the reviewed spec: the three reviewer
// interleavings at the bottom encode exactly the bugs the previous inline
// wiring had (stale message after dispose reaching a disposed xterm; resume
// racing a suspend-close leaving the tile dark until backoff; resume after
// `exit` resurrecting a dead tmux session as a fresh shell via `tmux -A`).
import assert from 'node:assert/strict'
import {
  createInitialState,
  reconnectDelayMs,
  transition,
  type TerminalConnEvent,
  type TerminalConnState,
} from './terminalConnection.js'

// Helper: run a sequence of events from the initial state, returning the
// final state and the full ordered action log (tagged with the event index).
function run(events: TerminalConnEvent[]): { state: TerminalConnState; log: string[] } {
  let state = createInitialState()
  const log: string[] = []
  for (const event of events) {
    const r = transition(state, event)
    state = r.state
    for (const a of r.actions) {
      log.push(a.type === 'openSocket' ? `openSocket@${a.epoch}` : a.type === 'scheduleReconnect' ? `scheduleReconnect#${a.attempt}` : a.type)
    }
  }
  return { state, log }
}

const has = (log: string[], entry: string) => log.includes(entry)

// ============================================================================
// Basic lifecycle: connect -> opened -> messages deliver -> dispose.
// ============================================================================
{
  let s = createInitialState()
  assert.equal(s.status, 'connecting', 'initial state is connecting (mount dispatches connect immediately)')

  let r = transition(s, { type: 'connect' })
  s = r.state
  assert.equal(s.status, 'connecting')
  assert.equal(s.epoch, 1, 'connect bumps the epoch')
  assert.ok(r.actions.some((a) => a.type === 'openSocket' && a.epoch === 1), 'connect opens a socket at the new epoch')

  r = transition(s, { type: 'message', epoch: 1 })
  assert.ok(r.actions.some((a) => a.type === 'deliver'), 'a current-epoch message delivers while connecting (the attached replay arrives before opened)')

  r = transition(s, { type: 'opened', epoch: 1 })
  s = r.state
  assert.equal(s.status, 'open', 'opened (gateway attached) -> open')
  assert.equal(s.attempt, 0, 'opened resets the retry attempt')

  r = transition(s, { type: 'message', epoch: 1 })
  assert.ok(r.actions.some((a) => a.type === 'deliver'), 'a current-epoch message delivers while open')
  // Unit 12 residual (a): TerminalShape.tsx's dispatch() bails on calling
  // setConn() when `result.state` is REFERENCE-IDENTICAL to the state it
  // dispatched against — every 'message' event during a live PTY stream hits
  // this path (a chatty session emits one per data chunk), and without the
  // bail the driver was minting a fresh `{status, attempt}` object and
  // calling setConn() on EVERY chunk, forcing a React re-render per byte
  // burst for a value that never actually changed. This assertion pins the
  // fact the fix leans on: a 'message' transition that doesn't change status/
  // attempt returns the SAME state object (`noop`'s `{ state, actions: [] }`,
  // not a copy) — if this ever regressed to always cloning, the component's
  // reference-equality bail would silently stop working.
  assert.ok(r.state === s, "a delivering message with no status/attempt change returns the SAME state reference (noop, not a clone) — this is what TerminalShape.tsx's dispatch() bails setConn() on")

  r = transition(s, { type: 'dispose' })
  s = r.state
  assert.equal(s.status, 'closed')
  assert.ok(r.actions.some((a) => a.type === 'closeSocket'), 'dispose closes the socket')
  assert.ok(r.actions.some((a) => a.type === 'clearReconnect'), 'dispose clears any pending retry')

  // Terminal state: nothing revives a disposed machine.
  for (const ev of [{ type: 'connect' }, { type: 'resume' }, { type: 'suspend' }] as TerminalConnEvent[]) {
    const rr = transition(s, ev)
    assert.equal(rr.state.status, 'closed', `${ev.type} after dispose stays closed`)
    assert.equal(rr.actions.length, 0, `${ev.type} after dispose performs no actions`)
  }
}

// ============================================================================
// Retry/backoff: closed at the current epoch schedules a reconnect with a
// bumped attempt; opened resets it; stale closes are ignored.
// ============================================================================
{
  let s = createInitialState()
  s = transition(s, { type: 'connect' }).state // epoch 1
  let r = transition(s, { type: 'closed', epoch: 1 })
  s = r.state
  assert.equal(s.status, 'connecting', 'a drop keeps the machine in connecting (awaiting the retry timer)')
  assert.equal(s.attempt, 1)
  assert.ok(r.actions.some((a) => a.type === 'scheduleReconnect' && a.attempt === 1), 'first drop schedules retry #1')

  r = transition(s, { type: 'connect' }) // retry timer fired -> epoch 2
  s = r.state
  assert.equal(s.epoch, 2)
  r = transition(s, { type: 'closed', epoch: 2 })
  s = r.state
  assert.equal(s.attempt, 2, 'consecutive drops keep bumping the attempt (backoff grows)')

  r = transition(s, { type: 'closed', epoch: 1 })
  assert.equal(r.actions.length, 0, 'a STALE close (old epoch) is ignored entirely — no double-scheduled retry')
  assert.equal(r.state.attempt, 2, 'stale close does not bump the attempt')

  s = transition(s, { type: 'connect' }).state // epoch 3
  s = transition(s, { type: 'opened', epoch: 3 }).state
  assert.equal(s.attempt, 0, 'opened resets the backoff attempt')
}

// reconnectDelayMs: pure — exponential with jitter, clamped.
assert.equal(reconnectDelayMs(1, 0.5), 500, 'attempt 1, mid jitter: 500 * 2^0 * (0.8 + 0.5*0.4) = 500')
assert.equal(reconnectDelayMs(2, 0), 800, 'attempt 2, low jitter: 1000 * 0.8')
assert.equal(reconnectDelayMs(2, 0.5), 1000, 'attempt 2, mid jitter: 1000 * 1.0')
assert.equal(reconnectDelayMs(20, 0.5), 10_000, 'huge attempt clamps to the 10s max before jitter (10000 * 1.0)')

// ============================================================================
// Suspend/resume basics.
// ============================================================================
{
  let s = createInitialState()
  s = transition(s, { type: 'connect' }).state // epoch 1
  s = transition(s, { type: 'opened', epoch: 1 }).state

  let r = transition(s, { type: 'suspend' })
  s = r.state
  assert.equal(s.status, 'suspended')
  assert.ok(s.epoch > 1, 'suspend bumps the epoch so in-flight socket events go stale')
  assert.ok(has(r.actions.map((a) => a.type) as string[], 'closeSocket'), 'suspend closes the socket')

  const suspendedEpoch = s.epoch
  r = transition(s, { type: 'suspend' })
  assert.equal(r.actions.length, 0, 'a second suspend is a no-op')
  assert.equal(r.state.epoch, suspendedEpoch)

  r = transition(s, { type: 'resume' })
  s = r.state
  assert.equal(s.status, 'connecting', 'resume reconnects immediately')
  assert.ok(r.actions.some((a) => a.type === 'openSocket' && a.epoch === s.epoch), 'resume opens THE REAL connect at a fresh epoch')

  r = transition(s, { type: 'resume' })
  assert.equal(r.actions.length, 0, 'resume while not suspended is a no-op')
}

// Suspend preserves the backoff attempt across the gap (resume does not
// reset it — only a successful opened does).
{
  let s = createInitialState()
  s = transition(s, { type: 'connect' }).state
  s = transition(s, { type: 'closed', epoch: 1 }).state // attempt 1
  s = transition(s, { type: 'suspend' }).state
  const r = transition(s, { type: 'resume' })
  assert.equal(r.state.attempt, 1, 'resume preserves the backoff attempt (a flapping gateway stays backed off)')
}

// ============================================================================
// exit (gateway says the tmux session ended).
// ============================================================================
{
  let s = createInitialState()
  s = transition(s, { type: 'connect' }).state
  s = transition(s, { type: 'opened', epoch: 1 }).state
  let r = transition(s, { type: 'exit', epoch: 1 })
  s = r.state
  assert.equal(s.status, 'ended')
  assert.ok(r.actions.some((a) => a.type === 'clearReconnect'), 'exit clears any pending retry')

  r = transition(s, { type: 'closed', epoch: 1 })
  assert.equal(r.actions.length, 0, "the socket's own close after exit schedules NO reconnect (ended is final)")

  r = transition(s, { type: 'connect' })
  assert.equal(r.actions.length, 0, 'connect after ended is a no-op — never resurrect a dead session')

  r = transition(s, { type: 'exit', epoch: 99 })
  assert.equal(r.actions.length, 0, 'a stale exit (old epoch) is ignored')
}

// ============================================================================
// REVIEWER INTERLEAVING (a): stale message after dispose -> dropped.
// The old inline wiring's onmessage had no disposal guard — an in-flight PTY
// chunk could term.write() a disposed xterm.
// ============================================================================
{
  let s = createInitialState()
  s = transition(s, { type: 'connect' }).state // epoch 1
  s = transition(s, { type: 'opened', epoch: 1 }).state
  s = transition(s, { type: 'dispose' }).state
  const r = transition(s, { type: 'message', epoch: 1 })
  assert.equal(r.actions.length, 0, 'interleaving (a): a message from the pre-dispose socket must NOT deliver (no term.write on a disposed xterm)')
}

// ============================================================================
// REVIEWER INTERLEAVING (b): resume racing the suspend-close. The old wiring
// no-opped resume while wsRef still held the CLOSING socket, leaving
// "Off-screen — paused" displayed on-screen until backoff expired.
// ============================================================================
{
  let s = createInitialState()
  s = transition(s, { type: 'connect' }).state // epoch 1
  s = transition(s, { type: 'opened', epoch: 1 }).state
  s = transition(s, { type: 'suspend' }).state // closes socket@1; epoch 2
  // Resume arrives BEFORE the browser fires the old socket's onclose:
  let r = transition(s, { type: 'resume' })
  s = r.state
  assert.equal(s.status, 'connecting', 'interleaving (b): resume mid-close reconnects immediately — never stuck displaying paused')
  const resumeEpoch = s.epoch
  assert.ok(r.actions.some((a) => a.type === 'openSocket' && a.epoch === resumeEpoch), 'fresh socket at the new epoch, immediately')
  // The suspend-closed socket's onclose finally lands (epoch 1 — stale):
  r = transition(s, { type: 'closed', epoch: 1 })
  assert.equal(r.actions.length, 0, 'interleaving (b): the stale suspend-close is ignored — no spurious retry, no attempt bump')
  assert.equal(r.state.status, 'connecting', 'still connecting on the fresh socket')
  // ...and the fresh socket attaches fine.
  s = transition(r.state, { type: 'opened', epoch: resumeEpoch }).state
  assert.equal(s.status, 'open')
}

// ============================================================================
// REVIEWER INTERLEAVING (c): resume after ended -> NO socket. The old
// wiring's hand-rolled resume socket was blind to `ended` and re-ran
// `tmux new -A` — resurrecting a dead session as a fresh shell.
// ============================================================================
{
  let s = createInitialState()
  s = transition(s, { type: 'connect' }).state // epoch 1
  s = transition(s, { type: 'opened', epoch: 1 }).state
  s = transition(s, { type: 'exit', epoch: 1 }).state // ended
  // Suspend must not stomp the ended display...
  let r = transition(s, { type: 'suspend' })
  assert.equal(r.state.status, 'ended', 'interleaving (c): suspend never stomps the ended display')
  assert.equal(r.actions.length, 0)
  // ...and resume must not open a socket.
  r = transition(r.state, { type: 'resume' })
  assert.equal(r.state.status, 'ended', 'interleaving (c): resume after ended shows "Session ended" — never a fresh shell')
  assert.ok(!r.actions.some((a) => a.type === 'openSocket'), 'interleaving (c): no socket is ever opened for an ended session')
}

// ============================================================================
// Exhaustive totality: every (status, event) pair returns a valid state and
// never throws — the machine is a total function.
// ============================================================================
{
  const statuses = ['connecting', 'open', 'suspended', 'ended', 'closed'] as const
  const events: TerminalConnEvent[] = [
    { type: 'connect' },
    { type: 'opened', epoch: 5 },
    { type: 'opened', epoch: 4 },
    { type: 'message', epoch: 5 },
    { type: 'message', epoch: 4 },
    { type: 'closed', epoch: 5 },
    { type: 'closed', epoch: 4 },
    { type: 'suspend' },
    { type: 'resume' },
    { type: 'exit', epoch: 5 },
    { type: 'exit', epoch: 4 },
    { type: 'dispose' },
  ]
  for (const status of statuses) {
    for (const event of events) {
      const state: TerminalConnState = { epoch: 5, status, attempt: 2 }
      const r = transition(state, event)
      assert.ok(statuses.includes(r.state.status), `(${status}, ${event.type}) returns a valid status`)
      assert.ok(r.state.epoch >= state.epoch, 'epoch is monotonic — never rewinds')
      // closed (disposed) is terminal: no event may leave it or act.
      if (status === 'closed') {
        assert.equal(r.state.status, 'closed', `closed is terminal (event ${event.type})`)
        assert.equal(r.actions.length, 0, `closed performs no actions (event ${event.type})`)
      }
      // A stale-epoch socket event NEVER acts.
      if ('epoch' in event && event.epoch !== state.epoch) {
        assert.equal(r.actions.length, 0, `stale ${event.type} never acts (status ${status})`)
      }
    }
  }
}

// run() smoke covering the whole happy+sad path in one trace.
{
  const { state, log } = run([
    { type: 'connect' }, // epoch 1
    { type: 'opened', epoch: 1 },
    { type: 'closed', epoch: 1 }, // drop -> retry #1
    { type: 'connect' }, // epoch 2
    { type: 'opened', epoch: 2 },
    { type: 'suspend' }, // epoch 3
    { type: 'resume' }, // epoch 4
    { type: 'opened', epoch: 4 },
    { type: 'exit', epoch: 4 },
    { type: 'dispose' },
  ])
  assert.equal(state.status, 'closed')
  assert.ok(has(log, 'openSocket@1') && has(log, 'openSocket@2') && has(log, 'openSocket@4'), `full trace opens sockets at epochs 1/2/4 — got ${JSON.stringify(log)}`)
  assert.ok(has(log, 'scheduleReconnect#1'), 'the drop scheduled retry #1')
}

console.log('ok: terminalConnection — exhaustive state machine incl. the three reviewer interleavings')
