// Resize/rotate handles. Layout comes VERBATIM from canvas-editor's
// `selectionHandles(bounds)` (transform.ts) — this file never re-derives
// handle offsets itself; it only converts that single source of truth's
// WORLD-space points to screen and draws fixed-screen-size glyphs at them.
//
// SCOPE LIMIT (cited, not re-decided here): transform.ts's own module header
// documents that a single ROTATED shape's handles are laid out against its
// AXIS-ALIGNED worldBounds union, not rotated with the shape — "an explicit
// SCOPE LIMIT (OURS): tldraw aligns a lone selected shape's handles to ITS
// OWN rotation; matching that is Phase 4/5 tldraw-parity polish". Because
// this component's `bounds` prop is exactly `combinedWorldBounds` (Selection.
// tsx) — the same AABB-union transform.ts's own selectionWorldBounds
// computes — a single rotated shape's handles come out axis-aligned here too,
// automatically, with no special-casing: this component inherits the scope
// limit rather than re-deciding it.
import { HIT_TOLERANCE_PX, selectionHandles, worldToScreen, type Camera, type Handle } from '@ensembleworks/canvas-editor'
import type { Bounds } from '@ensembleworks/canvas-model'

export interface HandlesProps {
  readonly bounds: Bounds | null
  readonly camera: Camera
}

// Rendered handle size, SCREEN pixels, zoom-independent (a fixed px square at
// every zoom — see the module header's "fixed screen-size glyphs"). IMPORTED
// from transform.ts's own hit-tolerance constant (HIT_TOLERANCE_PX, exported
// for exactly this consumer — see its doc comment there), used as the
// rendered square's SIDE LENGTH (not diameter): 8px, so the visible handle
// sits comfortably inside its own 8px-RADIUS (16px-diameter) hit-tolerance
// disk with a few px of forgiving margin around the glyph. One constant, two
// consumers — hitHandle's tolerance and this glyph size can't silently drift
// apart. OURS: not tuned against tldraw's own handle chrome.
const HANDLE_SIZE_PX = HIT_TOLERANCE_PX
const ROTATE_HANDLE_RADIUS_PX = 5

const HANDLE_FILL = 'var(--canvas-handle, #ffffff)'
const HANDLE_STROKE = 'var(--canvas-handle-stroke, #4b8bf4)'

export function Handles({ bounds, camera }: HandlesProps) {
  if (!bounds) return null
  const handles: Handle[] = selectionHandles(bounds)

  return (
    <>
      {handles.map((h) => {
        const s = worldToScreen(camera, h.point)
        if (h.kind === 'rotate') {
          return (
            <circle
              key={h.id}
              data-overlay="handle"
              data-handle-id={h.id}
              data-handle-kind={h.kind}
              cx={s.x}
              cy={s.y}
              r={ROTATE_HANDLE_RADIUS_PX}
              fill={HANDLE_FILL}
              stroke={HANDLE_STROKE}
              strokeWidth={1}
            />
          )
        }
        return (
          <rect
            key={h.id}
            data-overlay="handle"
            data-handle-id={h.id}
            data-handle-kind={h.kind}
            x={s.x - HANDLE_SIZE_PX / 2}
            y={s.y - HANDLE_SIZE_PX / 2}
            width={HANDLE_SIZE_PX}
            height={HANDLE_SIZE_PX}
            fill={HANDLE_FILL}
            stroke={HANDLE_STROKE}
            strokeWidth={1}
          />
        )
      })}
    </>
  )
}
