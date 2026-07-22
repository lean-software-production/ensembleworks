// Run: bun src/write-validation.test.ts
// The write boundary (Task 1-4): LoroCanvasDoc rejects locally-originated
// writes that would put a shape into a state repair() would later judge
// invalid, reporting each rejection through a counter and an injectable hook
// instead of throwing (see docs/plans/2026-07-19-v2-write-path-validation.md,
// decision D1).
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import type { InvalidWrite } from './canvas-doc.js'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} });

// --- Task 1/1A: the reporting surface exists, is named unambiguously, starts empty ---
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 1n, onInvalidWrite: (w) => seen.push(w) })
  assert.equal(doc.invalidWriteCount, 0, 'a fresh doc has rejected nothing')
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:ok', kind: 'note', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(doc.invalidWriteCount, 0, 'a valid write is not counted as a rejection')
  assert.deepEqual(seen, [], 'a valid write does not fire the hook')
}

// --- Task 1A finding 4: the OLD getter name is gone, not merely aliased ---
{
  const doc = LoroCanvasDoc.create({ peerId: 11n })
  assert.equal(
    (doc as unknown as Record<string, unknown>).invalidWrites,
    undefined,
    'the old `invalidWrites` name is removed — it collided with the InvalidWrite type',
  )
}

// --- Task 1B finding 3: the backing field follows the repairCounter pattern ---
// Field <noun>Counter / getter <noun>Count, matching client-peer.ts's
// repairCounter/repairCount. Pinned so the pair cannot drift apart again.
{
  const doc = LoroCanvasDoc.create({ peerId: 15n })
  assert.equal(doc.invalidWriteCount, 0, 'the getter is invalidWriteCount')
  assert.equal(
    (doc as unknown as Record<string, unknown>).writeRejections,
    undefined,
    'the interim `writeRejections` field name is gone',
  )
}

// --- Task 1A finding 3: InvalidWrite carries `kind` ---
// Two cases, because they fail on DIFFERENT zod paths. The props case embeds
// the kind in the message anyway; the ENVELOPE case does not, and that is the
// case `kind` exists for.
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 12n, onInvalidWrite: (w) => seen.push(w) })
  doc.putPage({ id: 'page:p', name: 'P' })

  // Props-refinement failure: kind IS in the message, and must also be a field.
  doc.putShape({ id: 'shape:a', kind: 'frame', parentId: 'page:p', props: { w: '1' }, ...base() } as never)
  assert.equal(seen[0]!.kind, 'frame', 'kind is reported on a props failure')

  // Envelope failure (index must be a non-empty string): the zod message never
  // names the kind, so the field is the ONLY way to know what was being built.
  doc.putShape({ id: 'shape:b', kind: 'note', parentId: 'page:p', props: {}, ...base(), index: '' } as never)
  assert.equal(seen[1]!.kind, 'note', 'kind is reported on an envelope failure too')
  assert.doesNotMatch(seen[1]!.error, /note/, 'precondition: the envelope error genuinely does not name the kind')
}

