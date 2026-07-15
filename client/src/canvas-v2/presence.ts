/**
 * Presence wiring for the canvas-v2 dogfood mount (Task G4) — the client
 * composition layer that finally closes the two Phase-2 `PresenceStore`
 * deferrals canvas-sync/src/presence.ts's own doc comments name:
 *   - `publish()` is NOT rate-limited (every `set()` goes to the wire
 *     uncoalesced) — THIS module's `leadingEdgeThrottle` + `createPresence
 *     Publisher` are the caller-side throttle that comment says Phase 3's
 *     renderer must supply.
 *   - `all()` INCLUDES the caller's own published entry under `selfKey` —
 *     filtering it is canvas-react's `Cursors` component's job (already
 *     built, Seam D6); this module just passes `selfKey` through unchanged.
 *
 * Kept a plain, DOM-free module (no React) so its two pure pieces
 * (`leadingEdgeThrottle`, `adaptPresence`) are house-testable without a
 * browser — CanvasV2App.tsx is the only caller that touches the DOM
 * (pointermove events, `editor.subscribe()` for camera changes).
 */
import type { Presence, PresenceStore } from '@ensembleworks/canvas-sync'
import { screenToWorld, type Camera } from '@ensembleworks/canvas-editor'
import type { RemotePresence } from '@ensembleworks/canvas-react'
import type { PresentingV2 } from './shapes/presentStoreV2.js'

/**
 * Leading-edge throttle over `intervalMs`, driven by an INJECTED clock
 * (never a real `Date.now`/`performance.now` read inside this function
 * itself — real time is supplied by the caller, e.g. CanvasV2App.tsx's own
 * `now: () => performance.now()` at the composition edge; tests inject a
 * fake, monotonically-advanced clock for determinism, the same discipline
 * canvas-editor's own injected `now`/`random` establish one layer down).
 *
 * Fires the FIRST call immediately, then DROPS every subsequent call until
 * `intervalMs` has elapsed since the last fire; the next call after that
 * elapses fires immediately again. This is the "~60ms leading-edge throttle"
 * the phase-3 plan's G4 task names as one of the two acceptable shapes
 * (rAF-coalesced being the other) — chosen here because it needs no
 * `requestAnimationFrame` (unavailable in this house's headless-DOM test
 * rig — happy-dom implements no real layout/paint loop) and is trivially
 * testable with an injected clock alone.
 *
 * TRAILING-EDGE GAP (documented, not hidden — OURS v1, deliberately left
 * open): a burst of calls that STOPS mid-interval never gets a final
 * "settle" publish for its last dropped value. Cursor position is the
 * primary consumer here, and a cursor's own NEXT move (whenever the user
 * resumes) fires immediately regardless — so the visible cost is "a remote
 * cursor may freeze up to `intervalMs` early/late relative to its true stop
 * point," not "a cursor position is ever silently lost forever." A
 * trailing-edge variant (schedule a timeout to flush the last dropped value)
 * is a documented, deferred upgrade if a real dogfood session finds this
 * lag noticeable.
 */
export function leadingEdgeThrottle<T>(intervalMs: number, now: () => number, publish: (value: T) => void): (value: T) => void {
	let last: number | null = null
	return (value: T) => {
		const t = now()
		if (last === null || t - last >= intervalMs) {
			last = t
			publish(value)
		}
	}
}

/** ~60ms leading-edge, per the phase-3 plan's G4 task text ("rAF-coalesced or
 * ~60ms leading-edge"). Roughly one publish every 3-4 real animation frames
 * at 60fps — frequent enough to feel live, coarse enough that a fast mouse
 * sweep or a rapid pan/zoom doesn't flood the wire (canvas-sync/src/
 * presence.ts's own "every set() hits the wire uncoalesced" warning is
 * exactly what this bounds). */
export const PRESENCE_THROTTLE_MS = 60

/**
 * Adapt canvas-sync's wire `Presence` map (`PresenceStore.all()`'s return
 * shape) to canvas-react's `Cursors` component's `RemotePresence` map.
 *
 * NAME/COLOR GAP (documented, not hidden — OURS v1): canvas-sync's
 * `Presence` wire payload (`{cursor, viewport, stamp, presenting}` —
 * canvas-sync/src/presence.ts) carries NO identity fields at all — there is
 * no peer name or color to read off the wire for a REMOTE peer, unlike the
 * LEGACY tldraw engine's own presence record, which DOES carry a
 * user's name/color (see App.tsx's `setUserPreferences` call, consumed by
 * `@tldraw/sync`'s own multiplayer presence system — a wholly different,
 * older wire contract this new v2 stack does not reuse). This adapter
 * therefore only ever supplies `cursor`; `name`/`color` are left `undefined`
 * for every entry. `Cursors.tsx`'s own deterministic `colorForKey(key)`
 * fallback — EXPLICITLY sanctioned for exactly this situation, per its own
 * doc comment — supplies a stable per-peer color from the presence map's own
 * key (the peer's `selfKey`, i.e. their userId in this mount — see
 * CanvasV2App.tsx), just with no name label rendered alongside it. Extending
 * the wire contract to carry identity is a canvas-sync change, out of this
 * unit's scope.
 */
