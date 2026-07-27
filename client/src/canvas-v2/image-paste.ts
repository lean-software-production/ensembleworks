/**
 * Task W2 (docs/plans/2026-07-22-canvas-v2-assets-image.md, D-7) — the
 * DOM-free half of the paste-image handler: filtering a raw clipboard's
 * item list down to image `File`/`Blob`s. Kept separate from
 * CanvasV2App.tsx's DOM wiring (the document-level `paste` listener,
 * `preventDefault`, the viewport-center world point, the per-blob
 * `createImageFromBlob` call) so this filter is unit-testable without a
 * real `ClipboardEvent`/`DataTransfer` — mirrors `image-drop.ts`'s
 * `extractImageFiles` split between a pure decision and its DOM caller.
 *
 * NO DOUBLE-HANDLING (D-7): copying an EW shape selection puts EW-clipboard
 * TEXT on the clipboard (see `clipboard-dom.ts`'s `writeClipboardText`) and
 * no image item, so this extractor returns `[]` for that clipboard and the
 * existing Ctrl+V -> `readClipboardText` -> `pasteIntents` path is what
 * fires. Copying/dragging in an IMAGE from outside the app puts no EW text
 * on the clipboard, so `pasteIntents` sees a payload it can't decode and
 * no-ops, while THIS extractor finds the image item. The two paths handle
 * disjoint clipboard content, so a single paste event never triggers both.
 */

export interface ClipboardItemLike {
	readonly kind: string
	readonly type: string
	getAsFile(): File | null
}

export interface ClipboardDataLike {
	readonly items: Iterable<ClipboardItemLike> | ArrayLike<ClipboardItemLike>
}

/**
 * Keeps only items that are BOTH a file (`kind === 'file'` — excludes plain
 * text/HTML string items, e.g. an EW shape-copy's clipboard text or an
 * ordinary text copy) AND an image (`type` starts with `image/`), then
 * resolves each surviving item via `getAsFile()`. A `getAsFile()` that
 * returns `null` (defensive; shouldn't happen for a `kind:'file'` image
 * item) is filtered out too — this never throws on a malformed clipboard.
 */
export function extractImageBlobs(clipboardData: ClipboardDataLike): File[] {
	const blobs: File[] = []
	for (const item of Array.from(clipboardData.items)) {
		if (item.kind !== 'file') continue
		if (!item.type.startsWith('image/')) continue
		const file = item.getAsFile()
		if (file) blobs.push(file)
	}
	return blobs
}
