// A per-user latency sample older than this is dropped from /api/av/pulse — the
// client polls every PULSE_INTERVAL (~30s, client-side), so this is ~2.5×
// that: a user who misses one beat still shows; one who left disappears.
export const PULSE_STALE_MS = 75_000

// Colour + geo enums are protocol-by-naming: they live in @ensembleworks/contracts
// (browser-safe) and are re-exported here so sticky.ts/shape.ts keep their path.
export { NOTE_COLORS, GEO_TYPES } from '@ensembleworks/contracts'

// In-frame stickies land on a simple grid: 3 per row, 220px columns/rows.
export const STICKY_GRID_COLS = 3
export const STICKY_GRID_STEP = 220
