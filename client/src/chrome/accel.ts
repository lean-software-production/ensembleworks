/**
 * Accelerator-label helpers for the command bar (canvas-controls spec §4):
 * labels carry their shortcut as an underlined letter, menu-accelerator style.
 */

export interface AccelSplit {
	pre: string
	hit: string
	post: string
}

/** Split `label` around the first occurrence of `accelerator` (case-insensitive),
 * or null when there's nothing to underline. */
export function splitAccelLabel(label: string, accelerator?: string): AccelSplit | null {
	if (!accelerator) return null
	const idx = label.toLowerCase().indexOf(accelerator.toLowerCase())
	if (idx === -1) return null
	return { pre: label.slice(0, idx), hit: label.slice(idx, idx + 1), post: label.slice(idx + 1) }
}

/**
 * Pick the display key for a tldraw kbd string ('v,s' = alternatives; !?$ are
 * modifier prefixes). Prefers an alternative that occurs in the label (so
 * 'v,s' + 'select' → 's'); falls back to the first modifier-free alternative;
 * null when every alternative needs a modifier (never shown inline).
 */
export function displayKeyForKbd(kbd: string | undefined, label: string): string | null {
	if (!kbd) return null
	const plain = kbd
		.split(',')
		.map((alt) => alt.trim())
		.filter((alt) => alt.length === 1 && !/[!?$]/.test(alt))
	if (plain.length === 0) return null
	return plain.find((alt) => label.toLowerCase().includes(alt.toLowerCase())) ?? plain[0]!
}
