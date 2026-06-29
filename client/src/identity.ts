/**
 * Lightweight identity for a tailnet-trusted team: a name the user picks once
 * (persisted in localStorage) plus a stable random ID. The same identity is
 * used for tldraw presence and (later) the LiveKit participant, which is how
 * video bubbles get matched to cursors.
 */

const ID_KEY = 'ensembleworks.userId'
const NAME_KEY = 'ensembleworks.userName'

export interface Identity {
	id: string
	name: string
	color: string
}

const COLORS = ['#4f8fef', '#e0598b', '#39b27d', '#e8a33d', '#9d6ce8', '#d96c4a']

function hashCode(s: string): number {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
	return Math.abs(h)
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
	return { id, name, color: COLORS[hashCode(id) % COLORS.length]! }
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
