/**
 * The per-user identity palette. A user's colour is one of tldraw's named
 * shape colours, so their sticky fill, their next-drawn shape, their cursor/
 * presence ring, and their screenshare border are all literally the same
 * colour. Kept pure (no localStorage / window / tldraw import) so it is
 * unit-testable under `npx tsx` — identity.ts adds the storage layer on top.
 */

// The "colourful" subset of tldraw's DefaultColorStyle values (black/grey are
// not identity-worthy). These strings ARE valid DefaultColorStyle values, so
// they can be passed straight to setStyleForNextShapes / note-shape colour.
export const IDENTITY_COLORS = [
	'blue',
	'light-blue',
	'green',
	'light-green',
	'violet',
	'light-violet',
	'orange',
	'yellow',
	'red',
	'light-red',
] as const

export type IdentityColor = (typeof IDENTITY_COLORS)[number]

// Solid hex per tldraw's default theme (light/dark). Baked as a constant rather
// than read from getDefaultColorTheme() so this module stays pure and testable
// under tsx (tldraw's entry isn't importable in node). Source: @tldraw/editor
// DefaultColorThemePalette. Re-sync if tldraw ever restyles its palette.
const IDENTITY_HEX: Record<IdentityColor, { light: string; dark: string }> = {
	blue: { light: '#4465e9', dark: '#4f72fc' },
	'light-blue': { light: '#4ba1f1', dark: '#4dabf7' },
	green: { light: '#099268', dark: '#099268' },
	'light-green': { light: '#4cb05e', dark: '#40c057' },
	violet: { light: '#ae3ec9', dark: '#ae3ec9' },
	'light-violet': { light: '#e085f4', dark: '#e599f7' },
	orange: { light: '#e16919', dark: '#f76707' },
	yellow: { light: '#f1ac4b', dark: '#ffc034' },
	red: { light: '#e03131', dark: '#e03131' },
	'light-red': { light: '#f87777', dark: '#ff8787' },
}

export function hexForColor(key: IdentityColor, isDark: boolean): string {
	return IDENTITY_HEX[key][isDark ? 'dark' : 'light']
}

function hashCode(s: string): number {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
	return Math.abs(h)
}

/** Deterministic default colour for a user id (stable across sessions). */
export function colorKeyForId(id: string): IdentityColor {
	return IDENTITY_COLORS[hashCode(id) % IDENTITY_COLORS.length]!
}

export function isIdentityColor(x: unknown): x is IdentityColor {
	return typeof x === 'string' && (IDENTITY_COLORS as readonly string[]).includes(x)
}
