// avPopout: the pop-out-the-A/V lifecycle — the pure docked↔popped state
// machine, the window-features builder, and the module store's dispatch/notify
// seam. Pure (no tldraw, no DOM) so it runs under bun exactly like
// panelLayout.test.ts. Run: bun client/src/chrome/avPopout.test.ts
import assert from 'node:assert/strict'
import {
	nextPopoutState,
	popoutWindowFeatures,
	POPOUT_WIDTH,
	POPOUT_HEIGHT,
	getPopoutState,
	subscribePopoutState,
	popOutAv,
	dockAv,
	notifyPopoutClosed,
} from './avPopout'

// --- nextPopoutState: the pure docked↔popped lifecycle ---

// pop-out lands (and stays) popped; idempotent from either state.
assert.equal(nextPopoutState('docked', 'pop-out'), 'popped')
assert.equal(nextPopoutState('popped', 'pop-out'), 'popped', 'pop-out is idempotent while popped')

// bring-back returns to docked from either state.
assert.equal(nextPopoutState('popped', 'bring-back'), 'docked')
assert.equal(nextPopoutState('docked', 'bring-back'), 'docked', 'bring-back is idempotent while docked')

// The user closing the pop-out window (OS close button) self-heals to docked —
// same terminal state as an explicit bring-back, so the tiles reappear in the
// panel with no orphaned window state left behind.
assert.equal(nextPopoutState('popped', 'window-closed'), 'docked')
// A stale close event while already docked is a no-op, not a crash.
assert.equal(nextPopoutState('docked', 'window-closed'), 'docked')

// --- popoutWindowFeatures: fixed size, deliberately NO placement ---
// Scope is tight (no multi-monitor placement, no resize memory), so the
// features string carries a size and the minimal-chrome `popup` hint and
// nothing else — in particular no left/top the browser would honour.
const features = popoutWindowFeatures()
assert.equal(features, `popup=yes,width=${POPOUT_WIDTH},height=${POPOUT_HEIGHT}`)
assert.ok(!features.includes('left'), 'no left placement — no multi-monitor logic')
assert.ok(!features.includes('top'), 'no top placement — no multi-monitor logic')
assert.equal(popoutWindowFeatures(500, 700), 'popup=yes,width=500,height=700', 'caller size wins')

// --- module store: default state, dispatch verbs, change-only notification ---
{
	assert.equal(getPopoutState(), 'docked', 'the store starts docked')

	let calls = 0
	const unsubscribe = subscribePopoutState(() => {
		calls += 1
	})

	popOutAv()
	assert.equal(getPopoutState(), 'popped', 'popOutAv pops out')
	assert.equal(calls, 1, 'a real state change notifies once')

	// Redundant pop-out (already popped) must NOT notify — subscribers only
	// wake for genuine transitions.
	popOutAv()
	assert.equal(getPopoutState(), 'popped')
	assert.equal(calls, 1, 'a no-op pop-out does not notify')

	notifyPopoutClosed()
	assert.equal(getPopoutState(), 'docked', 'an external window-close docks')
	assert.equal(calls, 2)

	popOutAv()
	dockAv()
	assert.equal(getPopoutState(), 'docked', 'dockAv brings the tiles back')
	assert.equal(calls, 4, 'pop-out then dock is two real changes')

	// A redundant dock (already docked) does not notify either.
	dockAv()
	assert.equal(calls, 4, 'a no-op dock does not notify')

	unsubscribe()
	popOutAv()
	assert.equal(calls, 4, 'an unsubscribed listener is not notified')
	assert.equal(getPopoutState(), 'popped', 'the update itself still applies')

	// Leave the singleton store back at its default so re-runs start clean.
	dockAv()
}

console.log('ok: avPopout')
