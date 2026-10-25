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

/**
 * Canvas-v2 S6 decision threshold: the multiplier over which a room's
 * on-disk SQLite file size ÷ live in-memory snapshot size is treated as a
 * sustained disk high-water signal ("VACUUM likely needed"). Single-sourced
 * HERE so the server soak (`server/src/canvas-v2/soak-actor.ts`'s
 * `assertDiskHighWater` — the S6 soak verdict) and the client dogfood dev
 * overlay (`client/src/canvas-v2/DevOverlay.tsx` — the live disk:snapshot
 * ratio flag) share ONE number instead of two hand-synced copies across the
 * server/client boundary (Task I1's S6 verdict cites both). 10x sits
 * comfortably above every measured soak run's last-quartile ratio while
 * still catching a genuine compaction regression.
 */
export const DISK_SUSTAINED_HIGHWATER_MULTIPLIER = 10

// The note colours tldraw's default schema accepts (see TLDefaultColorStyle).
// Owned by contracts (protocol-by-naming); re-exported from the server's
// canvas/constants.ts so its importers keep their path.
export const NOTE_COLORS = [
	'black',
	'grey',
	'light-violet',
	'violet',
	'blue',
	'light-blue',
	'yellow',
	'orange',
	'green',
	'light-green',
	'light-red',
	'red',
	'white',
]

// The geo styles tldraw's default schema accepts (see GeoShapeGeoStyle).
export const GEO_TYPES = [
	'cloud',
	'rectangle',
	'ellipse',
	'triangle',
	'diamond',
	'pentagon',
	'hexagon',
	'octagon',
	'star',
	'rhombus',
	'rhombus-2',
	'oval',
	'trapezoid',
	'arrow-right',
	'arrow-left',
	'arrow-up',
	'arrow-down',
	'x-box',
	'check-box',
	'heart',
]
