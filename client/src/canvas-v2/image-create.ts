/**
 * Task C1 (docs/plans/2026-07-22-canvas-v2-assets-image.md, D-5) — the
 * reusable async create flow BOTH the drop (W1) and paste-image (W2)
 * handlers call: upload-THEN-create (D — judgment call #1). No optimistic
 * loading-placeholder shape this cycle: the image shape appears only once
 * `uploadImage` (U1) resolves, then this emits ONE atomic
 * `editor.applyAll([PutAsset, CreateShape, SetSelection])` batch — E1's
 * `PutAsset` intent is what makes that batch a single `doc.commit()`, so a
 * peer never observes the image shape before its backing asset (which
 * would flash an unresolved image).
 *
 * `uploadImage` is injected (defaulting to the real U1 helper) so this
 * module's own tests can capture the emitted batch without a live network
 * call or real DOM image decode.
 */
import { indexBetween, type Asset, type Shape } from '@ensembleworks/canvas-model'
import type { Editor } from '@ensembleworks/canvas-editor'
import { uploadImage, type UploadedImage } from './asset-upload.js'

/** Fit an oversized upload within this many px on its longer side,
 * preserving aspect — so a 4000px paste doesn't create a page-sized shape
 * (plan D-5). Images already within bounds are left untouched. */
const MAX_IMAGE_DIM = 2000

function clampToMaxDim(w: number, h: number): { w: number; h: number } {
	const longest = Math.max(w, h)
	if (longest <= MAX_IMAGE_DIM || longest <= 0) return { w, h }
	const scale = MAX_IMAGE_DIM / longest
	return { w: w * scale, h: h * scale }
}

/** A small client id factory — distinct from canvas-editor's `makeId`
 * (module-private to the create-tool FSMs, keyed off event position/time
 * for replay-determinism there). This is a DOM-edge, non-replayed path (a
 * drop/paste is a one-shot async flow, never scripted through canvas-
 * editor's `run()`/replay machinery), so it draws directly from real
 * entropy — the same `crypto.getRandomValues` convention `CanvasV2App.tsx`'s
 * `randomPeerId`/`asset-upload.ts`'s `randomIdPrefix` already establish.
 * Called once per id; the asset and shape ids are two SEPARATE draws (never
 * derived from one shared draw), so they never coincide. */
function mintId(prefix: 'asset' | 'shape'): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8))
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
	return `${prefix}:${hex}`
}

/** Top-of-stack z-order index for a new shape on `pageId` — the same
 * `indexBetween(max, null)` idea canvas-editor's `create.ts` `topIndex`
 * uses, reimplemented here (not imported: `topIndex` is module-private to
 * that file) against `editor.doc.listShapes()` directly, since this flow
 * has no `ToolContext`/snapshot of its own (plan D-5: "the client already
 * has `editor.doc.listShapes()`"). */
function topIndex(editor: Editor, pageId: string): string {
	let max: string | null = null
	for (const s of editor.doc.listShapes()) {
		if (s.parentId !== pageId) continue
		if (max === null || s.index > max) max = s.index
	}
	return indexBetween(max, null)
}

/** Awaits `uploadFn` (U1's `uploadImage` by default), then emits ONE
 * `editor.applyAll([PutAsset, CreateShape, SetSelection])` batch building
 * the `Asset` + image `Shape` from the upload result, CENTERED on
 * `worldPoint` (matches `create.ts`'s `clickShape` centering convention),
 * clamped to `MAX_IMAGE_DIM`, auto-selected so a caller (K's browser
 * contract) can discover the new shape's id via `selectedShapeIds()`.
 *
 * Graceful failure: a non-image file or a failed upload rejects inside
 * `uploadFn` — caught here and swallowed (no crash, no partial/incomplete
 * doc write — nothing is emitted at all). */
export async function createImageFromBlob(
	editor: Editor,
	blob: File | Blob,
	worldPoint: { readonly x: number; readonly y: number },
	pageId: string,
	uploadFn: (file: File | Blob) => Promise<UploadedImage> = uploadImage,
): Promise<void> {
	let uploaded: UploadedImage
	try {
		uploaded = await uploadFn(blob)
	} catch {
		return
	}

	const { w, h } = clampToMaxDim(uploaded.w, uploaded.h)

	const asset: Asset = {
		id: mintId('asset') as Asset['id'],
		type: 'image',
		props: { src: uploaded.src, w, h, mimeType: uploaded.mimeType, name: uploaded.name },
		meta: {},
	}

	const shape: Shape = {
		id: mintId('shape') as Shape['id'],
		kind: 'image',
		parentId: pageId,
		index: topIndex(editor, pageId),
		x: worldPoint.x - w / 2,
		y: worldPoint.y - h / 2,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: { w, h, assetId: asset.id },
	} as Shape

	editor.applyAll([
		{ type: 'PutAsset', asset },
		{ type: 'CreateShape', shape },
		{ type: 'SetSelection', ids: [shape.id] },
	])
}
