/**
 * Pure key-event → PTY-input mapping for the canvas terminal.
 *
 * Shift+Enter must insert a newline in TUIs (claude code) rather than submit,
 * but xterm.js encodes Shift+Enter identically to Enter (`\r`), so the app
 * inside can't tell them apart. We translate Shift+Enter (and Alt+Enter,
 * whose xterm encoding is platform-dependent) to ESC CR — the byte pair
 * Alt+Enter produces in native terminals — which claude code already treats
 * as "insert newline". Pure and dependency-free so it tests under plain bun.
 */

export interface EnterKeyEvent {
	type: string
	key: string
	shiftKey: boolean
	ctrlKey: boolean
	altKey: boolean
	metaKey: boolean
}

// ESC CR — what Alt+Enter sends in a native terminal.
export const NEWLINE_INPUT = '\x1b\r'

/**
 * The PTY input that should replace this key event, or null to let xterm
 * handle the key normally.
 */
export function ptyInputForKey(e: EnterKeyEvent): string | null {
	if (e.type !== 'keydown' || e.key !== 'Enter') return null
	if (e.ctrlKey || e.metaKey) return null
	return e.shiftKey || e.altKey ? NEWLINE_INPUT : null
}
