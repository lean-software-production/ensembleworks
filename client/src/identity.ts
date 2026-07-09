/**
 * Lightweight identity for a tailnet-trusted team: a name the user picks once
 * (persisted in localStorage) plus a stable random ID. The same identity is
 * used for tldraw presence and (later) the LiveKit participant, which is how
 * video bubbles get matched to cursors.
 */

import { colorKeyForId, isIdentityColor, type IdentityColor } from './colors'
import { readFrameId } from './chrome/frameLink'

const ID_KEY = 'ensembleworks.userId'
const NAME_KEY = 'ensembleworks.userName'
const COLOR_KEY = 'ensembleworks.userColor'

export interface Identity {
	id: string
	name: string
	// A tldraw palette colour name (see colors.ts). Override in localStorage if
	// the user picked one, else a stable hash of their id.
	colorKey: IdentityColor
}

/** The user's chosen colour, or the deterministic default for their id. */
function resolveColorKey(id: string): IdentityColor {
	const override = localStorage.getItem(COLOR_KEY)
	return isIdentityColor(override) ? override : colorKeyForId(id)
}

/** Persist a chosen colour so it survives reloads and wins over the hash. */
export function setUserColor(key: IdentityColor): void {
	localStorage.setItem(COLOR_KEY, key)
}

export function getIdentity(): Identity {
	let id = localStorage.getItem(ID_KEY)
	if (!id) {
		id = crypto.randomUUID()
		localStorage.setItem(ID_KEY, id)
	}
	let name = localStorage.getItem(NAME_KEY)
	while (!name) {
		name = window.prompt('Your name (shown to teammates):')?.trim() || null
	}
	localStorage.setItem(NAME_KEY, name)
	return { id, name, colorKey: resolveColorKey(id) }
}

/**
 * Read the stored identity without prompting — for render paths (e.g. an iframe
 * shape resolving a per-viewer URL) that must never pop a name prompt. Returns
 * empty strings if the user hasn't been onboarded yet; by canvas-render time
 * getIdentity() has already run at startup, so the name is set.
 */
export function peekIdentity(): { id: string; name: string } {
	return {
		id: localStorage.getItem(ID_KEY) ?? '',
		name: localStorage.getItem(NAME_KEY) ?? '',
	}
}

export function getRoomId(): string {
	const room = new URLSearchParams(location.search).get('room') ?? 'team'
	return /^[a-zA-Z0-9_-]{1,64}$/.test(room) ? room : 'team'
}

// Returns the deep-link target frame id from the current URL, or null.
export function getFrameId(): string | null {
	return readFrameId(location.search)
}
