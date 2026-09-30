import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { cloneWithNewIds, decodeClipboard, encodeClipboard, type Shape } from '@ensembleworks/canvas-model'
import { Editor } from './editor.js'

const artifact: Shape = {
  id: 'shape:artifact', kind: 'artifact', parentId: 'page:p', index: 'a1',
  x: 120, y: 80, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { schemaVersion: 1, source: 'thread-storage', threadId: 'thr_fixture', path: 'reports/fixture.html', title: '', w: 720, h: 540 },
}
function fixture(extra: Shape[] = [], over: Partial<Shape> = {}) {
  const raw = LoroCanvasDoc.create({ peerId: 1n })
  raw.putPage({ id: 'page:p', name: 'P' })
  for (const s of extra) raw.putShape(s)
  raw.putShapeUnchecked({ ...artifact, ...over })
  raw.commit()
  const doc = LoroCanvasDoc.fromSnapshot(raw.exportSnapshot(), { peerId: 2n })
  const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
  return { doc, editor }
}
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`)

for (const scale of [0, -1, 0.01]) {
  const { doc, editor } = fixture()
  editor.apply({ type: 'ResizeShapes', ids: [artifact.id], anchor: { x: 840, y: 620 }, scaleX: scale, scaleY: scale })
  const s = doc.getShape(artifact.id)!
  assert.equal(s.props.w, 320)
  assert.equal(s.props.h, 200)
  near(s.x, 520)
  near(s.y, 420)
  editor.undo()
  assert.deepEqual(doc.getShape(artifact.id), artifact, 'undo restores imported artifact history')
  editor.redo()
  assert.equal(doc.getShape(artifact.id)!.props.w, 320)
  assert.equal(doc.getShape(artifact.id)!.props.h, 200)
}
console.log('ok: zero/negative/tiny resize floors at 320x200, same clamped factors preserve opposite anchor, undo/redo')

{
  const geo: Shape = { ...artifact, id: 'shape:geo', kind: 'geo', x: 1000, y: 900, props: { w: 100, h: 100 } }
  const { doc, editor } = fixture([geo])
  editor.apply({ type: 'ResizeShapes', ids: [artifact.id, geo.id], anchor: { x: 0, y: 0 }, scaleX: 0.001, scaleY: 0.5 })
  const a = doc.getShape(artifact.id)!, g = doc.getShape(geo.id)!
  assert.deepEqual([a.props.w, a.props.h], [320, 270], 'axis floors are independent')
  assert.deepEqual([g.props.w, g.props.h], [1, 50], 'other kinds retain 1x1 floor')
  near(a.x, 120 * 320 / 720)
  near(a.y, 40)
  near(g.x, 10)
  near(g.y, 450)
}
console.log('ok: mixed selection clamps per kind and per axis')

{
  const { doc, editor } = fixture([], { props: { ...artifact.props, w: 100, h: 100 } })
  assert.equal(doc.getShape(artifact.id)!.props.w, 100, 'reader retains positive imported sub-minimum dimensions')
  editor.apply({ type: 'ResizeShapes', ids: [artifact.id], anchor: { x: 120, y: 80 }, scaleX: 1, scaleY: 1 })
  assert.deepEqual([doc.getShape(artifact.id)!.props.w, doc.getShape(artifact.id)!.props.h], [320, 200])
}
console.log('ok: minimum is an interaction policy, not destructive reader validation')

{
  const { doc, editor } = fixture()
  const version = doc.versionBytes()
  editor.apply({ type: 'BeginEdit', id: artifact.id, region: 'body' })
  assert.equal(editor.get().editingId, artifact.id)
  assert.equal(editor.get().editingRegion, 'body')
  assert.deepEqual(doc.versionBytes(), version, 'private focus never writes shared document history')
  editor.apply({ type: 'EndEdit' })
  assert.deepEqual(doc.versionBytes(), version)
  const newArtifact: Shape = { ...artifact, id: 'shape:new-artifact' }
  editor.apply({ type: 'CreateShape', shape: newArtifact })
  assert.equal(doc.getShape(newArtifact.id), undefined, 'editor creation still unavailable')
  doc.putShape(newArtifact)
  assert.equal(doc.getShape(newArtifact.id), undefined, 'doc creation still unavailable')
  assert.deepEqual(cloneWithNewIds({ shapes: [artifact], bindings: [] }, () => 'shape:clone', () => 'binding:clone', 'page:p', { x: 0, y: 0 }).shapes, [], 'duplicate still refuses artifacts')
  assert.deepEqual(decodeClipboard(encodeClipboard({ 'ensembleworks/clipboard': 1, shapes: [artifact], bindings: [] })).shapes, [], 'clipboard still refuses artifact authoring')
}
console.log('ok: focus stays local; CreateShape/doc/clipboard artifact creation guards remain intact')

// Rework: absolute geometry is independent of the previous floor-clamped
// frame, while each write keeps live non-geometry props and actual preimages
// for undo (it is not a CreateShape/whole-snapshot restore path).
{
  const geo: Shape = { ...artifact, id: 'shape:geo', kind: 'geo', props: { w: 100, h: 100 } }
  const { doc, editor } = fixture([geo])
  const basis = [doc.getShape(artifact.id)!, doc.getShape(geo.id)!]
  const resize = (scale: number, uniform = false) => editor.apply({ type: 'ResizeShapes', ids: basis.map(s => s.id), anchor: { x: 120, y: 80 }, scaleX: scale, scaleY: scale, basis, uniform })
  resize(0.1, true)
  assert.deepEqual([doc.getShape(artifact.id)!.props.w, doc.getShape(artifact.id)!.props.h], [320, 240])
  near(doc.getShape(geo.id)!.props.w as number, 100 * 320 / 720)
  near(doc.getShape(geo.id)!.props.h as number, 100 * 320 / 720) // common group ratio, not a geo minimum
  editor.apply({ type: 'UpdateProps', id: artifact.id, props: { title: 'new live title' } })
  resize(0.5, true)
  assert.deepEqual([doc.getShape(artifact.id)!.props.w, doc.getShape(artifact.id)!.props.h], [360, 270])
  assert.equal(doc.getShape(artifact.id)!.props.title, 'new live title')
  assert.deepEqual([doc.getShape(geo.id)!.props.w, doc.getShape(geo.id)!.props.h], [50, 50])
  const version = doc.versionBytes()
  resize(0.5, true)
  assert.deepEqual(doc.versionBytes(), version, 'same absolute geometry adds no commit/history')
  editor.undo()
  assert.deepEqual([doc.getShape(artifact.id)!.props.w, doc.getShape(artifact.id)!.props.h], [320, 240], 'undo uses the preceding live frame, not gesture start')
  assert.equal(doc.getShape(artifact.id)!.props.title, 'new live title')
  editor.redo()
  assert.equal(doc.getShape(artifact.id)!.props.w, 360)
}
console.log('ok: gesture basis reverses floors, preserves live props, mixed-kind floors and undo/redo')

for (const mutation of ['delete', 'reparent', 'retype'] as const) {
  const { doc, editor } = fixture()
  const basis = [doc.getShape(artifact.id)!]
  if (mutation === 'delete') editor.apply({ type: 'DeleteShapes', ids: [artifact.id] })
  if (mutation === 'reparent') {
    doc.putPage({ id: 'page:other', name: 'Other' })
    doc.commit()
    editor.apply({ type: 'ReparentShapes', ids: [artifact.id], parentId: 'page:other' })
  }
  if (mutation === 'retype') doc.putShape({ ...artifact, kind: 'geo', props: { w: 720, h: 540 } })
  doc.commit()
  const before = doc.getShape(artifact.id)
  editor.apply({ type: 'ResizeShapes', ids: [artifact.id, 'shape:never-existed'], anchor: { x: 0, y: 0 }, scaleX: 0.1, scaleY: 0.1, basis, uniform: true })
  assert.deepEqual(doc.getShape(artifact.id), before, `${mutation} cannot be undone by an old gesture basis`)
  assert.equal(doc.getShape('shape:never-existed'), undefined)
}
console.log('ok: stale gesture basis skips deleted/reparented/retyped/missing ids; never originates artifacts')

{
  const parent: Shape = { ...artifact, id: 'shape:parent', kind: 'frame', x: 100, y: 100, rotation: Math.PI / 3, props: { w: 1000, h: 800 } }
  const { doc, editor } = fixture([parent], { parentId: parent.id, x: 10, y: 20 })
  const basis = [doc.getShape(artifact.id)!]
  for (const scale of [0.1, 0, -0.2, 0.5]) {
    editor.apply({ type: 'ResizeShapes', ids: [artifact.id], anchor: { x: 100, y: 100 }, scaleX: scale, scaleY: scale, basis, uniform: true })
  }
  const s = doc.getShape(artifact.id)!
  assert.deepEqual([s.props.w, s.props.h], [360, 270])
  near(s.x, 5)
  near(s.y, 10)
  assert.equal(s.parentId, parent.id)
}
console.log('ok: absolute resize retains parent-frame conversion under a rotated ancestor')

for (const kind of ['bbthread', 'geo', 'text', 'image'] as const) {
  const other: Shape = { ...artifact, id: 'shape:other', kind, props: { w: 720, h: 540 } }
  const { doc, editor } = fixture([other])
  const basis = [doc.getShape(other.id)!]
  for (const uniform of [false, true]) {
    for (const scale of [0.001, 0.5, 0, -0.1, 0.0001, 0.5]) {
      editor.apply({ type: 'ResizeShapes', ids: [other.id], anchor: { x: 120, y: 80 }, scaleX: scale, scaleY: scale, basis, uniform })
      const s = doc.getShape(other.id)!
      near(s.props.w as number, uniform ? 720 * Math.max(scale, 1 / 540) : Math.max(1, 720 * scale))
      near(s.props.h as number, Math.max(1, 540 * scale))
      near(s.x, 120)
      near(s.y, 80)
    }
  }
}
console.log('ok: bbthread/geo/text/image retain 1-unit floors, Shift ratios and absolute reversal at their own floor')
