/**
 * Task U1 (docs/plans/2026-07-22-canvas-v2-assets-image.md, D-5) — port of
 * `client/src/assetStore.ts`'s `TLAssetStore.upload` (v1, tldraw-driven)
 * into a standalone v2 helper. Same wire contract (`PUT /uploads/:id`, a
 * SANITIZED, ≤64-char blob id distinct from the Loro `AssetId` C1 mints),
 * plus this v2 version ALSO reads the blob's natural pixel dimensions —
 * v1 never needed to (tldraw's own asset pipeline reads dimensions itself);
 * v2's `createImageFromBlob` (C1) needs `w`/`h` up front to size the image
 * shape it creates, so U1 folds dimension-reading into the same upload call
 * rather than making C1 do a second DOM round-trip.
 *
 * `fetch` and dimension-reading are both isolated behind the injectable
 * `deps` param (defaulting to the real DOM/fetch) so C1's tests — and this
 * module's own — never need a live server or a real `<img>`/`ImageBitmap`
 * decode.
 */

export interface UploadedImage {
	readonly src: string
	readonly w: number
	readonly h: number
	readonly mimeType: string
	readonly name: string
}

export interface UploadImageDeps {
	/** Same signature as the global `fetch` — swap for a mock in tests. */
	readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
	/** Reads a blob's natural pixel dimensions. Real impl below prefers
	 * `createImageBitmap` (no `<img>`/objectURL churn); falls back to an
	 * `Image()` + `URL.createObjectURL` decode where `createImageBitmap`
	 * is unavailable. */
	readonly readDimensions: (blob: Blob) => Promise<{ w: number; h: number }>
}

/** Real dimension reader — DOM/browser only (never imported by anything
 * clean-room; this whole module lives under `client/src/canvas-v2/`, which
 * is explicitly DOM/fetch-exempt from the boundary scan — see the plan's
 * "Clean-room boundary" section). */
async function readImageDimensions(blob: Blob): Promise<{ w: number; h: number }> {
	if (typeof createImageBitmap === 'function') {
		const bitmap = await createImageBitmap(blob)
		try {
			return { w: bitmap.width, h: bitmap.height }
		} finally {
			bitmap.close()
		}
	}
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(blob)
		const img = new Image()
		img.onload = () => {
			URL.revokeObjectURL(url)
			resolve({ w: img.naturalWidth, h: img.naturalHeight })
		}
		img.onerror = () => {
			URL.revokeObjectURL(url)
			reject(new Error('failed to read image dimensions'))
		}
		img.src = url
	})
}

const defaultDeps: UploadImageDeps = {
	fetch: (input, init) => fetch(input, init),
	readDimensions: readImageDimensions,
}

/** `id` sanitation copied verbatim from `assetStore.ts`'s v1 rule (see that
 * file): `${uniqueId()}-${name.replace(/[^a-zA-Z0-9_.-]/g,'_')}`.slice(0,64).
 * v1 draws its unique prefix from tldraw's `uniqueId()`; this v2 port has no
 * tldraw dependency, so it draws the same shape of prefix from real entropy
 * (`crypto.getRandomValues`, the same "client edge, real entropy" convention
 * `CanvasV2App.tsx`'s `randomPeerId`/`cryptoRandom` already establish) — an
 * 8-byte hex string, which trivially satisfies the server's
 * `sanitizeAssetId` regex (`^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$`,
 * server/src/canvas/ids.ts) on its own, before the filename suffix is even
 * appended. */
function randomIdPrefix(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8))
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Read `blob`'s dimensions and PUT it to `/uploads/<sanitized-id>`. Returns
 * the same-origin `src` (`/uploads/<id>`, relative — the client's Vite
 * proxy already routes `/uploads` to the sync server) plus the id's needed
 * for building an `Asset` (C1). Throws (rejects) on a non-ok PUT response —
 * the caller (C1) decides how to handle that, never a silent success. */
export async function uploadImage(file: File | Blob, deps: UploadImageDeps = defaultDeps): Promise<UploadedImage> {
	const name = file instanceof File ? file.name : 'image'
	const mimeType = file.type
	const { w, h } = await deps.readDimensions(file)
	const id = `${randomIdPrefix()}-${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`.slice(0, 64)
	const res = await deps.fetch(`/uploads/${id}`, { method: 'PUT', body: file })
	if (!res.ok) throw new Error(`asset upload failed: ${res.status}`)
	return { src: `/uploads/${id}`, w, h, mimeType, name }
}
