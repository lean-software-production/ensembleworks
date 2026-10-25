// Run: bun src/canvas-v2/image-create.test.ts
// Task C1 (docs/plans/2026-07-22-canvas-v2-assets-image.md) — a real
// Editor/LoroCanvasDoc (so the resulting doc state is genuine, not faked),
// with `editor.applyAll` wrapped to CAPTURE each batch call (still
// delegating to the real implementation) so "one atomic batch" is an
// assertion on the actual call list, not an inference from doc state alone.
// `uploadImage` is mocked via the injectable `uploadFn` param — no network,
// no real DOM image decode.
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Intent } from '@ensembleworks/canvas-editor'
import { Editor } from '@ensembleworks/canvas-editor'
import type { Asset } from '@ensembleworks/canvas-model'
import { createImageFromBlob } from './image-create.js'
import type { UploadedImage } from './asset-upload.js'

function setup() {
	const doc = LoroCanvasDoc.create({ peerId: 1n })
	doc.putPage({ id: 'page:p', name: 'P' })
	doc.commit()
	const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
	const batches: (readonly Intent[])[] = []
	const realApplyAll = editor.applyAll.bind(editor)
	editor.applyAll = (intents: readonly Intent[]) => {
		batches.push(intents)
		realApplyAll(intents)
	}
	return { doc, editor, batches }
}

function fakeFile(name = 'photo.png', type = 'image/png'): File {
	return new File([new Uint8Array([1, 2, 3])], name, { type })
}

const MOCK_UPLOAD: UploadedImage = { src: '/uploads/abc-photo.png', w: 200, h: 100, mimeType: 'image/png', name: 'photo.png' }

// ============================================================================
// 1. End to end: exactly one image shape, whose assetId names an asset in
//    listAssets() whose src is the mocked upload src. ONE applyAll call
//    containing PutAsset + CreateShape + SetSelection. Selected. Centered.
// ============================================================================
{
	const { doc, editor, batches } = setup()
	const uploadFn = async () => MOCK_UPLOAD

	await createImageFromBlob(editor, fakeFile(), { x: 100, y: 100 }, 'page:p', uploadFn)

	assert.equal(batches.length, 1, 'exactly ONE applyAll call — the atomic batch')
	const batch = batches[0]!
	assert.equal(batch.length, 3, 'the batch has exactly 3 intents')
	assert.equal(batch[0]!.type, 'PutAsset', 'PutAsset is first (asset must exist before the shape references it)')
	assert.equal(batch[1]!.type, 'CreateShape', 'CreateShape is second')
	assert.equal(batch[2]!.type, 'SetSelection', 'SetSelection is third')

	const shapes = doc.listShapes()
	assert.equal(shapes.length, 1, 'exactly one shape landed')
	const imageShape = shapes[0]!
	assert.equal(imageShape.kind, 'image')

	const assets = doc.listAssets()
	assert.equal(assets.length, 1, 'exactly one asset landed')
	const asset = assets[0]!

	// THE CRUX (per brief): the shape's assetId must equal the asset's own id.
	assert.equal((imageShape.props as { assetId: string }).assetId, asset.id, 'shape.props.assetId === asset.id (the linkage the renderer resolves through)')
	assert.equal(asset.props.src, MOCK_UPLOAD.src, "the asset's src is the uploaded src")
	assert.equal((imageShape.props as { w: number }).w, MOCK_UPLOAD.w, 'shape sized to the uploaded width')
	assert.equal((imageShape.props as { h: number }).h, MOCK_UPLOAD.h, 'shape sized to the uploaded height')

	assert.deepEqual([...editor.get().selection], [imageShape.id], 'the new image shape is selected')

	// CENTERED on worldPoint, not top-left.
	assert.equal(imageShape.x, 100 - MOCK_UPLOAD.w / 2, 'x is centered on worldPoint')
	assert.equal(imageShape.y, 100 - MOCK_UPLOAD.h / 2, 'y is centered on worldPoint')

	assert.ok(asset.id.startsWith('asset:'), 'asset id has the asset: prefix')
	assert.ok(imageShape.id.startsWith('shape:'), 'shape id has the shape: prefix')
	// Compare the SUFFIX (post-prefix) entropy, not the full string: the
	// full ids differ trivially by their 'asset:'/'shape:' prefix even if
	// the underlying random draw were reused for both (a mutant that mints
	// one draw and slaps two different prefixes on it would still pass a
	// naive full-string notEqual — this is the row that actually catches
	// "same random draw for both ids").
	const assetSuffix = asset.id.slice('asset:'.length)
	const shapeSuffix = imageShape.id.slice('shape:'.length)
	assert.notEqual(assetSuffix, shapeSuffix, 'asset id and shape id draw INDEPENDENT random suffixes, not the same draw reused under two prefixes')

	console.log('ok: createImageFromBlob emits one atomic [PutAsset, CreateShape, SetSelection] batch, linked, centered, selected')
}

// ============================================================================
// 2. A failing upload (non-image file / network failure) is graceful: no
//    shape, no asset, no throw, no batch emitted at all.
// ============================================================================
{
	const { doc, editor, batches } = setup()
	const uploadFn = async (): Promise<UploadedImage> => {
		throw new Error('not an image')
	}

	await assert.doesNotReject(() => createImageFromBlob(editor, fakeFile('notes.txt', 'text/plain'), { x: 0, y: 0 }, 'page:p', uploadFn), 'a failed upload never throws/rejects out of createImageFromBlob')

	assert.equal(batches.length, 0, 'no applyAll call at all on upload failure')
	assert.equal(doc.listShapes().length, 0, 'no shape created')
	assert.equal(doc.listAssets().length, 0, 'no asset created')

	console.log('ok: createImageFromBlob swallows a failed upload gracefully — no partial write')
}

console.log('ok: image-create')
