/**
 * Shape-props → LiveKit track resolution. Run: npx tsx src/screenshare/resolve.test.ts
 */
import assert from 'node:assert/strict'
import {
	type AttachableTrack,
	type ParticipantLike,
	type PublicationLike,
	type RoomLike,
	resolveScreenTrack,
} from './resolve'

const track: AttachableTrack = {
	attach: () => ({}) as HTMLMediaElement,
	detach: (el) => el,
}
const participant = (identity: string, pubs: PublicationLike[]): ParticipantLike => ({
	identity,
	getTrackPublications: () => pubs,
})
const roomWith = (local: ParticipantLike, remotes: ParticipantLike[]): RoomLike => ({
	localParticipant: local,
	remoteParticipants: new Map(remotes.map((p) => [p.identity, p])),
})

// No room yet (A/V still connecting or disabled) → connecting placeholder.
assert.equal(resolveScreenTrack(null, 'a', 'screen:1').kind, 'connecting')

// Sharer's own tile: local publication with a live track → self-preview.
{
	const r = roomWith(participant('me', [{ trackName: 'screen:1', track }]), [])
	const s = resolveScreenTrack(r, 'me', 'screen:1')
	assert.equal(s.kind, 'live')
	if (s.kind === 'live') assert.equal(s.track, track)
}

// Sharer's own tile after unpublish → ended (tombstone).
{
	const r = roomWith(participant('me', []), [])
	assert.equal(resolveScreenTrack(r, 'me', 'screen:1').kind, 'ended')
}

// Remote sharer not in the room (left / tab died) → ended.
{
	const r = roomWith(participant('me', []), [])
	assert.equal(resolveScreenTrack(r, 'them', 'screen:1').kind, 'ended')
}

// Remote publication exists but no track yet (not subscribed — e.g. the tile
// is outside my viewport, or subscription is still in flight) → connecting.
{
	const r = roomWith(participant('me', []), [participant('them', [{ trackName: 'screen:1' }])])
	assert.equal(resolveScreenTrack(r, 'them', 'screen:1').kind, 'connecting')
}

// Remote publication subscribed → live.
{
	const r = roomWith(participant('me', []), [
		participant('them', [{ trackName: 'screen:1', track }]),
	])
	assert.equal(resolveScreenTrack(r, 'them', 'screen:1').kind, 'live')
}

// Remote participant present but THIS trackName is gone (that share was
// stopped; they may still have other screen tracks) → ended.
{
	const r = roomWith(participant('me', []), [
		participant('them', [{ trackName: 'screen:2', track }]),
	])
	assert.equal(resolveScreenTrack(r, 'them', 'screen:1').kind, 'ended')
}

console.log('ALL RESOLVE TESTS PASSED')
