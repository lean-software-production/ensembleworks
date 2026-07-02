/**
 * Pure identity-colour palette. Run: npx tsx src/colors.test.ts
 */
import assert from 'node:assert/strict'
import {
	IDENTITY_COLORS,
	colorKeyForId,
	hexForColor,
	isIdentityColor,
	type IdentityColor,
} from './colors'

// Exactly 10 colourful keys, no black/grey.
assert.equal(IDENTITY_COLORS.length, 10)
assert.ok(!IDENTITY_COLORS.includes('black' as IdentityColor))
assert.ok(!IDENTITY_COLORS.includes('grey' as IdentityColor))

// Deterministic: same id → same key, always a member of the palette.
const a = colorKeyForId('user-abc')
assert.equal(colorKeyForId('user-abc'), a)
assert.ok(IDENTITY_COLORS.includes(a))

// Different ids can differ (sanity: the hash spreads across the palette).
const spread = new Set(
	Array.from({ length: 200 }, (_, i) => colorKeyForId(`id-${i}`))
)
assert.ok(spread.size >= 5, `hash should spread across palette, got ${spread.size}`)

// isIdentityColor validates overrides.
assert.equal(isIdentityColor('blue'), true)
assert.equal(isIdentityColor('black'), false)
assert.equal(isIdentityColor('nonsense'), false)
assert.equal(isIdentityColor(null), false)
assert.equal(isIdentityColor(42), false)

// Every key resolves to a #rrggbb hex in both themes.
for (const key of IDENTITY_COLORS) {
	for (const isDark of [false, true]) {
		const hex = hexForColor(key, isDark)
		assert.match(hex, /^#[0-9a-f]{6}$/i, `${key} ${isDark ? 'dark' : 'light'} -> ${hex}`)
	}
}

// Spot-check known values against tldraw's default palette.
assert.equal(hexForColor('blue', false), '#4465e9')
assert.equal(hexForColor('blue', true), '#4f72fc')
assert.equal(hexForColor('red', false), '#e03131')

console.log('colors.test.ts: all tests passed')
