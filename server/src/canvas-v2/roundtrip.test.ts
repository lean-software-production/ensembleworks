// Converter seam D: CanvasDocument → tldraw records (round-trip).
// Boots createSyncApp, seeds one room with the full shape zoo via updateStore
// (the canvas-api.test.ts pattern), then asserts fromTldraw→toTldraw is
// lossless for shape envelopes + props + bindings.
// Run with: bun src/canvas-v2/roundtrip.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBindingId, createShapeId, toRichText } from '@tldraw/tlschema'
import { createSyncApp } from '../app.ts'
import { fromTldraw, toTldraw } from './convert.ts'

const base = (over: any) => ({
	typeName: 'shape',
	x: 0,
	y: 0,
	rotation: 0,
	isLocked: false,
	opacity: 1,
	meta: {},
	parentId: 'page:page',
	index: 'a1',
	...over,
})

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rt-'))
	const { getOrCreateRoom } = createSyncApp({ dataDir })
	const room = getOrCreateRoom('rt')

	const noteId = createShapeId()
	const frameId = createShapeId()
	const termId = createShapeId()
	const geoId = createShapeId()
	const arrowId = createShapeId()
	await room.updateStore((store) => {
		store.put(base({ id: frameId, type: 'frame', index: 'a1', props: { w: 400, h: 300, name: 'Planning', color: 'black' } }) as any)
		store.put(
			base({
				id: noteId,
				type: 'note',
				parentId: frameId,
				index: 'a1',
				props: {
					richText: toRichText('hi'),
					color: 'yellow',
					labelColor: 'black',
					size: 'm',
					font: 'draw',
					fontSizeAdjustment: 1,
					align: 'middle',
					verticalAlign: 'middle',
					growY: 0,
					url: '',
					scale: 1,
					textFirstEditedBy: null,
				},
			}) as any
		)
		store.put(
			base({
				id: geoId,
				type: 'geo',
				index: 'a2',
				props: {
					geo: 'rectangle',
					dash: 'draw',
					url: '',
					w: 220,
					h: 120,
					growY: 0,
					scale: 1,
					labelColor: 'black',
					color: 'black',
					fill: 'semi',
					size: 's',
					font: 'draw',
					align: 'middle',
					verticalAlign: 'middle',
					richText: toRichText('A'),
				},
			}) as any
		)
		// Non-empty shape meta: must survive the round trip verbatim.
		store.put(
			base({ id: termId, type: 'terminal', index: 'a3', meta: { assignee: 'x' }, props: { w: 640, h: 480, sessionId: 'abc', title: 't' } }) as any
		)
		store.put(
			base({
				id: arrowId,
				type: 'arrow',
				index: 'a4',
				props: {
					kind: 'arc',
					labelColor: 'black',
					color: 'black',
					fill: 'none',
					dash: 'draw',
					size: 's',
					arrowheadStart: 'none',
					arrowheadEnd: 'arrow',
					font: 'draw',
					start: { x: 0, y: 0 },
					end: { x: 10, y: 10 },
					bend: 0,
					richText: toRichText(''),
					labelPosition: 0.5,
					scale: 1,
					elbowMidPoint: 0.5,
				},
			}) as any
		)
		// One binding carries non-empty meta: must survive the round trip verbatim.
		for (const [terminal, target, meta] of [
			['start', geoId, { assignee: 'x' }],
			['end', frameId, {}],
		] as const)
			store.put({
				id: createBindingId(),
				typeName: 'binding',
				type: 'arrow',
				fromId: arrowId,
				toId: target,
				meta,
				props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
			} as any)
	})

	const records = room.getCurrentSnapshot().documents.map((d) => d.state as any)
	const model = fromTldraw(records)
	const back = toTldraw(model)
	const backById = new Map(back.map((r) => [r.id, r]))

	// Every model shape re-emits with identical envelope + props + meta.
	for (const s of model.shapes) {
		const r = backById.get(s.id)
		assert.ok(r, `shape ${s.id} re-emitted`)
		assert.equal(r.type, s.kind)
		assert.equal(r.parentId, s.parentId)
		assert.equal(r.index, s.index)
		assert.equal(r.x, s.x)
		assert.equal(r.y, s.y)
		assert.equal(r.rotation, s.rotation)
		assert.equal(r.isLocked, s.isLocked)
		assert.equal(r.opacity, s.opacity)
		assert.deepEqual(r.meta, s.meta) // lossless meta
		assert.deepEqual(r.props, s.props) // lossless props incl. richText
	}
	// Non-empty shape meta made it all the way around.
	assert.deepEqual(backById.get(termId)!.meta, { assignee: 'x' })
	// Bindings survive, meta included.
	const backBindings = back.filter((r) => r.typeName === 'binding')
	assert.equal(backBindings.length, 2)
	for (const b of model.bindings) {
		const r = backById.get(b.id)
		assert.ok(r, `binding ${b.id} re-emitted`)
		assert.deepEqual(r.props, b.props)
		assert.deepEqual(r.meta, b.meta)
	}
	// The non-empty binding meta made it all the way around.
	assert.deepEqual(
		backBindings.find((r) => r.toId === geoId)!.meta,
		{ assignee: 'x' }
	)
	// Custom + default kinds all present.
	const kinds = new Set(model.shapes.map((s) => s.kind))
	for (const k of ['frame', 'note', 'geo', 'terminal', 'arrow']) assert.ok(kinds.has(k as any), `has ${k}`)

	room.close()
	console.log('ok: roundtrip')
	process.exit(0)
}
main().catch((e) => {
	console.error(e)
	process.exit(1)
})
