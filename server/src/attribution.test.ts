// Helper unit test (network-free, no server boot): resolveAttribution's per-
// caller-class semantics and badgeText's single-badge / empty-text no-op rules.
// Run with: bun src/attribution.test.ts
import assert from 'node:assert/strict'
import type { Whoami } from '@ensembleworks/contracts'
import { badgeText, resolveAttribution } from './kernel/attribution.ts'

const bot: Whoami = { identity: '🤖 rw', kind: 'bot', via: 'service-token' }
const human: Whoami = { identity: 'Alice', kind: 'human', via: 'sso' }
const anon: Whoami = { identity: null, kind: 'anonymous', via: 'none' }

// Credential wins, always — body.author is ignored, both sinks use the identity.
assert.deepEqual(resolveAttribution(bot, 'forged'), { metaAuthor: '🤖 rw', display: '🤖 rw' })
assert.deepEqual(resolveAttribution(human, undefined), { metaAuthor: 'Alice', display: 'Alice' })

// Anonymous + voluntary author → cosmetic display only, never structured.
assert.deepEqual(resolveAttribution(anon, 'dave'), { metaAuthor: null, display: 'dave' })

// Anonymous, no / empty / whitespace author → stamp nothing.
for (const empty of [undefined, '', '   ']) {
	assert.deepEqual(resolveAttribution(anon, empty), { metaAuthor: null, display: null })
}

// badgeText: exactly one 🤖 (a display already leading with 🤖 is stripped first).
assert.equal(badgeText('hi', '🤖 codespace-3'), '🤖 codespace-3: hi')
assert.equal(badgeText('hi', 'Alice'), '🤖 Alice: hi')
assert.equal(badgeText('hi', null), 'hi')

// badgeText: empty / whitespace text is a no-op — no floating 🤖 name: orphan.
assert.equal(badgeText('', '🤖 rw'), '')
assert.equal(badgeText('   ', '🤖 rw'), '   ')

console.log('ok: attribution helper — credential wins, anonymous cosmetic-only, single badge, empty-text no-op')
