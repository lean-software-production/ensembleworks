/**
 * Conventions that were previously protocol-by-naming across app.ts and
 * terminal-gateway.ts. (bin/canvas keeps an independent bash copy of the
 * status list until it is retired in Phase 3.)
 */

/** Valid values of the terminal shape's status light (POST /api/terminal/status). */
export const TERMINAL_STATUSES = ['working', 'needs-you', 'done', 'idle'] as const
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

/** Type guard for validating client-supplied status strings. */
export function isTerminalStatus(s: string): s is TerminalStatus {
	return (TERMINAL_STATUSES as readonly string[]).includes(s)
}

/** tmux sessions backing canvas terminals are named `canvas-<sessionId>`. */
export const TMUX_SESSION_PREFIX = 'canvas-'