export function adaptPresence(all: Readonly<Record<string, Presence>>): Record<string, RemotePresence> {
	const out: Record<string, RemotePresence> = {}
	for (const [key, p] of Object.entries(all)) out[key] = { cursor: p.cursor }
	return out
}

/**
 * Encodes THIS peer's own presenting state (`presentStoreV2`'s single-slot
 * model — a client presents at most one shape at a time) onto canvas-sync's
 * `Presence.presenting: string[]` wire field (canvas-sync/src/presence.ts —
 * a bare array of strings, no richer shape). `null` (presenting nothing)
 * encodes to the empty array, exactly the field's pre-Task-D5 default (see
 * `createPresencePublisher`'s `current` seed below). Each entry is a JSON
 * blob rather than a delimited string — robust against a `shapeId`
 * containing whatever separator a delimited format would have picked.
 */
export function encodePresenting(p: PresentingV2 | null): string[] {
	return p ? [JSON.stringify(p)] : []
}

/**
 * Decodes a peer's wire `presenting` field back into `PresentingV2` entries.
 * Any malformed entry is skipped, not thrown — a peer running different/
 * older code (or some future non-file-viewer presenter) must never crash
 * this peer's read.
 */
export function decodePresenting(presenting: readonly string[]): PresentingV2[] {
	const out: PresentingV2[] = []
	for (const raw of presenting) {
		try {
			const parsed = JSON.parse(raw) as { shapeId?: unknown; fraction?: unknown; ts?: unknown }
			if (typeof parsed.shapeId === 'string' && typeof parsed.fraction === 'number' && typeof parsed.ts === 'number') {
				out.push({ shapeId: parsed.shapeId, fraction: parsed.fraction, ts: parsed.ts })
			}
		} catch {
			/* malformed entry — skip, don't throw */
		}
	}
	return out
}

/**
 * Resolves who (if anyone, other than `selfKey`) is presenting `shapeId` —
 * the canvas-sync-wire port of the legacy `presenterFor` (git history:
 * client/src/file-viewer/followLogic.ts). Several peers can each carry a
 * presenting token for the same shape during a handoff race (presence
 * tokens can't be cleared across users); the FRESHEST `ts` wins, true
 * last-writer-wins, matching the legacy rule exactly. `selfKey` is always
 * excluded — `all` includes the caller's own published entry (same
 * `PresenceStore.all()` contract `adaptPresence` documents), and a peer
 * never follows itself.
 */
export function presenterFor(all: Readonly<Record<string, Presence>>, selfKey: string, shapeId: string): { peerKey: string; fraction: number; ts: number } | null {
	let best: { peerKey: string; fraction: number; ts: number } | null = null
	for (const [peerKey, presence] of Object.entries(all)) {
		if (peerKey === selfKey) continue
		for (const entry of decodePresenting(presence.presenting)) {
			if (entry.shapeId !== shapeId) continue
			if (!best || entry.ts > best.ts) best = { peerKey, fraction: entry.fraction, ts: entry.ts }
		}
	}
	return best
}

export interface PresencePublisher {
	/** World-space cursor position (or `null` to publish "no cursor" — e.g. the
	 * pointer left the viewport). Throttled per PRESENCE_THROTTLE_MS.
	 * FORGETS any screen point recorded by setCursorFromScreen (a caller
	 * publishing a raw world cursor — or clearing it with null — is asserting
	 * the screen-point derivation no longer applies, so a later camera
	 * refresh must not resurrect a stale screen point over it). */
	setCursor(cursor: { readonly x: number; readonly y: number } | null): void
	/** The pointermove path (quality-review fix round): records `screen` (the
	 * viewport-relative InputEvent x/y) so a LATER camera change can
	 * re-derive the world cursor from it (setViewportAndRefreshCursor below),
	 * then converts screen->world via `camera` and publishes. */
	setCursorFromScreen(screen: { readonly x: number; readonly y: number }, camera: Camera): void
	/** The camera-change path (quality-review fix round — the bug this
	 * closes: a wheel pan/zoom with a stationary mouse changes the world
	 * point under the unmoved screen cursor, and publishing only the viewport
	 * left peers seeing the cursor frozen at the pre-pan world spot):
	 * updates the viewport rect (x/y/z from EditorState.camera, w/h from the
	 * mount's measured ViewportSize) AND re-derives the world cursor from
	 * the LAST screen point setCursorFromScreen recorded (skipped when none
	 * is recorded, or a raw setCursor has since superseded it), then
	 * publishes BOTH in one store write.
	 *
	 * ONE WRITE, DELIBERATELY (probe-established, not style): loro-crdt's
	 * EphemeralStore timestamps each `set()` at wall-clock MILLISECOND
	 * granularity, and a REMOTE peer applying two same-key deltas from the
	 * same millisecond keeps the FIRST on the LWW tie — probed directly
	 * against loro-crdt 1.13.6 (two back-to-back `set('k', ...)` calls, both
	 * deltas applied to a second store: the local store ends at the second
	 * value, the remote store keeps the FIRST in 4 of 5 runs — losing only
	 * when the two sets straddle a millisecond boundary). Publishing the
	 * viewport and the refreshed cursor as two separate writes in one
	 * synchronous handler therefore made the cursor refresh silently vanish
	 * on the remote side most of the time (the exact flake the CanvasV2App
	 * integration test caught). One combined write per triggering event is
	 * the fix — and the same reasoning is why ALL of this publisher's
	 * methods share ONE throttle channel (see createPresencePublisher). */
	setViewportAndRefreshCursor(viewport: { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly z: number } | null, camera: Camera): void
	/**
	 * Task D5: publishes THIS peer's own file-viewer (or any future embed's)
	 * presenting state — `null` to stop presenting. Folds into the SAME
	 * `current` object and the SAME shared throttle channel as
	 * setCursor/setCursorFromScreen/setViewportAndRefreshCursor above — NOT a
	 * second independent `PresenceStore.publish()` call. That matters for the
	 * exact reason setViewportAndRefreshCursor's doc comment gives: two
	 * separate `set()` writes landing in the same wall-clock millisecond lose
	 * the SECOND on a remote peer's LWW tie. A caller that ever adds its own
	 * extra `store.publish()` for `presenting` — instead of routing through
	 * this method — reintroduces exactly that flake for the file-viewer's
	 * present/follow feature.
	 */
	setPresenting(presenting: PresentingV2 | null): void
}

