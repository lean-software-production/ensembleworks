// client/src/chrome/rooms.test.ts
import assert from 'node:assert/strict'
import { parseRoomsPayload, toRoomRows, type RoomSummary } from './rooms'

// toRoomRows preserves the server's order — the payload is already sorted
// alphabetically server-side and the client must not re-sort (spec §3.1).
// The fixture is deliberately NOT in alphabetical order so that any accidental
// client-side sort would flip these assertions red.
{
	const rooms: RoomSummary[] = [
		{ id: 'zulu', participants: 0 },
		{ id: 'alpha', participants: 2 },
		{ id: 'mike', participants: 3 },
	]
	const rows = toRoomRows(rooms, 'mike')
	assert.deepEqual(
		rows.map((r) => r.id),
		['zulu', 'alpha', 'mike'],
		'server order preserved',
	)

	// The row matching currentRoomId is the only one flagged.
	assert.deepEqual(
		rows.map((r) => r.isCurrent),
		[false, false, true],
		'exactly the current room is marked',
	)

	// countLabel: null at zero, the number as a string otherwise (spec §3.2).
	assert.equal(rows[0].countLabel, null, 'zero participants ⇒ no label')
	assert.equal(rows[1].countLabel, '2')
	assert.equal(rows[2].countLabel, '3')

	// participants passes through untouched.
	assert.deepEqual(
		rows.map((r) => r.participants),
		[0, 2, 3],
	)
}

// A currentRoomId absent from the list yields no current row and does not throw
// (a freshly conjured room whose sqlite has not been written yet).
{
	const rows = toRoomRows([{ id: 'alpha', participants: 0 }], 'brand-new')
	assert.equal(rows.length, 1)
	assert.equal(rows[0].isCurrent, false, 'no row is current')
}

// Empty list ⇒ empty rows.
assert.deepEqual(toRoomRows([], 'team'), [])

console.log('ok: toRoomRows')

// parseRoomsPayload defensively narrows whatever the fetch returned.
assert.deepEqual(parseRoomsPayload(null), [], 'null ⇒ []')
assert.deepEqual(parseRoomsPayload(undefined), [], 'undefined ⇒ []')
assert.deepEqual(parseRoomsPayload({}), [], 'no rooms key ⇒ []')
assert.deepEqual(parseRoomsPayload({ rooms: 'x' }), [], 'rooms not an array ⇒ []')
assert.deepEqual(parseRoomsPayload('nope'), [], 'non-object ⇒ []')
assert.deepEqual(parseRoomsPayload({ rooms: [] }), [], 'empty array ⇒ []')
assert.deepEqual(
	parseRoomsPayload({
		rooms: [
			{ id: 'alpha', participants: 1 },
			{ id: 'beta', participants: '2' },
			{ id: 7, participants: 0 },
			{ participants: 0 },
			{ id: 'gamma' },
			null,
			'delta',
		],
	}),
	[{ id: 'alpha', participants: 1 }],
	'only well-formed entries survive',
)

console.log('ok: parseRoomsPayload')
