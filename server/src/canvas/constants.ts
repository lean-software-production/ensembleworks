// A per-user latency sample older than this is dropped from /api/pulse — the
// client polls every PULSE_INTERVAL (~30s, client-side), so this is ~2.5×
// that: a user who misses one beat still shows; one who left disappears.
export const PULSE_STALE_MS = 75_000

// The note colours tldraw's default schema accepts (see TLDefaultColorStyle).
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

// In-frame stickies land on a simple grid: 3 per row, 220px columns/rows.
export const STICKY_GRID_COLS = 3
export const STICKY_GRID_STEP = 220

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
