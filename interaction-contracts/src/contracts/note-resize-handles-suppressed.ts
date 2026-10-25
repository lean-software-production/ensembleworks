// note-fixed-size task — tldraw parity: NoteShapeUtil.hideResizeHandles()
// returns true and onResize() is a no-op, so a note's selection box shows NO
// resize handles at all (only rotate). The current (unfixed) v2 editor shows
// all 8 corner/edge handles for a note-only selection AND arms them —
// dragging one runs ResizeShapes, which only scales props.w/h; a note never
// stores w/h (create.ts's propsFor omits them for 'note'), so the ONLY thing
// that changes is the shape's x/y, scaled about the drag's fixed anchor.
//
// SCENE: one note at world (0,0), 200x200 — geometry.ts's size() ignores
// props.w/h for 'note' and hardcodes 200*scale (scale defaults to 1), so this
// scene shape's seeded w/h coincide exactly with its real rendered box; the
// SE corner handle (selectionHandles' layout) sits at world (200,200).
//
// tool: 'select+transform' — the real client composite (transform.ts gets
// first crack at every pointerdown, exactly like no-transform-while-typing's
// own precedent).
//
// THE DIVERGENT SIGNAL (why 'se' specifically, not an arbitrary handle): a
// corner-resize anchors the OPPOSITE corner — dragging 'se' anchors 'nw',
// which for THIS shape (seeded at its own local origin) is exactly
// shape.x/shape.y. editor.ts's ResizeShapes computes
// `x = anchor.x + (shape.x - anchor.x) * scaleX` — with shape.x === anchor.x
// === 0, x_new is 0 NO MATTER what scaleX the drag implies. So under the
// CURRENT (unfixed) code, dragging the note's 'se' corner by (60,60) leaves
// it FROZEN — shapeDisplacement stays (0,0) even though the pointer visibly
// dragged the handle 60 world units in each axis: the "resize does nothing
// but isn't supposed to be there at all" bug. Suppressing the handle (this
// task's fix) makes the SAME pointerdown MISS every corner/edge handle (only
// 'rotate' remains hittable for an all-fixed-size selection), so the gesture
// falls through to select.ts's ordinary body-drag instead — which DOES
// translate the note, by the FULL raw pointer delta (60,60), matching
// tldraw's real "a sticky is still draggable by its body, just never
// resizable" behavior.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:note-fixed-size'

export const noteResizeHandlesSuppressed: Contract = {
  name: 'note-resize-handles-suppressed',
  level: 'fsm',
  tool: 'select+transform',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'note', x: 0, y: 0, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Click-select (down+up, no movement) at the note's centre.
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'up' },
    // Grab the SE corner (centre + half-extent = world (200,200) — the SAME
    // handle-addressing convention no-transform-while-typing uses) and drag
    // it further out by (60,60).
    { kind: 'down', at: { ref: 'shape', id: ID, dx: 100, dy: 100 } },
    { kind: 'move', at: { ref: 'shape', id: ID, dx: 160, dy: 160 }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const d = obs.shapeDisplacement(ID)
    return d.dx === 60 && d.dy === 60
      ? null
      : `dragging the note's SE corner by (60,60) should translate it exactly like an ordinary body-drag (resize handles must be suppressed for an all-fixed-size selection), got displacement ${JSON.stringify(d)}`
  },
}
