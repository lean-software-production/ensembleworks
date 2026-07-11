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

// Shared per-terminal font size: one PTY grid per terminal, so font size is
// a property of the terminal, not the viewer. Clamped so the deterministic
// grid stays sane (MIN keeps cols/rows finite; MAX keeps the WebGL atlas in
// its comfort zone in view mode).
export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 32
export const FONT_SIZE_DEFAULT = 16

export type FontSizeAction = 'up' | 'down' | 'reset'

// Ctrl/Cmd +/- (and 0 to reset) while editing. '=' is the unshifted '+' key,
// '_' the shifted '-'. Alt combos are left alone (tmux Meta bindings).
// Known trade-off: while editing, Ctrl+-/_ can no longer reach the PTY as
// 0x1F (readline undo, C-_). Deliberate — GNOME Terminal/Konsole shadow the
// same keys for font zoom, and readline's C-x C-u remains available.
export function fontSizeActionForKey(e: EnterKeyEvent): FontSizeAction | null {
	if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || e.altKey) return null
	if (e.key === '+' || e.key === '=') return 'up'
	if (e.key === '-' || e.key === '_') return 'down'
	if (e.key === '0') return 'reset'
	return null
}

export function nextFontSize(current: number, action: FontSizeAction): number {
	if (action === 'reset') return FONT_SIZE_DEFAULT
	const next = action === 'up' ? current + 1 : current - 1
	return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, next))
}
