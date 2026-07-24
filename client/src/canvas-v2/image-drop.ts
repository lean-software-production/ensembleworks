/**
 * Task W1 (docs/plans/2026-07-22-canvas-v2-assets-image.md, D-7) — the
 * DOM-free half of the drop handler: filtering a raw drop's file list down
 * to image `File`s. Kept separate from CanvasV2App.tsx's DOM wiring
 * (`preventDefault`, `getBoundingClientRect`, `screenToWorld`, the per-file
 * `createImageFromBlob` call) so this filter is unit-testable without a
 * real `DragEvent`/`DataTransfer` — mirrors `clipboard-dom.ts`'s
 * `clipboardShortcut` / `image-paste.ts`'s `extractImageBlobs` split
 * between a pure decision and its DOM caller.
 */

/** `DataTransfer.files` is a `FileList` (array-like + iterable in every
 * browser this app targets), but tests hand this a plain `File[]` — this
 * signature accepts either without requiring a real `FileList` instance. */
export type FileListLike = Iterable<File> | ArrayLike<File>

/**
 * Keeps only entries whose MIME `type` starts with `image/` (per D-7) —
 * non-image files (`.txt`, `.pdf`, a folder drop's non-file entries never
 * reach here in the first place) are silently dropped, never thrown on:
 * a drop mixing images and other files should still create the images.
 */
export function extractImageFiles(files: FileListLike): File[] {
	return Array.from(files).filter((file) => file.type.startsWith('image/'))
}