/**
 * Builds the stateful publisher CanvasV2App.tsx wires to pointermove (cursor)
 * and `editor.subscribe()` (viewport + cursor refresh). Holds the FULL
 * `Presence` object (`PresenceStore.publish` replaces the whole value under
 * `selfKey` per call — there is no partial-field update on the wire) and
 * republishes it, throttled, every time any half changes.
 *
 * ONE SHARED THROTTLE CHANNEL for every method (a deliberate revision of the
 * original two-independent-channels design, forced by the EphemeralStore
 * same-millisecond LWW tie documented on setViewportAndRefreshCursor above):
 * two separate channels could each legally fire within the same millisecond
 * (e.g. a pointermove and a wheel event in one frame), producing exactly the
 * two-writes-one-ms pattern whose second write a remote peer DROPS. A single
 * leading-edge channel makes "at most one store write per interval" true by
 * construction — no same-ms pair can ever leave this publisher. Cost: cursor
 * and viewport share the one 60ms budget, so e.g. a camera change landing
 * <60ms after a cursor publish is dropped (not queued) — self-healing on the
 * next event of ANY kind, since every publish carries the FULL object; the
 * only unrecoverable case is the already-documented trailing-edge gap
 * (leadingEdgeThrottle's own doc comment), which now covers the viewport
 * too.
 *
 * `stamp` STAYS ITS INITIAL VALUE (`null`) for the lifetime of this mount —
 * HONEST, not an oversight: this phase's tool set (select/hand/note/text/
 * geo/frame/arrow, per the plan's ratified Q3) has no spatial-stamp tool, so
 * there is no event source to wire it to yet. It rides along in every
 * publish so a FUTURE tool that starts calling a `setStamp` (not added here
 * — nothing produces it) needs no change to this shape.
 *
 * `presenting` (Task D5) is now wired: `setPresenting` below folds a
 * FileViewerShape (or future embed) presenting toggle into this SAME
 * `current` object, on this SAME shared throttle channel — see
 * PresencePublisher.setPresenting's doc comment for why that matters.
 */
export function createPresencePublisher(store: PresenceStore, opts: { readonly intervalMs?: number; readonly now?: () => number } = {}): PresencePublisher {
	const now = opts.now ?? (() => performance.now())
	const intervalMs = opts.intervalMs ?? PRESENCE_THROTTLE_MS
	let current: Presence = { cursor: null, viewport: null, stamp: null, presenting: [] }
	/** The last SCREEN point setCursorFromScreen saw — what
	 * setViewportAndRefreshCursor re-derives the world cursor from on a
	 * camera change. Null until the first setCursorFromScreen, and reset to
	 * null by a raw setCursor (see the interface doc comments). */
	let lastScreen: { readonly x: number; readonly y: number } | null = null

	// The ONE throttle channel — see the factory doc comment's ONE SHARED
	// THROTTLE CHANNEL section for why it must be singular.
	const publish = leadingEdgeThrottle<void>(intervalMs, now, () => store.publish(current))

	return {
		setCursor(cursor) {
			lastScreen = null // a raw world cursor supersedes any recorded screen point
			current = { ...current, cursor }
			publish()
		},
		setCursorFromScreen(screen, camera) {
			lastScreen = screen
			current = { ...current, cursor: screenToWorld(camera, screen) }
			publish()
		},
		setViewportAndRefreshCursor(viewport, camera) {
			const cursor = lastScreen !== null ? screenToWorld(camera, lastScreen) : current.cursor
			current = { ...current, viewport, cursor }
			publish() // ONE store write for both halves — see the interface doc comment
		},
		setPresenting(presenting) {
			current = { ...current, presenting: encodePresenting(presenting) }
			publish() // same shared channel — see the interface doc comment's ONE WRITE section
		},
	}
}
