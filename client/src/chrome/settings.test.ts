/**
 * Panel settings store: parseSettings defensive parsing + the
 * update/persist/subscribe seam. Run: bun client/src/chrome/settings.test.ts
 *
 * settings.ts reads localStorage at module-load time (`let settings =
 * readFromStorage()`), so the in-memory shim MUST be installed before the
 * module is imported. Static imports are hoisted above other top-level code,
 * so this uses a dynamic import() (after the shim) rather than a static one.
 */
import assert from 'node:assert/strict'

const STORAGE_KEY = 'ensembleworks.settings.v1'

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

const { parseSettings, getSettings, updateSettings, subscribeSettings } = await import('./settings')

// --- parseSettings: defensive parsing of every raw shape ---

// No value stored yet.
assert.deepEqual(parseSettings(null), { githubHandle: '' })

// Malformed JSON falls back to defaults rather than throwing.
assert.deepEqual(parseSettings('{not json'), { githubHandle: '' })

// A non-string field (wrong shape) is treated as absent.
assert.deepEqual(parseSettings(JSON.stringify({ githubHandle: 123 })), { githubHandle: '' })

// A valid value round-trips, trimmed.
assert.deepEqual(parseSettings(JSON.stringify({ githubHandle: '  octocat  ' })), {
	githubHandle: 'octocat',
})

// A completely unrelated JSON shape (missing the field entirely) also falls
// back to the default rather than crashing on a missing key.
assert.deepEqual(parseSettings(JSON.stringify({ somethingElse: true })), { githubHandle: '' })

// --- updateSettings: persists + notifies subscribers ---
{
	assert.equal(getSettings().githubHandle, '', 'starts from the shimmed empty store')

	let calls = 0
	const unsubscribe = subscribeSettings(() => {
		calls += 1
	})

	updateSettings({ githubHandle: 'ada' })
	assert.equal(calls, 1, 'updateSettings should notify subscribers exactly once')
	assert.equal(getSettings().githubHandle, 'ada', 'getSettings reflects the update immediately')

	// Persisted to localStorage under the documented key, in the shape
	// parseSettings expects — read it back through parseSettings itself so
	// this assertion exercises the real round-trip, not just a string match.
	const raw = localStorage.getItem(STORAGE_KEY)
	assert.ok(raw, 'update should persist to localStorage')
	assert.deepEqual(parseSettings(raw), { githubHandle: 'ada' })

	updateSettings({ githubHandle: 'grace' })
	assert.equal(calls, 2, 'a second update should notify again, exactly once')
	assert.equal(getSettings().githubHandle, 'grace')

	// --- unsubscribe stops notifications ---
	unsubscribe()
	updateSettings({ githubHandle: 'margaret' })
	assert.equal(calls, 2, 'unsubscribed listener should not be notified')
	assert.equal(getSettings().githubHandle, 'margaret', 'the update itself still applies')
}

console.log('settings.test.ts: all assertions passed')
