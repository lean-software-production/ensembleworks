/**
 * Mosaic sizing math (panel-video-mosaic spec "Sizing rules"): the current
 * page's participant grid is square-ish — columns = ceil(√N) — and tile
 * width derives from the panel's content width, so dragging the panel edge
 * is the ONE size control. No slider, nothing new persisted.
 *
 * MUST NOT import 'tldraw' — bare-bun test scripts import this module
 * (see panelLayout.ts's header comment for why that matters).
 */

/** Gap between mosaic tiles/chips, px (matches PanelPages' tile-list gap). */
export const MOSAIC_GAP = 6

/** Legibility floor for a current-page tile's width, px (spec: ~36px). */
export const TILE_WIDTH_MIN = 36

/**
 * Cap for a current-page tile's width, px — a lone participant in a dragged-
 * wide panel tops out here instead of ballooning (spec "N = 1" edge case).
 * Matches PanelTile's previous TILE_MAX_WIDTH so the biggest tile looks the
 * same as before the mosaic.
 */
export const TILE_WIDTH_MAX = 320

/** Width at/above which a tile shows its name/control strip and overlays. */
export const LABEL_MIN_WIDTH = 64

/** Fixed size of an other-page ambient chip, px. 40 is the floor of face
 * recognisability for the live micro-video the chips carry — big enough to
 * see who it is at a glance, still clearly subordinate to the current page's
 * tiles. */
export const CHIP_SIZE = 40

/** Square-ish grid: columns = ceil(√N), min 1. */
export function mosaicColumns(count: number): number {
	if (!Number.isFinite(count) || count < 1) return 1
	return Math.ceil(Math.sqrt(count))
}

/**
 * Tile width for the current page's grid: fill the content width minus
 * inter-tile gaps, clamped to [TILE_WIDTH_MIN, TILE_WIDTH_MAX]. The floor can
 * exceed what fits — the grid then wraps to more rows (CSS handles it); it
 * never scrolls horizontally and never hides anyone (spec invariant).
 */
export function mosaicTileWidth(contentWidth: number, count: number): number {
	// Degenerate headcount (0 or invalid): no grid to fill, so report the max
	// rather than a content-width-derived guess. Callers skip rendering
	// entirely when there are 0 participants.
	if (!Number.isFinite(count) || count < 1) return TILE_WIDTH_MAX
	const cols = mosaicColumns(count)
	const raw = Math.floor((contentWidth - MOSAIC_GAP * (cols - 1)) / cols)
	return Math.min(TILE_WIDTH_MAX, Math.max(TILE_WIDTH_MIN, raw))
}
