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

export const iframeShapeProps = {
	w: T.number,
	h: T.number,
	url: T.string,
	title: T.string,
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

export const fileViewerShapeProps = {
	w: T.number,
	h: T.number,
	// Path relative to the agent user's home, e.g. "my-repo/docs/report.html".
	path: T.string,
	title: T.string,
	// Bumped by POST /api/canvas/file-viewer refresh so every client reloads.
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

export const codespaceShapeProps = {
	w: T.number,
	h: T.number,
	// The relay gateway id this codespace's connector registered under —
	// child terminal shapes are created with props.gateway = this.
	gatewayId: T.string,
	// Repo/branch identity stamped at creation (from GET /api/terminal/list).
	// Live state (status/owner/inputPolicy) is DELIBERATELY not a synced prop:
	// the gateway registry is the single source of truth and clients poll the
	// list endpoint (~5s while mounted). Decision log 2026-07-21, SP3 item 2.
	repo: T.string,
	branch: T.string,
}
