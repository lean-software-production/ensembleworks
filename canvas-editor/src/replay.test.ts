// Run: bun src/replay.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc, dumpModel } from '@ensembleworks/canvas-doc'
import { Editor } from './editor.js'
import { run, script } from './script.js'
import { deriveEditorClock, replaySession, SessionRecorder, type Session } from './replay.js'
import { createArrowTool } from './tools/arrow.js'
import { createCreateTool } from './tools/create.js'
import { createSelectTool } from './tools/select.js'
import { createTransformTool } from './tools/transform.js'
import { createToolContext, type ToolContext } from './tools/tool-context.js'

// The SAME tool-name -> factory convention used both when recording and
// when replaying (see replaySession's doc comment: this mapping is the
// caller's own, not something replay.ts hardcodes).
function buildToolsFor(ctx: ToolContext) {
  return {
    select: createSelectTool(ctx),
    'create:geo': createCreateTool(ctx, 'geo'),
    arrow: createArrowTool(ctx),
    transform: createTransformTool(ctx),
  }
}

// The pre-existing room infrastructure (the page) -- run identically on
// both the original recording doc and every replay, as a LOCAL commit (not
// a recorded step; not an imported update) -- see replaySession's
// `bootstrap` doc comment for why this matters at the BYTE level, not just
// the converged-model level.
function bootstrapPage(editor: Editor): void {
  editor.doc.putPage({ id: 'page:p', name: 'P' })
  editor.doc.commit()
}

function replayMixed(session: Session) {
  return replaySession(
    session,
    (editor) => {
      const ctx = createToolContext(editor)
      const raw = buildToolsFor(ctx)
      return { select: raw.select, 'create:geo': raw['create:geo'], arrow: raw.arrow, transform: raw.transform }
    },
    bootstrapPage,
  )
}

const SEED = 424242

// ============================================================================
// Record a mixed session: create (drag-to-size), select, transform (resize),
// arrow (unbound draw), a REMOTE update imported mid-session, then one more
// local select -- interleaved in that exact order.
// ============================================================================
function recordMixedSession(): { session: Session; doc: LoroCanvasDoc; editor: Editor } {
  const { now, random } = deriveEditorClock(SEED)
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  const editor = new Editor({ doc, now, random, pageId: 'page:p' })
  bootstrapPage(editor) // IDENTICAL bootstrap to replayMixed's -- not a recorded step
  const ctx = createToolContext(editor)
  const recorder = new SessionRecorder({ version: 1, peerId: '1', pageId: 'page:p', seed: SEED })
  const rawTools = buildToolsFor(ctx)
  const tools = {
    select: recorder.wrap(rawTools.select, 'select'),
    createGeo: recorder.wrap(rawTools['create:geo'], 'create:geo'),
    arrow: recorder.wrap(rawTools.arrow, 'arrow'),
    transform: recorder.wrap(rawTools.transform, 'transform'),
  }

  // 1. Create a geo shape via drag-to-size: (10,10) -> (110,110).
  run(editor, tools.createGeo, script().down(10, 10).move(110, 110).up().events())
  const created = editor.doc.listShapes().find((s) => s.kind === 'geo')!

  // 2. Switch to select, click the new shape.
  recorder.switchTool('select')
  run(editor, tools.select, script().down(50, 50).up().events())
  assert.deepEqual([...editor.get().selection], [created.id])

  // 3. Switch to transform, resize via its SE corner.
  recorder.switchTool('transform')
  run(editor, tools.transform, script().down(110, 110).move(160, 160).up().events())

  // 4. A REMOTE update arrives mid-session: a second peer's doc, with its
  //    own shape, imported into the recording doc.
  const remoteDoc = LoroCanvasDoc.create({ peerId: 2n })
  remoteDoc.putShape({
    id: 'shape:remote', kind: 'geo', parentId: 'page:p', index: 'a1', x: 500, y: 500, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 30, h: 30 },
  } as any)
  remoteDoc.commit()
  const updateBytes = remoteDoc.exportUpdate()
  doc.import(updateBytes)
  doc.commit()
  recorder.recordRemote(updateBytes)

  // 5. Switch to arrow, draw an unbound arrow elsewhere.
  recorder.switchTool('arrow')
  run(editor, tools.arrow, script().down(300, 300).move(400, 320).up().events())

  // 6. Back to select: click the REMOTE shape (proves local dispatch after
  //    a mid-session remote import still works against the merged doc).
  recorder.switchTool('select')
  run(editor, tools.select, script().down(510, 510).up().events())
  assert.deepEqual([...editor.get().selection], ['shape:remote'])

  return { session: recorder.toSession(), doc, editor }
}

