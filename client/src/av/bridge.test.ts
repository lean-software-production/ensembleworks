/**
 * Bridge store: publish/subscribe, face-element registry, hovered-face state.
 * Run: bun client/src/av/bridge.test.ts
 *
 * Must be importable under bare bun (no 'tldraw', no runtime 'livekit-client')
 * — see bridge.ts header comment. The exported subscribe* functions are the
 * plain (non-React) seam useAvSnapshot/useHoveredFace are built on, so this
 * bare-bun script can assert notification counts without a React renderer.
 */
import assert from 'node:assert/strict'
import type { RemoteTrack } from 'livekit-client'
import {
	avSnapshotsEqual,
	getAvSnapshot,
	getFaceEl,
	getHoveredFace,
	publishAvSnapshot,
	registerFaceEl,
	setHoveredFace,
	subscribeAvSnapshot,
	subscribeHoveredFace,
	type AvPanelSnapshot,
} from './bridge'

// A minimal-but-complete snapshot fixture — every field of AvPanelSnapshot.
// The pulse sub-objects are shared across calls because that mirrors reality:
// useSessionPulse returns the same object refs between ticks, and
// avSnapshotsEqual compares them by reference.
const stableLatencies = {}
const stableHistory = {}
const snapshot = (): AvPanelSnapshot => ({
	status: 'connected',
	micEnabled: false,
	camEnabled: false,
	standupMode: true,
	crosstalkLevel: 0,
	localVideoTrack: null,
	localSpeaking: false,
	peers: [],
	scribes: [],
	vm: null,
	latencies: stableLatencies,
	latencyHistory: stableHistory,
	kickingId: null,
	kickError: null,
	actions: {
		onMic: () => {},
		onCam: () => {},
		onStandup: () => {},
		setCrosstalk: () => {},
		kick: () => {},
	},
})

// --- getAvSnapshot() starts null ---
assert.equal(getAvSnapshot(), null)

// --- publish notifies subscribers exactly once per publish ---
{
	let calls = 0
	const unsubscribe = subscribeAvSnapshot(() => {
		calls += 1
	})
	const snap = snapshot()
	publishAvSnapshot(snap)
	assert.equal(calls, 1, 'publish should notify subscribers exactly once')

	// getAvSnapshot returns the SAME object by reference.
	assert.equal(getAvSnapshot(), snap)

	const snap2 = snapshot()
	publishAvSnapshot(snap2)
	assert.equal(calls, 2, 'a second publish should notify again, exactly once')
	assert.equal(getAvSnapshot(), snap2)

	publishAvSnapshot(null)
	assert.equal(calls, 3)
	assert.equal(getAvSnapshot(), null)

	unsubscribe()
	publishAvSnapshot(snapshot())
	assert.equal(calls, 3, 'unsubscribed listener should not be notified')
}

// --- face-element registry: set/get/delete round-trip, no notify ---
{
	assert.equal(getFaceEl('user-1'), null, 'unregistered face returns null')

	const el = {} as HTMLDivElement
	registerFaceEl('user-1', el)
	assert.equal(getFaceEl('user-1'), el)

	registerFaceEl('user-1', null)
	assert.equal(getFaceEl('user-1'), null, 'registering null clears the entry')
}

// --- hovered face: set/get round-trip + notify ---
{
	assert.equal(getHoveredFace(), null, 'no face hovered initially')

	let calls = 0
	const unsubscribe = subscribeHoveredFace(() => {
		calls += 1
	})

	setHoveredFace('user-1')
	assert.equal(getHoveredFace(), 'user-1')
	assert.equal(calls, 1, 'setHoveredFace should notify subscribers')

	setHoveredFace(null)
	assert.equal(getHoveredFace(), null)
	assert.equal(calls, 2)

	unsubscribe()
	setHoveredFace('user-2')
	assert.equal(calls, 2, 'unsubscribed listener should not be notified')
}

// --- avSnapshotsEqual: the publisher's dedupe gate ---
{
	// The store itself never dedupes — publishing an identical-content object
	// still notifies (the dedupe lives with the publisher, in AvOverlay).
	let calls = 0
	const unsubscribe = subscribeAvSnapshot(() => {
		calls += 1
	})
	publishAvSnapshot(snapshot())
	publishAvSnapshot(snapshot())
	assert.equal(calls, 2, 'store must notify even for identical-content snapshots')
	unsubscribe()

	// Equal content → equal, even though the objects (and action closures) differ.
	assert.equal(avSnapshotsEqual(snapshot(), snapshot()), true)

	// Any primitive difference → not equal.
	assert.equal(avSnapshotsEqual(snapshot(), { ...snapshot(), micEnabled: true }), false)
	assert.equal(avSnapshotsEqual(snapshot(), { ...snapshot(), status: 'retrying' }), false)
	assert.equal(avSnapshotsEqual(snapshot(), { ...snapshot(), kickError: 'nope' }), false)
	// A crosstalk-level change must republish so the slider (and gain loop) update.
	assert.equal(avSnapshotsEqual(snapshot(), { ...snapshot(), crosstalkLevel: 0.5 }), false)

	// Pulse sub-objects compare by reference (a fresh object means a new tick).
	assert.equal(avSnapshotsEqual(snapshot(), { ...snapshot(), latencies: { u: { rtt: 1, t: 1 } } }), false)

	// Peers compare per-field, not by array identity.
	const peer = { id: 'u1', name: 'Ada', videoTrack: null, isSpeaking: false }
	assert.equal(
		avSnapshotsEqual({ ...snapshot(), peers: [peer] }, { ...snapshot(), peers: [{ ...peer }] }),
		true,
		'same peer content in fresh arrays should be equal'
	)
	assert.equal(
		avSnapshotsEqual(
			{ ...snapshot(), peers: [peer] },
			{ ...snapshot(), peers: [{ ...peer, isSpeaking: true }] }
		),
		false
	)
	assert.equal(
		avSnapshotsEqual({ ...snapshot(), peers: [peer] }, { ...snapshot(), peers: [] }),
		false,
		'peer count change should not be equal'
	)

	// Video tracks compare by reference.
	const track = {} as RemoteTrack
	assert.equal(
		avSnapshotsEqual(
			{ ...snapshot(), peers: [{ ...peer, videoTrack: track }] },
			{ ...snapshot(), peers: [{ ...peer, videoTrack: track }] }
		),
		true
	)
	assert.equal(
		avSnapshotsEqual(
			{ ...snapshot(), peers: [{ ...peer, videoTrack: track }] },
			{ ...snapshot(), peers: [{ ...peer, videoTrack: {} as RemoteTrack }] }
		),
		false
	)

	// Scribes compare per-field too.
	assert.equal(
		avSnapshotsEqual(
			{ ...snapshot(), scribes: [{ id: 's1', name: 'scribe' }] },
			{ ...snapshot(), scribes: [{ id: 's1', name: 'scribe' }] }
		),
		true
	)
	assert.equal(
		avSnapshotsEqual({ ...snapshot(), scribes: [{ id: 's1', name: 'scribe' }] }, snapshot()),
		false
	)
}

console.log('bridge.test.ts: all assertions passed')
