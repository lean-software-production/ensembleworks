// Run: bun src/canvas-v2/image-paste.test.ts
//
// Task W2's testable slice: `extractImageBlobs(clipboardData)`, the pure,
// DOM-free filter (D-7) — mirrors image-drop.test.ts's coverage of
// `extractImageFiles`. The actual paste-listener wiring (preventDefault,
// viewport-center world point, createImageFromBlob, and NOT stealing the
// existing text-paste path) is DOM (CanvasV2App.tsx); this file only pins
// the filter plus the "no image -> empty, never steals text paste" case.
import assert from 'node:assert/strict'
import { extractImageBlobs, type ClipboardDataLike, type ClipboardItemLike } from './image-paste.js'

function fakeFile(name: string, type: string): File {
	return new File([new Uint8Array([1, 2, 3])], name, { type })
}

function fileItem(file: File): ClipboardItemLike {
	return { kind: 'file', type: file.type, getAsFile: () => file }
}

function stringItem(type = 'text/plain'): ClipboardItemLike {
	return { kind: 'string', type, getAsFile: () => null }
}

// ============================================================================
// 1. A clipboard with an image file item AND a text item: keeps only the
//    image blob.
// ============================================================================
{
	const png = fakeFile('shot.png', 'image/png')
	const clipboardData: ClipboardDataLike = { items: [fileItem(png), stringItem()] }

	const result = extractImageBlobs(clipboardData)

	assert.equal(result.length, 1, 'exactly the one image item survives the filter')
	assert.equal(result[0], png, 'the extracted blob is the image file itself (getAsFile() result)')
	console.log('ok: extractImageBlobs extracts the image file item, ignoring the text item')
}

// ============================================================================
// 2. A clipboard with ONLY a string item (the ordinary EW shape-copy /
//    plain-text-copy case) -> [], so the caller must NOT preventDefault /
//    must not steal the existing text-paste path.
// ============================================================================
{
	const clipboardData: ClipboardDataLike = { items: [stringItem()] }
	const result = extractImageBlobs(clipboardData)
	assert.deepEqual(result, [], 'a text-only clipboard extracts no image blobs')
	console.log('ok: extractImageBlobs([string item]) is [] — text paste is left alone')
}

// ============================================================================
// 3. A non-image FILE item (e.g. a copied .pdf) is excluded — only
//    `kind:'file' && type.startsWith('image/')` counts.
// ============================================================================
{
	const pdf = fakeFile('doc.pdf', 'application/pdf')
	const clipboardData: ClipboardDataLike = { items: [fileItem(pdf)] }
	const result = extractImageBlobs(clipboardData)
	assert.deepEqual(result, [], 'a non-image file item is excluded')
	console.log('ok: extractImageBlobs excludes a non-image file item')
}

// ============================================================================
// 4. Multiple image items (a multi-image paste): all survive, in order.
// ============================================================================
{
	const a = fakeFile('a.png', 'image/png')
	const b = fakeFile('b.jpeg', 'image/jpeg')
	const clipboardData: ClipboardDataLike = { items: [fileItem(a), stringItem(), fileItem(b)] }
	const result = extractImageBlobs(clipboardData)
	assert.deepEqual(result, [a, b], 'both image items survive, in original order, string item dropped')
	console.log('ok: extractImageBlobs keeps every image item from a multi-item clipboard')
}

// ============================================================================
// 5. THE KIND-GUARD DISCRIMINATOR: an item claiming `kind:'string'` whose
//    `type` looks like an image AND whose `getAsFile()` (adversarially,
//    unlike a real browser's DataTransferItem) DOES return a File. A real
//    string-kind item's `getAsFile()` always returns null, so a naive test
//    relying only on that null return can't tell "checks kind" apart from
//    "doesn't check kind, just tries getAsFile()" — this fake isolates the
//    `kind` check itself as the thing under test.
// ============================================================================
{
	const suspicious: ClipboardItemLike = { kind: 'string', type: 'image/png', getAsFile: () => fakeFile('sneaky.png', 'image/png') }
	const clipboardData: ClipboardDataLike = { items: [suspicious] }
	const result = extractImageBlobs(clipboardData)
	assert.deepEqual(result, [], "an item whose kind isn't 'file' is excluded even if getAsFile() would return something")
	console.log('ok: extractImageBlobs enforces the kind==="file" guard, not just an image-typed getAsFile() result')
}

console.log('ok: image-paste')
