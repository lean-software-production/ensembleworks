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

/** Structural slice of xterm.js Terminal — contracts must not depend on
 *  @xterm/xterm; the client passes its real Terminal instance. */
export interface IdentityTerminal {
	parser: {
		registerCsiHandler(
			id: { prefix?: string; intermediates?: string; final: string },
			cb: (params: (number | number[])[]) => boolean,
		): unknown
		registerOscHandler(ident: number, cb: (data: string) => boolean): unknown
	}
}

/**
 * Defense-in-depth for connector-backed terminals: the connector's responder
 * normally removes every query before fan-out; these handlers make a browser
 * that sees one anyway stay silent. Return true = handled (no auto-reply);
 * return false = default xterm behaviour (used for setter/ambiguous forms).
 *
 * NEVER registers a final:'R' handler (CPR-reply shape = modified F3 shape,
 * field report §8) and never suppresses CSI 6n (pty-backend CPR must flow).
 */
export function registerTerminalIdentityHandlers(term: IdentityTerminal): void {
	const p = term.parser
	p.registerCsiHandler({ final: 'c' }, () => true) // DA1
	p.registerCsiHandler({ prefix: '>', final: 'c' }, () => true) // DA2
	p.registerCsiHandler({ prefix: '=', final: 'c' }, () => true) // DA3
	p.registerCsiHandler({ final: 'n' }, (params) => params[0] === 5) // DSR-5 only; 6n → false
	p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => true) // DECRQM
	p.registerCsiHandler({ prefix: '>', final: 'q' }, () => true) // XTVERSION
	p.registerCsiHandler({ prefix: '?', final: 'u' }, () => true) // kitty probe
	for (const ident of [10, 11] as const) {
		p.registerOscHandler(ident, (data) => data === '?') // query form only
	}
}
