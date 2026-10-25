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
	setTileScale,
	clampTileScale,
	scaleForSliderPosition,
	sliderPositionForScale,
	setPanelCollapsed,
	togglePanelCollapsed,
	subscribePanelLayout,
} = await import('./panelLayout')

// --- defaults ---

assert.deepEqual(parsePanelLayout(null), { width: 280, collapsed: false, tileScale: 1 })
assert.deepEqual(
	getPanelLayout(),
	{ width: 280, collapsed: false, tileScale: 1 },
	'module starts from defaults against the shimmed empty store'
)

// --- clampTileScale + the stored multiplier ---
assert.equal(clampTileScale(1), 1)
assert.equal(clampTileScale(0.75), 0.75, 'in-range values pass through')
assert.equal(clampTileScale(0.01), 0.5, 'below the floor clamps up')
assert.equal(clampTileScale(9), 2, 'above the ceiling clamps down')
assert.equal(clampTileScale(NaN), 1, 'non-finite falls back to the default')
// A stored scale round-trips; a malformed one falls back rather than throwing.
assert.equal(parsePanelLayout('{"width":280,"collapsed":false,"tileScale":1.5}').tileScale, 1.5)
assert.equal(parsePanelLayout('{"width":280,"collapsed":false,"tileScale":"big"}').tileScale, 1)
assert.equal(
	parsePanelLayout('{"width":280,"collapsed":false}').tileScale,
	1,
	'layouts stored before tileScale existed still parse'
)
setTileScale(2)
assert.equal(getPanelLayout().tileScale, 2)
setTileScale(99)
assert.equal(getPanelLayout().tileScale, 2, 'setter clamps')
setTileScale(1)

// --- geometric slider mapping: 1x dead centre, halve/double symmetric ---
assert.equal(scaleForSliderPosition(0), 0.5, 'left end halves')
assert.equal(scaleForSliderPosition(1), 2, 'right end doubles')
assert.equal(scaleForSliderPosition(0.5), 1, 'MIDDLE of the track is exactly 1x')
assert.equal(sliderPositionForScale(1), 0.5, 'and 1x maps back to the middle')
assert.equal(sliderPositionForScale(0.5), 0)
assert.equal(sliderPositionForScale(2), 1)
// Equal travel multiplies by an equal factor (the point of geometric). The
// stored value is rounded to 2dp, so compare the ratios within that rounding
// rather than exactly.
const nearlyEqual = (a: number, b: number, why: string) =>
	assert.ok(Math.abs(a - b) < 0.02, `${why}: ${a} vs ${b}`)
const q1 = scaleForSliderPosition(0.25)
const q3 = scaleForSliderPosition(0.75)
nearlyEqual(q1 / 0.5, 1 / q1, 'quarter-track is the same factor either side')
nearlyEqual(q3 / 1, 2 / q3, 'three-quarter-track likewise')
// Values the mapping can actually produce round-trip stably (2dp rounding
// means an arbitrary scale may land on the neighbouring step, which is fine —
// what matters is that dragging to a position and back doesn't drift).
for (const position of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
	const scale = scaleForSliderPosition(position)
	assert.equal(
		scaleForSliderPosition(sliderPositionForScale(scale)),
		scale,
		`round-trip at position ${position}`
	)
}
assert.equal(scaleForSliderPosition(NaN), 1, 'non-finite position falls back to 1x')
assert.equal(scaleForSliderPosition(5), 2, 'out-of-range position clamps')

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
	{ width: 280, collapsed: false, tileScale: 1 },
	'malformed JSON falls back to defaults'
)
assert.deepEqual(
	parsePanelLayout(JSON.stringify({ width: 'wide', collapsed: 'yes' })),
	{ width: 280, collapsed: false, tileScale: 1 },
	'wrong-typed fields fall back to their defaults'
)
assert.deepEqual(
	parsePanelLayout(JSON.stringify({ width: 2000, collapsed: true, tileScale: 1 })),
	{ width: 1600, collapsed: true, tileScale: 1 },
	'a valid shape round-trips, with width clamped to the hard cap'
)
assert.deepEqual(
	parsePanelLayout(JSON.stringify({ somethingElse: true })),
	{ width: 280, collapsed: false, tileScale: 1 },
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
	assert.deepEqual(parsePanelLayout(raw), { width: 400, collapsed: false, tileScale: 1 })

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
