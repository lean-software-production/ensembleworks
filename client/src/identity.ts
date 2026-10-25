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
// First paint waits on the whoami seed (first visit per browser only), so it is
// bounded: a slow or unreachable Access origin must not hold the canvas up.
const WHOAMI_TIMEOUT_MS = 1_500

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

let memo: Identity | null = null

/**
 * getIdentity(), evaluated at most once per page load. Both module-scope call
 * sites (main.tsx and App.tsx) go through this so the name prompt can never
 * fire twice, and — the reason it exists — so identity is resolved at RENDER
 * time rather than module-eval time. That lets main.tsx await
 * seedNameFromWhoami() before anything reads the name; a module-eval read in a
 * statically-imported module would run first and prompt regardless.
 */
export function identityOnce(): Identity {
	return (memo ??= getIdentity())
}

/**
 * Seed the display name from the Cloudflare Access identity (GET /api/whoami)
 * so presence names and server logs name the same person — the client half of
 * the identity binding (issue #55 Problem 1).
 *
 * Deliberately weak: it only ever fills an EMPTY name, so a name the user chose
 * is never overwritten, and every failure path (offline, non-200, timeout, no
 * SSO identity — local dev bypasses Access) leaves the name unset and falls
 * through to getIdentity()'s prompt. Startup awaits this, so it is bounded and
 * never throws.
 */
export async function seedNameFromWhoami(): Promise<void> {
	if (localStorage.getItem(NAME_KEY)) return
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		// The deadline is enforced here rather than left to AbortSignal alone: the
		// bound on first paint must hold even if the hang is downstream of the
		// response headers (a stalled body, a slow json()), where an abort of the
		// request no longer helps. The abort still fires, to cancel the request.
		const name = await Promise.race([
			(async () => {
				const res = await fetch('/api/whoami', { signal: controller.signal })
				if (!res.ok) return ''
				const body = (await res.json()) as { identity?: unknown; kind?: unknown }
				// A bot or anonymous caller is not this session's human user.
				if (body.kind !== 'human') return ''
				return typeof body.identity === 'string' ? body.identity.trim() : ''
			})(),
			new Promise<string>((resolve) => {
				timer = setTimeout(() => {
					controller.abort()
					resolve('')
				}, WHOAMI_TIMEOUT_MS)
			}),
		])
		if (name) localStorage.setItem(NAME_KEY, name)
	} catch {
		// Offline, aborted, or malformed — the prompt is the fallback.
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
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
