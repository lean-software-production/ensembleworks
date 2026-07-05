/**
 * Tests for roadmap-name slugification — the id under which a roadmap is
 * stored and fuzzily matched. Client (ui.tsx) and server (app.ts) both call
 * this; a drift here means pushes create duplicate roadmaps.
 * Run with: npx tsx contracts/src/slug.test.ts
 */
import assert from 'node:assert/strict'
import { slugify } from './slug.js'

// Ordinary names: lowercase, spaces collapse to single dashes.
assert.equal(slugify('Product Roadmap'), 'product-roadmap')
assert.equal(slugify('EnsembleWorks Roadmap'), 'ensembleworks-roadmap')
console.log('ok: ordinary names lowercase + dash')

// Names with no usable characters are invalid, not empty strings.
assert.equal(slugify('!!!'), null)
assert.equal(slugify('  ---  '), null, 'slug with no alphanumerics is invalid')
console.log('ok: no-alphanumeric names ⇒ null')

// Leading/trailing dashes are stripped before validation.
assert.equal(slugify('--x'), 'x')
assert.equal(slugify('x--'), 'x')
console.log('ok: leading/trailing dashes stripped')

// Truncation: a >64-char name slices to exactly 64 characters.
{
	const long = 'a'.repeat(100)
	const slug = slugify(long)
	assert.equal(slug, 'a'.repeat(64), 'long names truncate to 64 chars')
	assert.equal(slug?.length, 64)
	console.log('ok: >64-char names truncate to 64')
}

console.log('slug.test.ts: all tests passed')
