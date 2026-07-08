/**
 * Panel layout store: parsePanelLayout defensive parsing, clampPanelWidth
 * pure clamp math, and the update/persist/subscribe seam. Run:
 * bun client/src/chrome/panelLayout.test.ts
 *
 * panelLayout.ts reads localStorage at module-load time (`let layout =
 * readFromStorage()`), so the in-memory shim MUST be installed before the
 * module is imported. Static imports are hoisted above other top-level code,
 * so this uses a dynamic import() (after the shim), same as settings.test.ts.
 */
import assert from 'node:assert/strict'

const STORAGE_KEY = 'ensembleworks.panelLayout.v1'

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
	parsePanelLayout,
	clampPanelWidth,
	panelDragAction,
	getPanelLayout,
	setPanelWidth,
	setPanelCollapsed,
	togglePanelCollapsed,
	subscribePanelLayout,
} = await import('./panelLayout')

// --- defaults ---

assert.deepEqual(parsePanelLayout(null), { width: 280, collapsed: false })
assert.deepEqual(
	getPanelLayout(),
	{ width: 280, collapsed: false },
	'module starts from defaults against the shimmed empty store'
)

// --- clampPanelWidth: pure clamp math, no window/localStorage access ---

assert.equal(clampPanelWidth(280), 280, 'in-range width passes through')
assert.equal(clampPanelWidth(100), 180, 'below the floor clamps to 180')
assert.equal(clampPanelWidth(1000), 1000, 'in-range width below the hard cap passes through')
assert.equal(clampPanelWidth(2000), 1600, 'above the hard cap clamps to 1600')
assert.equal(clampPanelWidth(500, 400), 400, 'a caller-supplied maxWidth below the cap wins')
assert.equal(clampPanelWidth(300, 400), 300, 'in-range width under a supplied maxWidth passes through')
assert.equal(clampPanelWidth(50, 400), 180, 'the 180 floor still applies under a supplied maxWidth')

// --- panelDragAction: the grip's per-pointermove decision. The 140-179 band
// is deliberate hysteresis — writing the store there would let clampPanelWidth's
// 180 floor clobber the remembered width on the way INTO a collapse (the
// data-loss bug this function exists to prevent). Boundaries pinned exactly:
// 139 collapses, 140 and 179 are dead, 180 resizes.

assert.equal(panelDragAction(139), 'collapse', 'below 140 the drag collapses to the rail')
assert.equal(panelDragAction(140), 'ignore', '140 is inside the dead band — no store write')
assert.equal(panelDragAction(179), 'ignore', '179 is inside the dead band — no store write')
assert.equal(panelDragAction(180), 'resize', 'at 180 the drag resumes writing the width')
assert.equal(panelDragAction(0), 'collapse', 'far past the threshold still collapses')
assert.equal(panelDragAction(400), 'resize', 'ordinary widths resize')

// --- parsePanelLayout: defensive parsing of every raw shape ---

assert.deepEqual(
	parsePanelLayout('{not json'),
	{ width: 280, collapsed: false },
	'malformed JSON falls back to defaults'
)
assert.deepEqual(
	parsePanelLayout(JSON.stringify({ width: 'wide', collapsed: 'yes' })),
	{ width: 280, collapsed: false },
	'wrong-typed fields fall back to their defaults'
)
assert.deepEqual(
	parsePanelLayout(JSON.stringify({ width: 2000, collapsed: true })),
	{ width: 1600, collapsed: true },
	'a valid shape round-trips, with width clamped to the hard cap'
)
assert.deepEqual(
	parsePanelLayout(JSON.stringify({ somethingElse: true })),
	{ width: 280, collapsed: false },
	'an unrelated JSON shape falls back to defaults rather than crashing'
)

// --- setPanelWidth / setPanelCollapsed / togglePanelCollapsed: persist + notify ---
{
	let calls = 0
	const unsubscribe = subscribePanelLayout(() => {
		calls += 1
	})

	setPanelWidth(400)
	assert.equal(calls, 1, 'setPanelWidth should notify subscribers exactly once')
	assert.equal(getPanelLayout().width, 400, 'getPanelLayout reflects the update immediately')

	// Persisted to localStorage under the documented key, in the shape
	// parsePanelLayout expects — read it back through parsePanelLayout itself
	// so this assertion exercises the real round-trip, not just a string match.
	const raw = localStorage.getItem(STORAGE_KEY)
	assert.ok(raw, 'setPanelWidth should persist to localStorage')
	assert.deepEqual(parsePanelLayout(raw), { width: 400, collapsed: false })

	setPanelWidth(2000, 500)
	assert.equal(calls, 2, 'a second update should notify again, exactly once')
	assert.equal(getPanelLayout().width, 500, 'setPanelWidth clamps against a caller-supplied maxWidth')

	setPanelCollapsed(true)
	assert.equal(calls, 3)
	assert.equal(getPanelLayout().collapsed, true)

	togglePanelCollapsed()
	assert.equal(calls, 4)
	assert.equal(getPanelLayout().collapsed, false, 'toggle flips collapsed back to false')

	togglePanelCollapsed()
	assert.equal(calls, 5)
	assert.equal(getPanelLayout().collapsed, true, 'toggle flips collapsed again')

	// --- unsubscribe stops notifications ---
	unsubscribe()
	setPanelCollapsed(false)
	assert.equal(calls, 5, 'unsubscribed listener should not be notified')
	assert.equal(getPanelLayout().collapsed, false, 'the update itself still applies')
}

console.log('panelLayout.test.ts: all assertions passed')
