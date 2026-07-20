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

/** Breathing room kept to the right of a full-width tile so a maxed-out
 * mosaic doesn't look jammed against the panel edge. */
export const TILE_EDGE_MARGIN = 6

/**
 * The ceiling an explicitly SCALED tile may reach: the panel's own content
 * width, less a margin — so the slider can grow a tile until one fills the
 * row and then stops, rather than stopping at a fixed number with plenty of
 * panel left (which read as the control silently doing nothing).
 *
 * TILE_WIDTH_MAX still caps the DERIVED size, so the no-slider default keeps
 * its old behaviour: a lone participant in a dragged-wide panel doesn't
 * balloon unless the user asks for it.
 */
export function tileWidthCeiling(contentWidth: number): number {
	if (!Number.isFinite(contentWidth)) return TILE_WIDTH_MAX
	return Math.max(TILE_WIDTH_MIN, Math.floor(contentWidth - TILE_EDGE_MARGIN))
}

/**
 * Apply the user's tile-size multiplier to a derived tile width, re-clamping
 * so a scaled-down tile still clears the legibility floor and a scaled-up one
 * stops where a single tile fills the panel row (tileWidthCeiling). Kept
 * beside the derivation so both ends of the sizing story (fit, then taste)
 * share one clamp.
 */
export function scaleTileWidth(tileWidth: number, scale: number, ceiling: number): number {
	if (!Number.isFinite(scale)) return tileWidth
	const max = Math.max(TILE_WIDTH_MIN, ceiling)
	return Math.min(max, Math.max(TILE_WIDTH_MIN, Math.round(tileWidth * scale)))
}

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
