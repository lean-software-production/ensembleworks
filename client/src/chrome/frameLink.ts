// Deep-link helpers for focusing a specific frame from a URL.
// Kept pure (no tldraw/DOM) so they run under the logic-only bun test harness.

// tldraw shape ids look like `shape:<base62-ish>`; validate conservatively.
const SHAPE_ID_RE = /^shape:[A-Za-z0-9_-]{1,100}$/

export function parseFrameId(raw: string | null | undefined): string | null {
	if (!raw) return null
	return SHAPE_ID_RE.test(raw) ? raw : null
}

export function buildFrameLink(origin: string, room: string, frameId: string): string {
	const params = new URLSearchParams({ room, frame: frameId })
	return `${origin}/?${params.toString()}`
}

export function readFrameId(search: string): string | null {
	return parseFrameId(new URLSearchParams(search).get('frame'))
}
