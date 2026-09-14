/**
 * The pure key -> clipboard/duplicate action DECISION (Task D1) — DOM-free
 * and unit-testable, so the actual clipboard I/O each host needs (the web
 * app's own `client/src/canvas-v2/clipboard-dom.ts` wraps
 * `navigator.clipboard`; the bb plugin host ports its own equivalent) stays
 * outside canvas-editor's clean-room boundary. Each host's own global
 * shortcut handler is the only caller of both halves, and composes them
 * (D-7's cut ordering — write before delete — lives THERE, not here, same as
 * `deleteSelectionIntents`/`duplicateSelectionIntents`/`pasteIntents`
 * composition already does for Delete/Ctrl+D/Ctrl+V).
 */
import type { KeyInputEvent } from '../input.js'

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
