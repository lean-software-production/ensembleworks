/**
 * Pure predicate over a collaborator's presence `meta`: do they currently
 * hold a file-viewer baton (any shape)? Split out of hideControllerCursor.ts
 * on purpose — that file imports the real 'tldraw' package at runtime
 * (via FadedCollaboratorCursorOverlayUtil), which hangs a bare `bun
 * <file>.test.ts` process on exit (an open handle somewhere in tldraw's
 * import side effects); this module has NO tldraw import, so its test can
 * run — and exit — standalone.
 */
export function hasFileViewerBaton(meta: unknown): boolean {
	if (!meta || typeof meta !== 'object') return false
	const fv = (meta as { fileViewerPresent?: unknown }).fileViewerPresent
	if (!fv || typeof fv !== 'object') return false
	return typeof (fv as { shapeId?: unknown }).shapeId === 'string'
}
