// Run: bun src/presence-peers.test.ts
// Frame.Presence wired through SyncClientPeer/SyncServerPeer: local publishes
// flow to the wire, remote publishes land in the store, the server relays to
// every other client, and a late joiner is bootstrapped with existing state.
import assert from 'node:assert/strict'
import { SyncClientPeer } from './client-peer.js'
import { makePair } from './memory-transport.js'
import { PresenceStore, type Presence } from './presence.js'
import { SyncServerPeer } from './server-peer.js'

function cursorAt(x: number, y: number): Presence {
  return { cursor: { x, y }, viewport: null, stamp: null, presenting: [] }
}

const presenceServer = new PresenceStore('server')
const server = new SyncServerPeer({ peerId: 1n, presence: presenceServer })
const [serverEndA, clientEndA] = makePair()
const [serverEndB, clientEndB] = makePair()
const presenceA = new PresenceStore('clientA')
const presenceB = new PresenceStore('clientB')
server.connect(serverEndA)
server.connect(serverEndB)
const clientA = new SyncClientPeer({ peerId: 101n, transport: clientEndA, presence: presenceA })
const clientB = new SyncClientPeer({ peerId: 102n, transport: clientEndB, presence: presenceB })

// --- (1) A publishes -> B sees it (and the server's own store has it) ---
presenceA.publish(cursorAt(1, 2))
assert.deepEqual(presenceB.all()['clientA']?.cursor, { x: 1, y: 2 }, "B's presence store sees A's cursor via server relay")
// The server relays this frame from onFrame's Presence branch, which also
// applies it to the server's own PresenceStore (constructor-injected above).
assert.deepEqual(
  (server as any).presence?.all()['clientA']?.cursor,
  { x: 1, y: 2 },
  "the server's own presence store observed A's publish",
)

// --- (2) B publishes -> A sees it ---
presenceB.publish(cursorAt(9, 9))
assert.deepEqual(presenceA.all()['clientB']?.cursor, { x: 9, y: 9 }, "A's presence store sees B's cursor via server relay")

// --- (3) a LATE-JOINING client C connects after both publishes above; the
// server's connect() bootstraps it with existing state (encodeAll() as a
// Presence frame) so C sees both A and B without waiting for a fresh publish.
// NOTE ordering: the in-memory transport is synchronous and loss-free but
// NOT queued — a send() before the receiving side has registered onMessage
// is simply dropped (see memory-transport.ts). SyncClientPeer's constructor
// wires onMessage before this test calls server.connect(), so the client
// is already listening when the bootstrap frame is sent (mirrors real ws:
// the browser attaches its message handler as soon as the socket opens,
// before the server-side actor.connect() can push anything down it). ---
const [serverEndC, clientEndC] = makePair()
const presenceC = new PresenceStore('clientC')
const clientC = new SyncClientPeer({ peerId: 103n, transport: clientEndC, presence: presenceC })
server.connect(serverEndC)

assert.deepEqual(presenceC.all()['clientA']?.cursor, { x: 1, y: 2 }, "late joiner C is bootstrapped with A's cursor")
assert.deepEqual(presenceC.all()['clientB']?.cursor, { x: 9, y: 9 }, "late joiner C is bootstrapped with B's cursor")

// --- (4) A reconnect()s on a fresh transport; its presence subscription
// (set up once in the constructor, reading the CURRENT transport field at
// fire time — same pattern as the Update path) must keep flowing without
// re-subscribing. ---
const [serverEndA2, clientEndA2] = makePair()
server.connect(serverEndA2)
clientA.reconnect(clientEndA2)

presenceA.publish(cursorAt(5, 5))
assert.deepEqual(
  presenceB.all()['clientA']?.cursor,
  { x: 5, y: 5 },
  "A's post-reconnect publish still reaches B (subscription followed the transport swap)",
)
assert.deepEqual(
  presenceC.all()['clientA']?.cursor,
  { x: 5, y: 5 },
  "A's post-reconnect publish also reaches the late joiner C",
)

// --- (5) close(): after close, publishes from a closed client no longer
// reach anyone, and close() itself does not throw ---
assert.doesNotThrow(() => clientB.close(), 'close() does not throw')
presenceB.publish(cursorAt(42, 42))
assert.deepEqual(
  presenceA.all()['clientB']?.cursor,
  { x: 9, y: 9 },
  "B's post-close publish never left the client (transport is closed, send() is a no-op) — A still sees B's last live value",
)

// --- (6) server close(): idempotent, does not throw ---
assert.doesNotThrow(() => server.close(), 'server close() does not throw')

// Release every EphemeralStore's periodic expiry-cleanup timer (see
// presence.test.ts) so this process exits promptly.
presenceServer.destroy()
presenceA.destroy()
presenceB.destroy()
presenceC.destroy()

console.log('ok: presence-peers')
