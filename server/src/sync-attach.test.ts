// attachSyncSocket: a room that fails to load closes just that socket, never throws.
// Run with: bun src/sync-attach.test.ts
import assert from 'node:assert/strict'
import { attachSyncSocket } from './sync-attach.ts'

// Happy path: the room attaches the socket, returns true.
{
	let attached: unknown = null
	const roomHost = { getOrCreateRoom: () => ({ handleSocketConnect: (o: unknown) => (attached = o) }) }
	const ws = { close: () => assert.fail('should not close'), terminate: () => assert.fail('no terminate') }
	const ok = attachSyncSocket(roomHost as never, ws as never, 'team', 's1')
	assert.equal(ok, true)
	assert.deepEqual(attached, { sessionId: 's1', socket: ws })
}

// Bad room: getOrCreateRoom throws → close(1011), return false, DO NOT throw.
{
	let closedWith: [number?, string?] | null = null
	const roomHost = {
		getOrCreateRoom: () => {
			throw new Error('sqlite corrupt')
		},
	}
	const ws = { close: (c?: number, r?: string) => (closedWith = [c, r]), terminate: () => {} }
	const ok = attachSyncSocket(roomHost as never, ws as never, 'team', 's1')
	assert.equal(ok, false, 'did not attach')
	assert.equal(closedWith![0], 1011, 'closed with 1011 (internal error)')
}

console.log('ok: sync-attach')
