/**
 * Run: bun client/src/chrome/roster.test.ts
 *
 * The panel roster: who appears under which page. Pure so it is testable
 * under bare bun — no editor, no DOM.
 */
import assert from 'node:assert/strict'
import { rosterByPage, type RosterEntry } from './roster'

const SELF_PREFIXED = 'user:self-1111'
const OTHER_PREFIXED = 'user:other-2222'
const PAGE_A = 'page:a'
const PAGE_B = 'page:b'

const self: RosterEntry = {
	prefixedId: SELF_PREFIXED,
	rawId: 'self-1111',
	name: 'Me',
	color: 'blue',
	isLocal: true,
}

function ids(map: Map<string, RosterEntry[]>, page: string): string[] {
	return (map.get(page) ?? []).map((entry) => entry.rawId)
}

// 1. Self lands under the page it is currently viewing.
{
	const byPage = rosterByPage({ self, currentPageId: PAGE_A, presences: [] })
	assert.deepEqual(ids(byPage, PAGE_A), ['self-1111'])
	assert.equal(byPage.size, 1, 'no empty pages are invented')
}

// 2. A collaborator joins under whichever page THEY are on, not ours.
{
	const byPage = rosterByPage({
		self,
		currentPageId: PAGE_A,
		presences: [{ userId: OTHER_PREFIXED, currentPageId: PAGE_B, userName: 'Sam', color: 'red' }],
	})
	assert.deepEqual(ids(byPage, PAGE_A), ['self-1111'])
	assert.deepEqual(ids(byPage, PAGE_B), ['other-2222'])
}

// 3. THE REGRESSION. A presence record for our OWN user must never become a
//    second roster entry. tldraw's sync server holds a closed session's
//    presence for SESSION_REMOVAL_WAIT_TIME (5s), so the tab that mounts on
//    the single-tab gate's recovery path — granted the lock about a
//    millisecond after the holder closed — receives a record for itself.
//    Without this filter the same person renders twice, and because tiles are
//    keyed on the raw user id, React also warns about duplicate keys for as
//    long as the tab lives.
{
	const byPage = rosterByPage({
		self,
		currentPageId: PAGE_A,
		presences: [{ userId: SELF_PREFIXED, currentPageId: PAGE_A, userName: 'Me', color: 'blue' }],
	})
	assert.deepEqual(ids(byPage, PAGE_A), ['self-1111'], 'our own ghost presence is not a second entry')
}

// 4. Our own ghost sitting on a DIFFERENT page must not conjure a roster entry
//    there either — that would show us as present on a page we are not on.
{
	const byPage = rosterByPage({
		self,
		currentPageId: PAGE_A,
		presences: [{ userId: SELF_PREFIXED, currentPageId: PAGE_B, userName: 'Me', color: 'blue' }],
	})
	assert.deepEqual(ids(byPage, PAGE_B), [], 'no phantom entry on the other page')
	assert.equal(byPage.has(PAGE_B), false, 'and no empty page bucket for it')
}

// 5. Filtering ours out leaves real teammates on the same page untouched.
{
	const byPage = rosterByPage({
		self,
		currentPageId: PAGE_A,
		presences: [
			{ userId: SELF_PREFIXED, currentPageId: PAGE_A, userName: 'Me', color: 'blue' },
			{ userId: OTHER_PREFIXED, currentPageId: PAGE_A, userName: 'Sam', color: 'red' },
		],
	})
	assert.deepEqual(ids(byPage, PAGE_A), ['self-1111', 'other-2222'], 'self first, teammate kept')
}

// 6. A nameless presence falls back to 'Anonymous' rather than rendering blank.
{
	const byPage = rosterByPage({
		self,
		currentPageId: PAGE_A,
		presences: [{ userId: OTHER_PREFIXED, currentPageId: PAGE_A, userName: '   ', color: 'red' }],
	})
	assert.equal(byPage.get(PAGE_A)![1]!.name, 'Anonymous')
}

console.log('roster.test.ts: all assertions passed')
