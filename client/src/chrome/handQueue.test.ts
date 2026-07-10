// handQueue: derive the raise-hand / request-to-present queue (and handoff
// signals) from collaborator presence meta. Pure — no tldraw import — so it
// runs under bun exactly like followLogic.test.ts.
// Run: bun src/chrome/handQueue.test.ts
import assert from 'node:assert/strict'
import { handQueue, handPosition, incomingHandoffTs } from './handQueue'

const peer = (userId: string, meta: unknown, userName?: string) =>
	({ userId, userName: userName ?? userId, meta }) as never

// --- handQueue: ordered by raise time (first raised, first in line) ---

// Nobody with a hand up → empty queue (null / missing handRaised is "down").
assert.deepEqual(handQueue([peer('a', {}), peer('b', { handRaised: null })]), [])

// Raisers come out ordered by ascending raisedAt regardless of array order.
const q = handQueue([
	peer('b', { handRaised: 200 }),
	peer('a', { handRaised: 100 }),
	peer('c', { handRaised: 300 }),
])
assert.deepEqual(q.map((r) => r.userId), ['a', 'b', 'c'])
assert.equal(q[0]?.raisedAt, 100)

// Non-numeric handRaised is ignored — only a real timestamp counts as queued.
assert.deepEqual(handQueue([peer('a', { handRaised: 'yes' }), peer('b', undefined)]), [])

// Same-ms ties break by userId so every client derives the identical order.
assert.deepEqual(
	handQueue([peer('z', { handRaised: 50 }), peer('a', { handRaised: 50 })]).map((r) => r.userId),
	['a', 'z'],
)

// Blank / missing names fall back to Anonymous (matches usePresenter).
assert.equal(handQueue([peer('a', { handRaised: 1 }, '  ')])[0]?.userName, 'Anonymous')

// --- handPosition: where a hand raised at myTs sits in line (peers only) ---
const peers = [peer('a', { handRaised: 100 }), peer('b', { handRaised: 300 })]
assert.equal(handPosition(peers, null), null) // hand down → no position
assert.equal(handPosition(peers, 50), 1) // raised before everyone → first
assert.equal(handPosition(peers, 200), 2) // one peer ahead
assert.equal(handPosition(peers, 400), 3) // behind both peers

// --- incomingHandoffTs: a promotion addressed to me, newest wins ---
const myId = 'me'
assert.equal(incomingHandoffTs([peer('p', { handoff: { to: myId, at: 10 } })], myId), 10)
// A handoff to someone else is not mine.
assert.equal(incomingHandoffTs([peer('p', { handoff: { to: 'other', at: 10 } })], myId), null)
// No handoff token at all.
assert.equal(incomingHandoffTs([peer('p', { presenting: true })], myId), null)
// Newest token addressed to me wins — a re-promotion out-stamps the first.
assert.equal(
	incomingHandoffTs(
		[peer('p', { handoff: { to: myId, at: 10 } }), peer('q', { handoff: { to: myId, at: 25 } })],
		myId,
	),
	25,
)
// Malformed handoff tokens are ignored.
assert.equal(incomingHandoffTs([peer('p', { handoff: { to: myId, at: 'x' } })], myId), null)
assert.equal(incomingHandoffTs([peer('p', { handoff: myId })], myId), null)

console.log('ok: handQueue')