// ============================================================================
// 1. Bit-for-bit replay: dumpModel deep-equal AND exportSnapshot() byte-equal
//    (Buffer.compare) between the original recording and its replay.
// ============================================================================
{
  const { session, doc: originalDoc } = recordMixedSession()
  const originalModel = dumpModel(originalDoc)
  const originalSnapshot = originalDoc.exportSnapshot()

  const { doc: replayDoc } = replayMixed(session)
  const replayModel = dumpModel(replayDoc)
  const replaySnapshot = replayDoc.exportSnapshot()

  assert.deepEqual(replayModel, originalModel, 'replayed dumpModel deep-equals the original recording')
  // PROBE: is Loro's exportSnapshot byte-identical given identical peerId +
  // identical op sequence? LoroCanvasDoc.create/commit never enable
  // timestamp recording (Loro's own default is OFF -- see the installed
  // loro-crdt package's LoroDoc.setRecordTimestamp doc comment: "Default is
  // `false`"), so no wall-clock value should be embedded in either doc's
  // encoded history. Established by this assertion actually passing: no
  // hidden non-determinism survives seed-derived now/random + a shared
  // peerId + an IDENTICAL op sequence (including the bootstrap running as a
  // local commit on both sides, not an import -- see bootstrapPage's
  // comment: an import and a local commit of equivalent CONTENT are not
  // the same physical op sequence, so byte-equality needs the bootstrap
  // itself replayed as a local commit too, not folded into `Session.steps`
  // as a synthetic remote update).
  assert.equal(Buffer.compare(Buffer.from(replaySnapshot), Buffer.from(originalSnapshot)), 0, 'exportSnapshot() is BYTE-identical between the original recording and its replay')
  console.log('ok: replay is bit-for-bit identical to the original recording (dumpModel AND exportSnapshot bytes)')
}

// ============================================================================
// 2. Serialization round-trip: JSON.stringify -> parse -> replay is STILL
//    identical (proves the Session schema is lossless JSON, including the
//    base64-encoded remote update bytes and the nested InputEvent objects).
// ============================================================================
{
  const { session, doc: originalDoc } = recordMixedSession()
  const roundTripped: Session = JSON.parse(JSON.stringify(session))
  assert.deepEqual(roundTripped, session, 'JSON round-trip of the Session object itself is lossless')

  const originalSnapshot = originalDoc.exportSnapshot()
  const { doc: replayDoc } = replayMixed(roundTripped)
  assert.equal(Buffer.compare(Buffer.from(replayDoc.exportSnapshot()), Buffer.from(originalSnapshot)), 0, 'replay from a JSON round-tripped session is still byte-identical')
  console.log('ok: JSON.stringify -> parse -> replay survives the round trip, still byte-identical')
}

// ============================================================================
// 3. A TAMPERED session (one event coordinate changed) produces a DIFFERENT
//    final state -- sanity that the bit-for-bit test above has teeth (it
//    could otherwise pass vacuously if replay ignored the recorded events
//    entirely).
// ============================================================================
{
  const { session, doc: originalDoc } = recordMixedSession()
  const tampered: Session = JSON.parse(JSON.stringify(session))
  const firstInput = tampered.steps.find((s) => s.kind === 'input')! as { event: { x: number } }
  firstInput.event.x += 500 // move the very first recorded pointer event

  const { doc: tamperedDoc } = replayMixed(tampered)

  const originalSnapshot = originalDoc.exportSnapshot()
  const tamperedSnapshot = tamperedDoc.exportSnapshot()
  assert.notEqual(Buffer.compare(Buffer.from(tamperedSnapshot), Buffer.from(originalSnapshot)), 0, 'a tampered event coordinate changes the final replayed state')
  console.log('ok: a tampered session replays to a DIFFERENT final state (the bit-for-bit test has teeth)')
}

console.log('ok: session recording + deterministic replay')
