// Run: bun src/canvas-v2/asset-upload.test.ts
// Task U1 (docs/plans/2026-07-22-canvas-v2-assets-image.md) — mocks the
// `fetch`/dimension-reading seam so this proves the PUT call shape, id
// sanitation, and rejection behavior without a live server or real DOM
// image decode.
import assert from 'node:assert/strict'
import { uploadImage, type UploadImageDeps } from './asset-upload.js'

// The server's actual sanitizeAssetId regex (server/src/canvas/ids.ts),
// copied verbatim so this test pins the SAME contract the real PUT route
// enforces, not an invented one.
const SANITIZE_ASSET_ID_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$/

function fakeBlob(name: string, type: string): File {
	return new File([new Uint8Array([1, 2, 3])], name, { type })
}

// ============================================================================
// 1. Happy path: PUT method + URL shape, sanitized id, returned src/w/h/mimeType/name.
// ============================================================================
{
	const calls: { input: string; init?: RequestInit }[] = []
	const deps: UploadImageDeps = {
		fetch: async (input, init) => {
			calls.push({ input, init })
			return new Response(null, { status: 200 })
		},
		readDimensions: async () => ({ w: 42, h: 24 }),
	}

	const file = fakeBlob('my photo!!.png', 'image/png')
	const result = await uploadImage(file, deps)

	assert.equal(calls.length, 1, 'exactly one fetch call')
	assert.equal(calls[0]!.init?.method, 'PUT', 'PUT, not POST/GET')
	assert.equal(calls[0]!.init?.body, file, 'the file/blob is the PUT body')
	assert.ok(calls[0]!.input.startsWith('/uploads/'), `URL under /uploads/, got ${calls[0]!.input}`)

	const id = calls[0]!.input.slice('/uploads/'.length)
	assert.ok(SANITIZE_ASSET_ID_RE.test(id), `id "${id}" must pass the server's sanitizeAssetId regex`)
	assert.ok(!id.includes(' ') && !id.includes('!'), 'spaces/bangs in the filename are sanitized out')

	assert.equal(result.src, `/uploads/${id}`, 'returned src is /uploads/<same id>')
	assert.equal(result.w, 42, 'w comes from the (mocked) dimension reader')
	assert.equal(result.h, 24, 'h comes from the (mocked) dimension reader')
	assert.equal(result.mimeType, 'image/png')
	assert.equal(result.name, 'my photo!!.png', 'original name is preserved (unsanitized) in the return value')

	console.log('ok: uploadImage PUTs to /uploads/<sanitized-id> and returns src/w/h/mimeType/name')
}

// ============================================================================
// 2. A non-ok PUT response rejects — never a silent success.
// ============================================================================
{
	const deps: UploadImageDeps = {
		fetch: async () => new Response(null, { status: 500 }),
		readDimensions: async () => ({ w: 1, h: 1 }),
	}
	await assert.rejects(() => uploadImage(fakeBlob('x.png', 'image/png'), deps), 'a non-ok response rejects the promise')
	console.log('ok: uploadImage rejects on a non-ok PUT response')
}

// ============================================================================
// 3. Two uploads of the same filename mint DISTINCT ids (real entropy, not a
//    deterministic hash of the name alone).
// ============================================================================
{
	const seen: string[] = []
	const deps: UploadImageDeps = {
		fetch: async (input) => {
			seen.push(input)
			return new Response(null, { status: 200 })
		},
		readDimensions: async () => ({ w: 1, h: 1 }),
	}
	await uploadImage(fakeBlob('same.png', 'image/png'), deps)
	await uploadImage(fakeBlob('same.png', 'image/png'), deps)
	assert.equal(seen.length, 2)
	assert.notEqual(seen[0], seen[1], 'two uploads of the same filename land at different /uploads/<id> paths')
	console.log('ok: uploadImage mints a distinct id per call, even for the same filename')
}

console.log('ok: asset-upload')
