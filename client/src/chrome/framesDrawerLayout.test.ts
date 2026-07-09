/**
 * Frames-drawer store: parseFramesDrawerPinned defensive parsing and the
 * setPinned/togglePinned/setPeeking + persist/subscribe seam. Run:
 * bun client/src/chrome/framesDrawerLayout.test.ts
 *
 * Only `pinned` is persisted (a durable per-user preference); `peeking` is a
 * transient hover flag that must never touch localStorage. Same in-memory-shim
 * dance as panelLayout.test.ts: the module reads localStorage at load time, so
 * the shim is installed before the dynamic import().
 */
import assert from 'node:assert/strict'

const STORAGE_KEY = 'ensembleworks.framesDrawer.v1'

class MemoryStorage {
	private store = new Map<string, string>()
	getItem(key: string): string | null {
		return this.store.has(key) ? this.store.get(key)! : null
	}
	setItem(key: string, value: string): void {
		this.store.set(key, String(value))
	}
	removeItem(key: string): void {
		this.store.delete(key)
	}
	clear(): void {
		this.store.clear()
	}
	get length(): number {
		return this.store.size
	}
	key(index: number): string | null {
		return [...this.store.keys()][index] ?? null
	}
}

;(globalThis as { localStorage?: Storage }).localStorage ??= new MemoryStorage() as unknown as Storage

const {
	parseFramesDrawerPinned,
	getFramesDrawer,
	setPinned,
	togglePinned,
	setPeeking,
	peekOpen,
	peekCloseSoon,
	subscribeFramesDrawer,
} = await import('./framesDrawerLayout')

// --- defaults ---

assert.equal(parseFramesDrawerPinned(null), false, 'nothing stored → not pinned')
assert.deepEqual(
	getFramesDrawer(),
	{ pinned: false, peeking: false },
	'module starts from defaults against the shimmed empty store'
)

// --- parseFramesDrawerPinned: defensive parsing of every raw shape ---

assert.equal(parseFramesDrawerPinned('{not json'), false, 'malformed JSON falls back to false')
assert.equal(
	parseFramesDrawerPinned(JSON.stringify({ pinned: 'yes' })),
	false,
	'a wrong-typed pinned field falls back to false'
)
assert.equal(
	parseFramesDrawerPinned(JSON.stringify({ pinned: true })),
	true,
	'a valid pinned:true round-trips'
)
assert.equal(
	parseFramesDrawerPinned(JSON.stringify({ somethingElse: 1 })),
	false,
	'an unrelated JSON shape falls back to false rather than crashing'
)

// --- setPinned / togglePinned: persist + notify ---
{
	let calls = 0
	const unsubscribe = subscribeFramesDrawer(() => {
		calls += 1
	})

	setPinned(true)
	assert.equal(calls, 1, 'setPinned should notify subscribers exactly once')
	assert.equal(getFramesDrawer().pinned, true, 'getFramesDrawer reflects the update immediately')

	// Persisted under the documented key, read back through the parser itself so
	// this exercises the real round-trip rather than a raw string match.
	const raw = localStorage.getItem(STORAGE_KEY)
	assert.ok(raw, 'setPinned should persist to localStorage')
	assert.equal(parseFramesDrawerPinned(raw), true)

	togglePinned()
	assert.equal(calls, 2)
	assert.equal(getFramesDrawer().pinned, false, 'toggle flips pinned back off')
	assert.equal(parseFramesDrawerPinned(localStorage.getItem(STORAGE_KEY)), false, 'and persists it')

	// --- setPeeking: notifies, but is transient — must NOT persist ---
	setPinned(true) // re-pin so we can prove peeking leaves the persisted value alone
	assert.equal(calls, 3)
	setPeeking(true)
	assert.equal(calls, 4, 'setPeeking notifies subscribers')
	assert.equal(getFramesDrawer().peeking, true, 'peeking flips on in memory')
	assert.equal(
		parseFramesDrawerPinned(localStorage.getItem(STORAGE_KEY)),
		true,
		'setPeeking left the persisted pinned value untouched'
	)

	setPeeking(false)
	assert.equal(calls, 5)
	assert.equal(getFramesDrawer().peeking, false)

	// --- unsubscribe stops notifications ---
	unsubscribe()
	setPinned(false)
	assert.equal(calls, 5, 'unsubscribed listener should not be notified')
	assert.equal(getFramesDrawer().pinned, false, 'the update itself still applies')
}

// --- peekOpen / peekCloseSoon: hover coordination with a short close grace.
// The caret and the drawer sit flush edge-to-edge, so crossing from one to the
// other briefly touches neither — the grace bridges that gap without a flicker.
{
	setPinned(false)
	setPeeking(false)

	peekOpen()
	assert.equal(getFramesDrawer().peeking, true, 'peekOpen opens the peek immediately')

	peekCloseSoon()
	assert.equal(getFramesDrawer().peeking, true, 'still open during the grace window')
	await new Promise((resolve) => setTimeout(resolve, 200))
	assert.equal(getFramesDrawer().peeking, false, 'closed once the grace elapses')

	// Re-entering (caret → drawer) during the grace must cancel the pending close.
	peekOpen()
	peekCloseSoon()
	peekOpen()
	await new Promise((resolve) => setTimeout(resolve, 200))
	assert.equal(getFramesDrawer().peeking, true, 'a peekOpen during the grace cancels the pending close — no flicker')

	setPeeking(false)
}

console.log('framesDrawerLayout.test.ts: all assertions passed')
