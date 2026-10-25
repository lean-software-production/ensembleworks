// Run: bun src/canvas-v2/image-drop.test.ts
//
// Task W1's testable slice: `extractImageFiles(files)`, the pure, DOM-free
// filter (D-7) — mirrors clipboard-dom.test.ts's DOM-free coverage of
// `clipboardShortcut`. The actual drop -> world-point -> createImageFromBlob
// wiring is DOM (CanvasV2App.tsx) and, per the plan, K's browser contract's
// job to prove end-to-end — this file only pins the filter.
import assert from 'node:assert/strict'
import { extractImageFiles } from './image-drop.js'

function fakeFile(name: string, type: string): File {
	return new File([new Uint8Array([1, 2, 3])], name, { type })
}

// ============================================================================
// 1. Mixed file list: keeps image/* entries, drops everything else, in order.
// ============================================================================
{
	const png = fakeFile('photo.png', 'image/png')
	const txt = fakeFile('notes.txt', 'text/plain')
	const jpeg = fakeFile('shot.jpeg', 'image/jpeg')

	const result = extractImageFiles([png, txt, jpeg])

	assert.equal(result.length, 2, 'exactly the two image files survive the filter')
	assert.deepEqual(result, [png, jpeg], 'order preserved; the non-image file is dropped, not just deprioritized')
	console.log('ok: extractImageFiles keeps image/* files and drops non-image files')
}

// ============================================================================
// 2. No image files at all -> empty array (a non-image-only drop is a
//    total no-op, never a partial/garbage create).
// ============================================================================
{
	const result = extractImageFiles([fakeFile('a.txt', 'text/plain'), fakeFile('b.pdf', 'application/pdf')])
	assert.equal(result.length, 0, 'a drop with no images extracts nothing')
	console.log('ok: extractImageFiles returns [] when no file is an image')
}

// ============================================================================
// 3. Empty input -> empty array, no throw.
// ============================================================================
{
	const result = extractImageFiles([])
	assert.deepEqual(result, [], 'an empty file list extracts to an empty array')
	console.log('ok: extractImageFiles([]) is []')
}

console.log('ok: image-drop')
