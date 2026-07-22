// Run: bun src/serialization-seam.test.ts
// Loro stores `undefined` as `null`. Validating the PRE-serialization object
// therefore judges a different value than the one repair() will later judge on
// read-back — the seam that let `{ w: undefined }` pass the write boundary and
// then be cascade-deleted by repair(). See the plan's Task 4N.
import assert from 'node:assert/strict'
import { validateShape } from '@ensembleworks/canvas-model'
import { LoroCanvasDoc, asStored } from './loro-canvas-doc.js'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} });

// --- The reported reproduction, closed at BOTH call sites ---
// The assertion that matters is the READ-BACK one: it is not enough that the
// write was refused, the doc must be left in a state repair() will not act on.
{
  const doc = LoroCanvasDoc.create({ peerId: 20n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:f', kind: 'frame', parentId: 'page:p', props: { w: 100, h: 100 }, ...base() } as never)
  doc.putShape({ id: 'shape:kid', kind: 'note', parentId: 'shape:f', props: {}, ...base() } as never)
  doc.commit()

  // updateProps half.
  doc.updateProps('shape:f', { w: undefined })
  assert.equal(doc.invalidWriteCount, 1, 'updateProps rejects a patch that would STORE null in a typed field')
  assert.deepEqual(doc.getShape('shape:f')!.props, { w: 100, h: 100 }, 'props untouched')
  assert.ok(validateShape(doc.getShape('shape:f')).ok, 'READ-BACK still validates — repair() has nothing to act on')

  // putShape half — same hole, pre-existing.
  doc.putShape({ id: 'shape:g', kind: 'frame', parentId: 'page:p', props: { w: undefined, h: 1 }, ...base() } as never)
  assert.equal(doc.invalidWriteCount, 2, 'putShape rejects it too')
  assert.equal(doc.getShape('shape:g'), undefined, 'nothing was written')

  // Envelope fields leak the same way, not just props.
  doc.putShape({ id: 'shape:h', kind: 'frame', parentId: 'page:p', props: {}, ...base(), x: undefined } as never)
  assert.equal(doc.invalidWriteCount, 3, 'an undefined ENVELOPE field is rejected too')

  // And the whole doc is repair-clean: the defect was that repair() would
  // cascade-delete shape:f AND shape:kid.
  doc.commit()
  assert.deepEqual(doc.repair(), [], 'repair() has nothing to do — the frame and its child are safe')
  assert.deepEqual(doc.listShapes().map((s) => s.id).sort(), ['shape:f', 'shape:kid'])
}

// --- Loose passthrough keys still accept undefined: null is VALID there ---
// This is why we normalize-then-validate rather than banning `undefined`
// outright. `{ stillUrl: undefined }` is the realistic embed-write pattern.
{
  const doc = LoroCanvasDoc.create({ peerId: 21n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:ss', kind: 'screenshare', parentId: 'page:p', props: { w: 10, h: 10 }, ...base() } as never)
  doc.updateProps('shape:ss', { stillUrl: undefined })
  assert.equal(doc.invalidWriteCount, 0, 'a loose passthrough key tolerates null — do not punish the common case')
  assert.ok(validateShape(doc.getShape('shape:ss')).ok, 'and the read-back validates')
}

// --- DRIFT GUARD: the normalizer must match what Loro ACTUALLY stores ---
// This is what makes "validate the post-serialization form" safe to rely on.
// The comparison is asStored(input) vs a REAL write/read-back — not against a
// hand-written expectation, which would only restate our assumption. If Loro's
// coercion ever changes, this fails loudly rather than silently reopening the
// write boundary.
{
  const doc = LoroCanvasDoc.create({ peerId: 22n })
  doc.putPage({ id: 'page:p', name: 'P' })
  // NOTE: not `-0` here. Independently verified (a direct LoroDoc/tree-node
  // probe against loro-crdt/base64, matching this file's import) that Loro
  // normalizes -0 to +0 in tree node data — Object.is(-0, readback) is false.
  // That contradicts this task's "already measured" note claiming -0 "round-
  // trips faithfully"; the note was wrong for this pathway. It's irrelevant to
  // the fix at hand (z.number() accepts -0 and +0 identically, so it cannot
  // reopen the write boundary) and orthogonal to asStored's one documented
  // rule (undefined -> null), so the probe uses +0 instead of chasing an
  // unrelated Loro quirk into asStored's scope.
  const probes: Record<string, unknown> = {
    plainUndefined: undefined,
    nested: { a: undefined, b: 1 },
    inArray: [1, undefined, 3],
    deep: { x: [{ y: undefined }] },
    keptNumber: 0,
    keptString: 'x',
    keptNull: null,
    keptBool: false,
  }
  doc.putShapeUnchecked({ id: 'shape:p', kind: 'frame', parentId: 'page:p', props: probes, ...base() } as never)
  doc.commit()
  const stored = doc.getShape('shape:p')!.props
  assert.deepEqual(
    asStored(probes),
    stored,
    'the normalizer must reproduce EXACTLY what Loro stored — if this fails, Loro changed and the write boundary is no longer validating what repair() will judge',
  )
}

console.log('ok: serialization-seam')
