/**
 * The two async DOM leaves the clipboard shortcuts need — kept in their own
 * module so `navigator.clipboard` is isolated behind a tiny, swappable
 * surface (Task D1's file-list note: "keeps navigator.clipboard isolated +
 * unit-mockable"), and so `clipboardShortcut` (the actual key -> action
 * DECISION, pure and DOM-free) is unit-testable without a real clipboard —
 * canvas-v2/CanvasV2App.tsx's `handleGlobalShortcut` is the only caller of
 * either half, and composes them (D-7's cut ordering — write before delete —
 * lives THERE, not here, same as `deleteSelectionIntents`/
 * `duplicateSelectionIntents`/`pasteIntents` composition already does for
 * Delete/Ctrl+D/Ctrl+V).
 */
import type { KeyInputEvent } from '@ensembleworks/canvas-editor'

export type ClipboardAction = 'copy' | 'cut' | 'paste' | 'duplicate'

/**
 * Pure decision: does this keydown mean a clipboard/duplicate shortcut, and
 * which one? Gated on `editingId === null` exactly like Escape/Delete/undo
 * in CanvasV2App.tsx's `handleGlobalShortcut` (TextEditor owns Ctrl+C/X/V —
 * real text copy/cut/paste — and Ctrl+D has no meaning inside a text field —
 * while a shape is being text-edited). `event.key` is compared
 * case-insensitively (same reasoning as the undo/redo z-branch: a real
 * browser reports the shifted letter's case differently across platforms),
 * and either `ctrl` or `meta` counts as "the modifier" (Ctrl on
 * Windows/Linux, Cmd on Mac) for all four — unlike undo/redo's Ctrl+Y-is-
 * ctrl-only carve-out, none of C/X/V/D collide with a Mac-native shortcut EW
 * must avoid stealing.
 */
export function clipboardShortcut(event: KeyInputEvent, editingId: string | null): { action: ClipboardAction } | null {
	if (editingId !== null) return null
	if (!(event.modifiers.ctrl || event.modifiers.meta)) return null
	switch (event.key.toLowerCase()) {
		case 'c':
			return { action: 'copy' }
		case 'x':
			return { action: 'cut' }
		case 'v':
			return { action: 'paste' }
		case 'd':
			return { action: 'duplicate' }
		default:
			return null
	}
}

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