// --- Task 1A finding 2 (as revised by Task 1B): the default console.warn logs
// on POWERS OF TWO, and the counter is unaffected ---
{
  const warned: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(String(args[0])) }
  try {
    const doc = LoroCanvasDoc.create({ peerId: 13n }) // no handler -> console path
    doc.putPage({ id: 'page:p', name: 'P' })
    // v2 commits at per-pointermove granularity, so a bad drag emits ~60/s
    // indefinitely. 20 stands in for "a drag that lasted a third of a second".
    for (let i = 0; i < 20; i++) {
      doc.putShape({ id: `shape:bad${i}`, kind: 'frame', parentId: 'page:p', props: { w: 'x' }, ...base() } as never)
    }
    assert.equal(doc.invalidWriteCount, 20, 'the counter stays EXACT regardless of how little is logged')
  } finally {
    console.warn = realWarn
  }
  // Assert WHICH rejections logged, not merely how many. A lifetime cap of 5
  // and powers-of-two BOTH yield 5 lines at n=20 (1,2,4,8,16), so a
  // count-only assertion cannot tell them apart.
  const ordinals = warned.map((line) => Number(/\[#(\d+)\]/.exec(line)?.[1]))
  assert.deepEqual(ordinals, [1, 2, 4, 8, 16], 'logs on powers of two only — never 3, 5, 6, 7')
  assert.ok(!ordinals.includes(3) && !ordinals.includes(7), 'explicitly: non-powers-of-two are silent')
  assert.match(warned[0]!, /\[#1\]/, 'each line carries its ordinal')
}

// --- Task 1B finding 1/2: `kind` is COERCED centrally, never passed through ---
// The doc comment promises '<unknown>' for a value too malformed to have a
// kind. The call sites below hand rejectWrite an already-invalid value, so
// without central coercion `kind` would carry whatever garbage was in there —
// including a number or an object, which violates the DECLARED TYPE at runtime
// and would reach the dev overlay through JSON.stringify.
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 14n, onInvalidWrite: (w) => seen.push(w) })
  doc.putPage({ id: 'page:p', name: 'P' })

  // A kind that is a plausible-looking string but not a real ShapeKind.
  doc.putShape({ id: 'shape:a', kind: 'wibble', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[0]!.kind, '<unknown>', 'an unrecognised kind string is coerced, not echoed')

  // A kind of the wrong TYPE entirely — the runtime-type-violation case.
  doc.putShape({ id: 'shape:b', kind: 42, parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[1]!.kind, '<unknown>', 'a non-string kind never escapes as a non-string')

  doc.putShape({ id: 'shape:c', kind: { nested: true }, parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[2]!.kind, '<unknown>', 'an object kind never reaches a JSON.stringify consumer')

  // Missing entirely.
  doc.putShape({ id: 'shape:d', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[3]!.kind, '<unknown>', 'an absent kind is reported as unknown')

  // And a REAL kind still passes through untouched.
  doc.putShape({ id: 'shape:e', kind: 'note', parentId: 'page:p', props: {}, ...base(), index: '' } as never)
  assert.equal(seen[4]!.kind, 'note', 'a genuine ShapeKind is preserved')

  for (const w of seen) {
    assert.equal(typeof w.kind, 'string', 'kind is ALWAYS a string, whatever was thrown at it')
  }
}

// --- Task 2: putShape rejects an invalid shape, writes nothing, does not throw ---
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 2n, onInvalidWrite: (w) => seen.push(w) })
  doc.putPage({ id: 'page:p', name: 'P' })
  // A neighbour that must survive untouched — see the no-op assertion below.
  doc.putShape({ id: 'shape:keep', kind: 'note', parentId: 'page:p', props: {}, ...base() } as never)

  // props.w must be a number for a frame (canvas-model shape.ts `box`).
  assert.doesNotThrow(() =>
    doc.putShape({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never),
  )

  // HOLE 1 (the biggest): Task 1 never CALLS onInvalidWrite. A doc that stores
  // the handler and never invokes it passes Task 1 completely. Prove it fires.
  assert.equal(seen.length, 1, 'the hook actually fired — storing the handler is not enough')
  assert.equal(seen[0]!.op, 'putShape')
  assert.equal(seen[0]!.kind, 'frame')
  assert.equal(seen[0]!.id, 'shape:bad')

  // HOLE 5: the InvalidWrite doc comment promises the VERBATIM zod message.
  assert.match(seen[0]!.error, /expected number, received string/, 'the verbatim zod message is carried through')

  // HOLE 3 (the actual defect): the write is a TRUE no-op. The counter is only
  // a proxy for this — what matters is that nothing landed and nothing else moved.
  assert.equal(doc.getShape('shape:bad'), undefined, 'the invalid shape was not written at all')
  assert.deepEqual(doc.listShapes().map((s) => s.id), ['shape:keep'], 'no partial node, and the neighbour is untouched')

  // HOLE 2: prove invalidWriteCount is a COUNTER, not a constant. Task 1 only
  // ever observed it at 0, which a hardcoded `return 0` would satisfy.
  assert.equal(doc.invalidWriteCount, 1, 'the first rejection was counted')
  doc.putShape({ id: 'shape:bad2', kind: 'frame', parentId: 'page:p', props: { h: 'nope' }, ...base() } as never)
  assert.equal(doc.invalidWriteCount, 2, 'the counter increments per rejection')
  assert.equal(seen.length, 2, 'and the hook fires per rejection')

  // The escape hatch still writes, unvalidated — this is how tests and rigs
  // reproduce what a remote peer's bytes can deliver.
  doc.putShapeUnchecked({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
  assert.ok(doc.getShape('shape:bad'), 'putShapeUnchecked bypasses validation')
  assert.equal(doc.invalidWriteCount, 2, 'the escape hatch does not touch the counter')
}

// HOLE 4: with NO handler injected, the doc must fall back to console.warn.
// The InvalidWriteHandler doc comment claims a rejection is "never silent" and
// nothing has proven it. Capture console.warn rather than trusting the claim.
// (The powers-of-two throttle is proven in the restored section above; this
// proves the fallback fires AT ALL, and that the line names op, kind, id and
// ordinal. n=1 is a power of two, so exactly one line is expected here.)
{
  const warned: unknown[][] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args) }
  try {
    const doc = LoroCanvasDoc.create({ peerId: 5n }) // no onInvalidWrite
    doc.putPage({ id: 'page:p', name: 'P' })
    doc.putShape({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
    assert.equal(doc.invalidWriteCount, 1, 'still counted without a handler')
  } finally {
    console.warn = realWarn // restore even if an assertion throws
  }
  assert.equal(warned.length, 1, 'the console.warn fallback fired — a rejection is never silent')
  assert.match(String(warned[0]![0]), /rejected invalid putShape \(frame\) shape:bad \[#1\]/, 'the warning names the op, the kind, the id and the ordinal')
}

// --- Task 3A finding 1: a THROWING sink must not escape putShape ---
// The reporting path exists BECAUSE we refuse to throw (decision D1). If the
// sink itself can throw, the hole is back: Editor.applyAll has no try/catch
// around its intent loop and commits only afterward, so an escaping throw
// strands that batch's earlier mutations uncommitted.
{
  const doc = LoroCanvasDoc.create({
    peerId: 16n,
    onInvalidWrite: () => { throw new Error('handler blew up') },
  })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:keep', kind: 'note', parentId: 'page:p', props: {}, ...base() } as never)

  assert.doesNotThrow(
    () => doc.putShape({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '1' }, ...base() } as never),
    'a throwing sink must not escape putShape',
  )
  // Still a total no-op, and still counted.
  assert.equal(doc.getShape('shape:bad'), undefined, 'the rejected write did not land')
  assert.deepEqual(doc.listShapes().map((s) => s.id), ['shape:keep'], 'nothing else moved')
  assert.equal(doc.invalidWriteCount, 1, 'the counter increments BEFORE the sink is called, so a throw cannot skew it')

  // And the throw must not fall through to the console path either.
  const realWarn = console.warn
  let warnings = 0
  console.warn = () => { warnings++ }
  try {
    doc.putShape({ id: 'shape:bad2', kind: 'frame', parentId: 'page:p', props: { w: '1' }, ...base() } as never)
  } finally {
    console.warn = realWarn
  }
  assert.equal(warnings, 0, 'a supplied-but-throwing sink still suppresses the console fallback')
}

// --- Task 3A finding 4: `id` is coerced centrally, including empty string ---
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 17n, onInvalidWrite: (w) => seen.push(w) })
  doc.putPage({ id: 'page:p', name: 'P' })

  doc.putShape({ kind: 'frame', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[0]!.id, '<no id>', 'a missing id is reported as <no id>')

  // The case the old guard missed: '' is a string, so it passed through and
  // rendered as a BLANK in the log line — reads as a formatting bug, not as
  // missing data.
  doc.putShape({ id: '', kind: 'frame', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[1]!.id, '<no id>', 'an EMPTY-STRING id is coerced too, not passed through blank')

  doc.putShape({ id: 42, kind: 'frame', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[2]!.id, '<no id>', 'a non-string id never escapes as a non-string')

  doc.putShape({ id: 'shape:real', kind: 'frame', parentId: 'page:p', props: { w: '1' }, ...base() } as never)
  assert.equal(seen[3]!.id, 'shape:real', 'a genuine id is preserved')
}

// --- Task 4: updateProps validates the MERGED shape, not the patch ---
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 3n, onInvalidWrite: (w) => seen.push(w) })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:f', kind: 'frame', parentId: 'page:p', props: { w: 100, h: 100 }, ...base() } as never)

  // The exact reported defect: a string where a number belongs.
  assert.doesNotThrow(() => doc.updateProps('shape:f', { w: '100' }))
  assert.deepEqual(doc.getShape('shape:f')!.props, { w: 100, h: 100 }, 'props are untouched — no partial merge landed')
  assert.equal(doc.invalidWriteCount, 1, 'the rejection was counted')
  assert.equal(seen[0]!.op, 'updateProps')
  assert.equal(seen[0]!.id, 'shape:f')
  // `kind` comes from the EXISTING node here, not from the patch — the patch
  // has no kind to read.
  assert.equal(seen[0]!.kind, 'frame', 'kind is read off the existing shape')

  // A VALID patch still merges (regression guard on the happy path).
  doc.updateProps('shape:f', { w: 250 })
  assert.deepEqual(doc.getShape('shape:f')!.props, { w: 250, h: 100 }, 'a valid patch merges as before')
  assert.equal(doc.invalidWriteCount, 1, 'a valid patch is not counted')

  // Merged-not-patch, the direction that MATTERS: a patch that HEALS an
  // already-invalid shape (one a remote peer delivered) must be accepted,
  // even though the pre-image is invalid.
  doc.putShapeUnchecked({ id: 'shape:g', kind: 'frame', parentId: 'page:p', props: { w: 'bad', h: 10 }, ...base() } as never)
  doc.updateProps('shape:g', { w: 42 })
  assert.deepEqual(doc.getShape('shape:g')!.props, { w: 42, h: 10 }, 'a patch that makes the merged shape valid is accepted')
  assert.equal(doc.invalidWriteCount, 1, 'healing a remote-delivered invalid shape is not a rejection')

  // Unknown id keeps its pre-existing silent-no-op contract — NOT a rejection.
  doc.updateProps('shape:nope', { w: 1 })
  assert.equal(doc.invalidWriteCount, 1, 'an unknown id is a no-op, not an invalid write')

  // An EMPTY patch is a no-op by definition — even against an already-invalid
  // shape, where a non-empty patch could legitimately be rejected. `{}` writes
  // nothing, so it must never increment the counter.
  doc.updateProps('shape:g', {})
  assert.equal(doc.invalidWriteCount, 1, 'an empty patch is a no-op, not a rejection, even on a still-invalid shape')
}

// --- Task 4N (step 6b): empty patch against a shape whose ENVELOPE is
// invalid (not just props) — confirms the empty-patch short-circuit happens
// before validation even runs, for any kind of pre-existing invalidity ---
{
  const doc = LoroCanvasDoc.create({ peerId: 18n })
  doc.putPage({ id: 'page:p', name: 'P' })
  // opacity: 'opaque' is an ENVELOPE violation, reachable only via the
  // unchecked escape hatch (validateShape checks the whole envelope, not
  // just props) — putShape would refuse this outright.
  doc.putShapeUnchecked({ id: 'shape:bad', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'opaque' } as never)
  doc.updateProps('shape:bad', {})
  assert.equal(doc.invalidWriteCount, 0, 'an empty patch on an envelope-invalid shape is still a no-op, not a rejection')
}

// --- REGRESSION: the reported defect, end to end ---
// updateProps(frameId, { w: '100' }) used to silently delete the frame AND
// every shape inside it, on every peer, durably (Loro tombstones make it
// unrecoverable). Two independent guards now stand in the way: the write is
// rejected at the boundary (Tasks 2/4), and even if it arrives from a remote
// peer that skipped that boundary, repair() removes only the frame (Task 6).
{
  const doc = LoroCanvasDoc.create({ peerId: 9n, onInvalidWrite: () => {} })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:f', kind: 'frame', parentId: 'page:p', props: { w: 100, h: 100 }, ...base() } as never)
  doc.putShape({ id: 'shape:c1', kind: 'note', parentId: 'shape:f', props: {}, ...base() } as never)
  doc.putShape({ id: 'shape:c2', kind: 'note', parentId: 'shape:c1', props: {}, ...base() } as never)
  doc.setText('shape:c1', 'precious content')
  doc.commit()

  // GUARD 1 — origination.
  doc.updateProps('shape:f', { w: '100' })
  doc.commit()
  assert.deepEqual(doc.repair(), [], 'the bad write never landed, so repair has nothing to do')
  assert.deepEqual(doc.listShapes().map((s) => s.id).sort(), ['shape:c1', 'shape:c2', 'shape:f'])
  assert.equal(doc.getText('shape:c1'), 'precious content')

  // GUARD 2 — proportionality, given the write DID land (a remote peer's bytes).
  const stillValid = doc.getShape('shape:f')!
  doc.putShapeUnchecked({ ...stillValid, props: { w: '100', h: 100 } } as never)
  doc.commit()
  const plan = doc.repair()
  doc.commit()
  assert.deepEqual(plan, [{ op: 'dropShape', id: 'shape:f' }])
  assert.deepEqual(doc.listShapes().map((s) => s.id).sort(), ['shape:c1', 'shape:c2'], 'the contents survive the frame')
  assert.equal(doc.getText('shape:c1'), 'precious content', 'and keep their text')
}

console.log('ok: write-validation')
