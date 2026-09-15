// Run: bun src/autosize.test.ts
import assert from 'node:assert/strict'
import type { Shape } from '@ensembleworks/canvas-model'
import { computeAutosizeProps } from './autosize.js'

function shape(kind: Shape['kind'], props: Record<string, unknown>): Shape {
  return {
    id: 'shape:1', kind, parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props,
  } as Shape
}

// 1. Non-text-capable kinds never autosize.
{
  const s = shape('draw', {})
  assert.equal(computeAutosizeProps(s, { width: 500, height: 500 }), null)
}

// 2. text kind: grows w/h to exactly fit the measured size.
{
  const s = shape('text', { w: 200, h: 40 })
  assert.deepEqual(computeAutosizeProps(s, { width: 340.4, height: 88.6 }), { w: 340, h: 89 })
}

// 3. text kind: no-op when measured size already matches current props.
{
  const s = shape('text', { w: 200, h: 40 })
  assert.equal(computeAutosizeProps(s, { width: 200, height: 40 }), null)
}

// 4. text kind: shrinks back down when text gets shorter (tldraw parity —
//    autoSize is not monotonic, unlike note/geo's growY-only convention).
{
  const s = shape('text', { w: 400, h: 200 })
  assert.deepEqual(computeAutosizeProps(s, { width: 50, height: 20 }), { w: 50, h: 20 })
}

// 5. text kind: floors to 1px so an emptied shape never collapses to zero.
{
  const s = shape('text', { w: 200, h: 40 })
  assert.deepEqual(computeAutosizeProps(s, { width: 0, height: 0 }), { w: 1, h: 1 })
}

// 6. note: growY only kicks in once measured height exceeds the fixed 200
//    baseline; the note's own props.w/h (never read by geometry.ts's size()
//    for a note) are irrelevant.
{
  const s = shape('note', { w: 999, h: 999 })
  assert.equal(computeAutosizeProps(s, { width: 180, height: 150 }), null)
  assert.deepEqual(computeAutosizeProps(s, { width: 180, height: 260 }), { growY: 60 })
}

// 7. note: growY never goes negative, and is a no-op once already at the
//    right value (avoids a redundant UpdateProps dispatch every keystroke).
{
  const s = shape('note', { growY: 60 })
  assert.equal(computeAutosizeProps(s, { width: 180, height: 260 }), null)
  assert.deepEqual(computeAutosizeProps(s, { width: 180, height: 150 }), { growY: 0 })
}

// 8. geo: growY is measured against the shape's OWN stored props.h (not a
//    fixed baseline like note), falling back to geometry.ts's 120 default
//    when props.h is absent.
{
  const s = shape('geo', { w: 150, h: 80 })
  assert.equal(computeAutosizeProps(s, { width: 130, height: 70 }), null)
  assert.deepEqual(computeAutosizeProps(s, { width: 130, height: 110 }), { growY: 30 })
}
{
  const s = shape('geo', {})
  assert.deepEqual(computeAutosizeProps(s, { width: 100, height: 150 }), { growY: 30 })
}

console.log('autosize.test.ts: all assertions passed')
