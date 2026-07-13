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
import type { RemotePresence } from '@ensembleworks/canvas-react'

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

export interface PresencePublisher {
	/** World-space cursor position (or `null` to publish "no cursor" — e.g. the
	 * pointer left the viewport). Throttled per PRESENCE_THROTTLE_MS. */
	setCursor(cursor: { readonly x: number; readonly y: number } | null): void
	/** The camera's current viewport rect (x/y/z from EditorState.camera, w/h
	 * from the mount's measured ViewportSize). Throttled independently of
	 * setCursor (its own leading-edge window), since a pan/zoom and a mouse
	 * move are unrelated events that both want to feel live without
	 * compounding into a single shared budget. */
	setViewport(viewport: { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly z: number } | null): void
}

/**
 * Builds the stateful publisher CanvasV2App.tsx wires to pointermove (cursor)
 * and `editor.subscribe()` (viewport). Holds the FULL `Presence` object
 * (`PresenceStore.publish` replaces the whole value under `selfKey` per call
 * — there is no partial-field update on the wire) and republishes it,
 * throttled, every time either half changes.
 *
 * `stamp`/`presenting` STAY THEIR INITIAL VALUES (`null`/`[]`) for the
 * lifetime of this mount — HONEST, not an oversight: this phase's tool set
 * (select/hand/note/text/geo/frame/arrow, per the plan's ratified Q3) has no
 * spatial-stamp tool and no "presenting a shape" feature, so there is no
 * event source to wire either field to yet. They ride along in every publish
 * so a FUTURE tool that starts calling a `setStamp`/`setPresenting` (not
 * added here — nothing produces them) needs no change to this shape.
 */
export function createPresencePublisher(store: PresenceStore, opts: { readonly intervalMs?: number; readonly now?: () => number } = {}): PresencePublisher {
	const now = opts.now ?? (() => performance.now())
	const intervalMs = opts.intervalMs ?? PRESENCE_THROTTLE_MS
	let current: Presence = { cursor: null, viewport: null, stamp: null, presenting: [] }

	const publishCursor = leadingEdgeThrottle<void>(intervalMs, now, () => store.publish(current))
	const publishViewport = leadingEdgeThrottle<void>(intervalMs, now, () => store.publish(current))

	return {
		setCursor(cursor) {
			current = { ...current, cursor }
			publishCursor()
		},
		setViewport(viewport) {
			current = { ...current, viewport }
			publishViewport()
		},
	}
}
