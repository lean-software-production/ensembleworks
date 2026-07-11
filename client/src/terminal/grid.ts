/**
 * Deterministic terminal-grid geometry.
 *
 * The PTY grid (cols/rows) is shared by every viewer of a terminal. Rather than
 * have each client *measure* its DOM and *propose* a size (which races, because
 * measurements differ by zoom/font-timing/rounding), every client computes the
 * grid as a pure function of inputs that are identical everywhere: the shape's
 * logical w/h (tldraw-synced) and the base-font cell size (font-fixed, in CSS
 * px). Same inputs ⇒ same cols/rows ⇒ no proposer race to resolve.
 */

// Padding baked into the terminal box: the container style is "10px 20px 4px 12px"
// (top right bottom left; the 4px bottom keeps last-row descenders unclipped),
// and with scrollback:0 xterm reserves no scrollbar. KEEP IN SYNC with the
// containerRef padding in TerminalShapeUtil.tsx — one fact, recorded twice.
export const TERMINAL_PAD = { x: 12 + 20, y: 10 + 4 }

// Floor of the grid, matching the gateway's clamp (server/src/terminal-gateway.ts).
export const MIN_COLS = 20
export const MIN_ROWS = 5

export interface CellSize {
	w: number
	h: number
}

// Quantise a measured cell (CSS px) to 0.1px. Sub-pixel font-rendering
// differences between machines are well under 0.05px, so rounding to a 0.1px
// grid lands every client on the same value — which is what keeps two viewers
// from computing grids that differ by a row. The trade-off: the cell used can be
// up to ~0.05px off true, so the last column/row sits a hair off a perfect fit —
// but identically on every client, so nobody's terminal is resized to match.
export function quantizeCell(w: number, h: number): CellSize {
	return { w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 }
}

// The deterministic grid for a shape box and base-font cell size.
export function gridFor(w: number, h: number, cell: CellSize): { cols: number; rows: number } {
	return {
		cols: Math.max(MIN_COLS, Math.floor((w - TERMINAL_PAD.x) / cell.w)),
		rows: Math.max(MIN_ROWS, Math.floor((h - TERMINAL_PAD.y) / cell.h)),
	}
}
