/**
 * classifyDisconnect: retry-vs-fatal for LiveKit `Disconnected` ends.
 * Run: bun src/av/reconnect.test.ts
 */
import assert from 'node:assert/strict'
import { DisconnectReason } from 'livekit-client'
import { classifyDisconnect } from './reconnect'

// Fatal — re-joining would fight the server: a duplicate identity (another tab
// took the slot), an explicit kick (/api/av/kick → PARTICIPANT_REMOVED), or the
// room being deleted.
assert.equal(classifyDisconnect(DisconnectReason.DUPLICATE_IDENTITY), 'fatal')
assert.equal(classifyDisconnect(DisconnectReason.PARTICIPANT_REMOVED), 'fatal')
assert.equal(classifyDisconnect(DisconnectReason.ROOM_DELETED), 'fatal')

// Retry — every transient/network end, and "no reason given" (raw socket drop).
assert.equal(classifyDisconnect(DisconnectReason.SERVER_SHUTDOWN), 'retry')
assert.equal(classifyDisconnect(DisconnectReason.SIGNAL_CLOSE), 'retry')
assert.equal(classifyDisconnect(undefined), 'retry')

console.log('reconnect.test.ts: all assertions passed')
