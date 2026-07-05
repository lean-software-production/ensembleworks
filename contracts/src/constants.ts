/**
 * Conventions that were previously protocol-by-naming across app.ts,
 * terminal-gateway.ts and bin/canvas.
 */

/** Valid values of the terminal shape's status light (POST /api/terminal-status). */
export const TERMINAL_STATUSES = ['working', 'needs-you', 'done', 'idle'] as const
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

/** tmux sessions backing canvas terminals are named `canvas-<sessionId>`. */
export const TMUX_SESSION_PREFIX = 'canvas-'
