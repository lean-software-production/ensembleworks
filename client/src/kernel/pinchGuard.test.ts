/**
 * Run: bun src/kernel/pinchGuard.test.ts
 * Pure-structural test: a fake window records listeners; we invoke them with
 * fake events and assert preventDefault behaviour + uninstall symmetry.
 */
import assert from 'node:assert/strict'
import { installPinchGuard, type GuardWindow } from './pinchGuard'

type Entry = { type: string; fn: (e: any) => void; opts: unknown }
const added: Entry[] = []
const removed: Entry[] = []
const fakeWin: GuardWindow = {
	addEventListener: (type: string, fn: any, opts?: unknown) => added.push({ type, fn, opts }),
	removeEventListener: (type: string, fn: any, opts?: unknown) => removed.push({ type, fn, opts }),
}

const uninstall = installPinchGuard(fakeWin)

// 1. wheel listener registered non-passive + capture.
const wheel = added.find((e) => e.type === 'wheel')
assert.ok(wheel, 'wheel listener registered')
assert.deepEqual(wheel!.opts, { passive: false, capture: true })

// 2. ctrl+wheel and meta+wheel are preventDefaulted; plain wheel is not.
function fire(fn: (e: any) => void, mods: { ctrlKey?: boolean; metaKey?: boolean }): boolean {
	let prevented = false
	fn({ ctrlKey: false, metaKey: false, ...mods, preventDefault: () => { prevented = true } })
	return prevented
}
assert.equal(fire(wheel!.fn, { ctrlKey: true }), true, 'ctrl+wheel prevented')
assert.equal(fire(wheel!.fn, { metaKey: true }), true, 'meta+wheel prevented')
assert.equal(fire(wheel!.fn, {}), false, 'plain wheel untouched')

// 3. Safari gesture events registered and preventDefaulted.
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
	const g = added.find((e) => e.type === t)
	assert.ok(g, `${t} listener registered`)
	assert.equal(fire(g!.fn, {}), true, `${t} prevented`)
}

// 4. Uninstall removes exactly what was added (same fn + type pairs).
uninstall()
assert.equal(removed.length, added.length, 'uninstall removes every listener')
for (const r of removed) {
	assert.ok(added.some((a) => a.type === r.type && a.fn === r.fn), `removed ${r.type} matches added`)
}

console.log('pinchGuard.test.ts OK')
