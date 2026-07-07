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
import {
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
const snapshot = (): AvPanelSnapshot => ({
	status: 'connected',
	micEnabled: false,
	camEnabled: false,
	standupMode: true,
	localVideoTrack: null,
	localSpeaking: false,
	peers: [],
	scribes: [],
	vm: null,
	latencies: {},
	latencyHistory: {},
	kickingId: null,
	kickError: null,
	actions: {
		onMic: () => {},
		onCam: () => {},
		onStandup: () => {},
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

console.log('bridge.test.ts: all assertions passed')
