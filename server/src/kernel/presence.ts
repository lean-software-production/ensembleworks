import { parseStamp, type SpatialStamp } from '@ensembleworks/contracts'
import type { AccessIdentity } from '../access-identity.ts'
import { dist } from '../canvas/geometry.ts'

/**
 * Presence service — reads live cursor/selection state from a TLSocketRoom.
 * QUARANTINE: room.getPresenceRecords?.() is an untyped private sync-core
 * API; this module is the only place allowed to touch it (unified design
 * §1.3 / migration step "getPresenceRecords quarantined").
 */

export interface CursorRef {
	userId: string | null
	userName: string
	currentPageId: string
	cursor: { x: number; y: number }
	// Camera + viewport, used to stamp the frame a speaker is *looking at* when
	// their mouse cursor isn't pointing inside a frame (null on tldraw versions
	// or presence records that omit them).
	camera: { x: number; y: number; z: number } | null
	screenBounds: { w: number; h: number } | null
	lastActivityTimestamp: number
	// Client-computed spatial stamp (null: pre-stamp bundle or non-canvas peer).
	stamp: SpatialStamp | null
}

// tldraw presence stores userId as a prefixed TLUserId ("user:abc"), but the
// LiveKit identity the scribe posts is the raw form ("abc"). Normalise both to
// raw before matching a speaker to their cursor.
export function rawUserId(id: string | null): string {
	return (id ?? '').replace(/^user:/, '')
}

// Live presence records for a room, via the (internal, untyped) accessor.
// Guarded so a tldraw version without it just disables proximity sorting.
export function getCursorRefs(room: any): CursorRef[] {
	let presence: Record<string, any> = {}
	try {
		presence = room.getPresenceRecords?.() ?? {}
	} catch {
		return []
	}
	return Object.values(presence)
		.filter((p: any) => p?.cursor && typeof p.currentPageId === 'string')
		.map((p: any) => ({
			userId: typeof p.userId === 'string' ? p.userId : null,
			userName: typeof p.userName === 'string' ? p.userName : 'teammate',
			currentPageId: p.currentPageId,
			cursor: { x: p.cursor.x, y: p.cursor.y },
			camera:
				p.camera && typeof p.camera.x === 'number' && typeof p.camera.y === 'number'
					? { x: p.camera.x, y: p.camera.y, z: typeof p.camera.z === 'number' ? p.camera.z : 1 }
					: null,
			screenBounds:
				p.screenBounds && typeof p.screenBounds.w === 'number' && typeof p.screenBounds.h === 'number'
					? { w: p.screenBounds.w, h: p.screenBounds.h }
					: null,
			lastActivityTimestamp: p.lastActivityTimestamp ?? 0,
			stamp: parseStamp(p.meta?.stamp),
		}))
}

// A person currently connected to a room, as reported to /api/participants —
// the join of live presence (name + page) with their captured Cloudflare Access
// identity (email). `email` is null when their identity wasn't captured (dev /
// header-trust gaps); `pageId` is the tldraw page they're on.
export interface Participant {
	userId: string
	name: string
	email: string | null
	verified: boolean
	pageId: string
}

// Join live presence with captured Access identities into a deduped participant
// list. With `page` set, only people on that tldraw page are included — this is
// the co-author rule: present in the same room AND on the same page. Pure, so
// it's unit-tested directly.
export function buildParticipants(
	refs: CursorRef[],
	identities: Map<string, AccessIdentity> | undefined,
	page?: string | null,
): Participant[] {
	const byUser = new Map<string, Participant>()
	for (const ref of refs) {
		if (page && ref.currentPageId !== page) continue
		const uid = rawUserId(ref.userId)
		if (!uid || byUser.has(uid)) continue
		const id = identities?.get(uid)
		byUser.set(uid, {
			userId: uid,
			name: ref.userName,
			email: id?.email ?? null,
			verified: id?.verified ?? false,
			pageId: ref.currentPageId,
		})
	}
	return [...byUser.values()]
}

// The most-recently-active cursor, optionally restricted to one page (a cursor
// on another page can't meaningfully order shapes on this one).
export function pickCursor(refs: CursorRef[], pageId?: string): CursorRef | null {
	const candidates = pageId ? refs.filter((r) => r.currentPageId === pageId) : refs
	if (!candidates.length) return null
	return candidates.reduce((a, b) => (b.lastActivityTimestamp > a.lastActivityTimestamp ? b : a))
}

// The point a teammate's reads are ordered by: their client-computed stamp
// point when present (where they're at / looking at — the cursor is usually
// parked off-canvas since the camera bubble decoupled from it), else the raw
// cursor. Point *selection* only; no geometry is recomputed here.
export function sortPointOf(ref: CursorRef): { x: number; y: number } {
	return ref.stamp?.at ?? ref.cursor
}

// Sort items (each carrying a page-space `pt`) by distance to the sort point
// (the teammate's stamp point when present, else their raw cursor — see
// sortPointOf), attaching a rounded `dist`. Returns a new array; input order
// on a tie is preserved. With no cursor, returns the items unchanged and
// undistanced.
export function byProximity<T extends { pt: { x: number; y: number } }>(
	items: T[],
	cursor: CursorRef | null
): Array<Omit<T, 'pt'> & { dist: number | null }> {
	const decorated = items.map((it, i) => {
		const { pt, ...rest } = it
		const d = cursor ? dist(pt, sortPointOf(cursor)) : null
		return { rest, d, i }
	})
	if (cursor) decorated.sort((a, b) => a.d! - b.d! || a.i - b.i)
	return decorated.map((e) => ({ ...(e.rest as Omit<T, 'pt'>), dist: e.d === null ? null : Math.round(e.d) }))
}
