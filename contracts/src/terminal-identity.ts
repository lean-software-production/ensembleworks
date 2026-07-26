/**
 * The product's declared terminal identity for shared (multi-viewer)
 * terminals on the codespaces connector plane. Browser-safe: strings only,
 * no Node APIs, no xterm import (the registration helper uses structural
 * typing). Spec: docs/superpowers/specs/2026-07-26-terminal-fanin-design.md.
 *
 * The legacy gateway (server/src/terminal-gateway.ts) never imports this —
 * plane independence is a spec decision, not an accident.
 */

/** Single source for the terminal's canonical colours. client/src/theme.ts
 *  imports these (contracts must never import client). */
export const TERMINAL_CANONICAL_COLORS = {
	background: '#fff',
	foreground: '#0f172a',
} as const

/** DECRPM states: 0 = not recognised, 1 = set, 2 = reset. */
export const TRACKED_MODES = [2004, 2026, 1016] as const

export const CAPABILITY_PROFILE = {
	da1: '\x1b[?1;2c',
	da2: '\x1b[>0;276;0c',
	dsrOk: '\x1b[0n',
	/** Initial DECRPM state per profiled mode. 1004 is DECLARED unsupported
	 *  (shared focus is meaningless); anything absent answers 0. */
	modes: { 2004: 2, 2026: 2, 1016: 2, 1004: 0 } as Record<number, 0 | 2>,
} as const

/** xterm's OSC colour replies double 8-bit channels to 16-bit (xx → xxxx). */
function rgbSpec(hex: string): string {
	const h = hex.replace('#', '')
	const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
	const [r, g, b] = [full.slice(0, 2), full.slice(2, 4), full.slice(4, 6)]
	return `rgb:${r}${r}/${g}${g}/${b}${b}`
}

export function oscColorReply(ps: 10 | 11): string {
	const hex = ps === 11 ? TERMINAL_CANONICAL_COLORS.background : TERMINAL_CANONICAL_COLORS.foreground
	return `\x1b]${ps};${rgbSpec(hex)}\x1b\\`
}
