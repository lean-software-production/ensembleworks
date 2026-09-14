/** Thin, unit-mockable wrapper over `navigator.clipboard.writeText` — the
 * ONLY place this module touches the real DOM clipboard API on the write
 * side. */
export async function writeClipboardText(text: string): Promise<void> {
	await navigator.clipboard.writeText(text)
}

/** Thin, unit-mockable wrapper over `navigator.clipboard.readText` — the
 * ONLY place this module touches the real DOM clipboard API on the read
 * side. */
export async function readClipboardText(): Promise<string> {
	return navigator.clipboard.readText()
}
