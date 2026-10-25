/**
 * Custom-shape prop validators — the ONE definition. The server assembles
 * its tlschema from these; each client ShapeUtil uses the same object as
 * its static props. (Formerly duplicated between server/src/schema.ts and
 * five client ShapeUtils, held together by "Keep in sync" comments.)
 */
import { T } from '@tldraw/validate'

export const terminalShapeProps = {
	w: T.number,
	h: T.number,
	sessionId: T.string,
	title: T.string,
	// Optional status light set via POST /api/terminal/status; optional so
	// existing rooms need no migration.
	status: T.string.optional(),
	// Remote gateway id (spike); optional so existing rooms need no migration.
	gateway: T.string.optional(),
	// Per-terminal base font size (px) — SHARED: one PTY grid per terminal, so
	// font size belongs to the terminal, not the viewer; changing it re-grids
	// for every client. Optional so existing rooms need no migration (= 16).
	fontSize: T.number.optional(),
}

export const nekoShapeProps = {
	w: T.number,
	h: T.number,
	base: T.string,
	title: T.string,
}

export const roadmapShapeProps = {
	w: T.number,
	h: T.number,
	// Slug id of the roadmap document this shape renders (see roadmap-store.ts).
	roadmapId: T.string,
	// Bumped by POST /api/roadmap/doc on every write so clients refetch; optional
	// so existing rooms need no migration.
	rev: T.number.optional(),
}

export const webViewerShapeProps = {
	w: T.number,
	h: T.number,
	// Source discriminator (spec: web-viewer unification): 'file' renders a
	// home-relative path via /files/*; 'dev' renders a VM dev server via the
	// injecting /dev/{port} proxy. Optional so migrated records validate
	// before the migration stamps kind (treat missing as 'file').
	kind: T.literalEnum('file', 'dev').optional(),
	// kind 'file': path relative to the agent user's home. kind 'dev': the
	// in-app path under the dev server root (default '/').
	path: T.string,
	title: T.string,
	// kind 'dev' only: the localhost port the dev server listens on.
	port: T.number.optional(),
	// Bumped by POST /api/canvas/web-viewer refresh so every client reloads.
	rev: T.number.optional(),
	// Remote gateway id (future); optional so existing rooms need no migration.
	gateway: T.string.optional(),
}

export const screenshareShapeProps = {
	w: T.number,
	h: T.number,
	// LiveKit identity of the sharer + their published track name — the join
	// key between the canvas shape and the media plane.
	participantId: T.string,
	trackName: T.string,
	title: T.string,
	// Captured surface aspect (width/height); updated by the sharer's client
	// when the shared window is resized.
	aspect: T.number,
	// /uploads URL of the final frame, stamped by the sharer when the share
	// ends; optional so live shares and existing rooms need no migration.
	stillUrl: T.string.optional(),
	// Hex of the sharer's identity colour, stamped at creation so every viewer
	// sees the same owner-coloured border; optional so existing tiles need no
	// migration (border falls back to the neutral rule colour).
	ownerColor: T.string.optional(),
}
