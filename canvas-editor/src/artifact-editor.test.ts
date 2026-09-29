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
