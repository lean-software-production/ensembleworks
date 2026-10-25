/**
 * Presence wiring for the canvas-v2 dogfood mount (Task G4) — the client
 * composition layer that finally closes the two Phase-2 `PresenceStore`
 * deferrals canvas-sync/src/presence.ts's own doc comments name:
 *   - `publish()` is NOT rate-limited (every `set()` goes to the wire
 *     uncoalesced) — THIS module's `createPresencePublisher` (its internal
 *     `flushNow`/`throttledFlush` pair) is the caller-side throttle that
 *     comment says Phase 3's renderer must supply.
 *   - `all()` INCLUDES the caller's own published entry under `selfKey` —
 *     filtering it is canvas-react's `Cursors` component's job (already
 *     built, Seam D6); this module just passes `selfKey` through unchanged.
 *
 * Kept a plain, DOM-free module (no React) so its pure pieces
 * (`adaptPresence`, the presenting codec, `createPresencePublisher` with an
 * injected clock) are house-testable without a browser — CanvasV2App.tsx is
 * the only caller that touches the DOM (pointermove events,
 * `editor.subscribe()` for camera changes).
 *
 * THROTTLE SHAPE (leading-edge, injected clock): the publisher fires the
 * FIRST flush immediately, then DROPS every subsequent one until
 * `intervalMs` has elapsed since the last flush; the next call after that
 * fires immediately again. This is the "~60ms leading-edge throttle" the
 * phase-3 plan's G4 task names as one of the two acceptable shapes
 * (rAF-coalesced being the other) — chosen because it needs no
 * `requestAnimationFrame` (unavailable in this house's headless-DOM test
 * rig — happy-dom implements no real layout/paint loop) and is trivially
 * testable with an injected clock alone. The clock is INJECTED (never a
 * real `Date.now`/`performance.now` read inside this module — real time is
 * supplied by the caller, e.g. CanvasV2App.tsx's `now: () =>
 * performance.now()` at the composition edge), the same discipline
 * canvas-editor's own injected `now`/`random` establish one layer down.
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
 * lag noticeable. (The `editing` field is the one EXCEPTION, by design: an
 * editing TRANSITION bypasses the throttle entirely — see
 * `setViewportAndRefreshCursor`'s doc comment — because it may have no
 * later event to heal through.)
 *
 * (HISTORY: this throttle used to be a standalone exported
 * `leadingEdgeThrottle<T>` helper; the pilot-5 editing-transition bypass
 * needed to share the channel's timing state, which inlined it into
 * `createPresencePublisher` as `flushNow`/`throttledFlush` — after which the
 * standalone export had zero production callers and was deleted (pilot-5
 * quality review). `flushNow`/`throttledFlush` are the single throttle
 * implementation of record.)
 */
import type { Presence, PresenceStore } from '@ensembleworks/canvas-sync'
import { screenToWorld, type Camera } from '@ensembleworks/canvas-editor'
import type { RemotePresence } from '@ensembleworks/canvas-react'
import type { PresentingV2 } from './shapes/presentStoreV2.js'

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
	 * publishes viewport + cursor + (Task F4) `editing` in ONE store write.
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
	 * methods share ONE throttle channel (see createPresencePublisher).
	 *
	 * `editingId` (Task F4, pilot 5 — F1 owner decision: Option 1, indicator
	 * only) is threaded through THIS SAME parameter list rather than a
	 * separate `setEditing` method, for exactly the reason just above: this
	 * method is the ONE call CanvasV2App.tsx's `editor.subscribe()` effect
	 * makes on EVERY EditorState change (camera/selection/hover/editingId
	 * alike, see that effect's own doc comment) — a caller issuing a SECOND,
	 * independent setter call in that SAME synchronous handler (which an
	 * earlier revision of this fix did, via a standalone `setEditing`) hits
	 * the identical same-millisecond drop this doc comment already warns
	 * about, except GUARANTEED every single time rather than a rare
	 * coincidence: the shared throttle fires the FIRST of the two calls (still
	 * missing the second mutation) and silently drops the second, so a
	 * `BeginEdit` landing in the same tick as its own viewport republish would
	 * never actually reach the wire until some LATER, unrelated EditorState
	 * change happened to flush it — probe-confirmed while building this fix
	 * (a real two-context Playwright run: A's `editingId` set correctly, but
	 * B's presence read never showed it, because the drop is deterministic,
	 * not probabilistic, for two same-tick calls sharing one channel). */
	setViewportAndRefreshCursor(
		viewport: { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly z: number } | null,
		camera: Camera,
		editingId: string | null,
	): void
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
	 * present/follow feature. SAFE as a standalone method (unlike a
	 * standalone `setEditing` would have been) because its ONLY caller
	 * (FileViewerShape.tsx) never also calls setViewportAndRefreshCursor in
	 * the SAME synchronous handler — the two triggers (an embed's
	 * present-toggle vs. the editor's camera/selection subscription) are
	 * genuinely independent event sources, so a same-millisecond collision is
	 * the rare, self-healing case this doc comment's sibling one accepts, not
	 * the guaranteed one setViewportAndRefreshCursor's `editingId` parameter
	 * exists to avoid.
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
 * (the module header's TRAILING-EDGE GAP section), which now covers the
 * viewport too.
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
	let current: Presence = { cursor: null, viewport: null, stamp: null, presenting: [], editing: null }
	/** The last SCREEN point setCursorFromScreen saw — what
	 * setViewportAndRefreshCursor re-derives the world cursor from on a
	 * camera change. Null until the first setCursorFromScreen, and reset to
	 * null by a raw setCursor (see the interface doc comments). */
	let lastScreen: { readonly x: number; readonly y: number } | null = null
	/** The `editing` value last actually FLUSHED to the store (not merely
	 * recorded on `current`) — see setViewportAndRefreshCursor's own doc
	 * comment for why an editingId TRANSITION bypasses the shared throttle
	 * entirely instead of going through it like every other field. */
	let lastPublishedEditing: string | null = null

	// The ONE throttle channel — see the factory doc comment's ONE SHARED
	// THROTTLE CHANNEL section for why it must be singular, and the module
	// header's THROTTLE SHAPE/HISTORY sections for its semantics (this pair
	// IS the throttle implementation of record — the standalone
	// leadingEdgeThrottle helper it replaced is deleted). flushNow and
	// throttledFlush share `lastFlushAt` so the F4 bypass path stays
	// coherent with the channel: a bypassed flush still counts as "the
	// channel fired" for the purposes of the NEXT throttled call's window —
	// without that, a same-millisecond call immediately following a bypass
	// would wrongly see "no flush has ever happened" and fire a REDUNDANT
	// second write (harmless payload-wise, since nothing mutated `current` in
	// between, but pointless wire chatter this sharing avoids for free).
	let lastFlushAt: number | null = null
	const flushNow = (): void => {
		lastFlushAt = now()
		store.publish(current)
	}
	const throttledFlush = (): void => {
		const t = now()
		if (lastFlushAt === null || t - lastFlushAt >= intervalMs) flushNow()
		// else: dropped — `current` already carries the update for whenever
		// the NEXT flush (throttled or bypassed) actually happens.
	}

	return {
		setCursor(cursor) {
			lastScreen = null // a raw world cursor supersedes any recorded screen point
			current = { ...current, cursor }
			throttledFlush()
		},
		setCursorFromScreen(screen, camera) {
			lastScreen = screen
			current = { ...current, cursor: screenToWorld(camera, screen) }
			throttledFlush()
		},
		setViewportAndRefreshCursor(viewport, camera, editingId) {
			const cursor = lastScreen !== null ? screenToWorld(camera, lastScreen) : current.cursor
			current = { ...current, viewport, cursor, editing: editingId }
			if (editingId !== lastPublishedEditing) {
				// BeginEdit/EndEdit (Task F4, pilot 5): flush IMMEDIATELY,
				// bypassing the shared leading-edge throttle, rather than going
				// through the normal `publish()` channel. Reason (probe-
				// confirmed building this fix, a real two-context Playwright
				// run): a double-click-to-edit is a BURST of near-simultaneous
				// EditorState changes (down -> SetSelection, up, down, up ->
				// BeginEdit, all within a handful of real milliseconds of each
				// other) — every one of them calls this SAME method, so they
				// all land inside ONE 60ms throttle window, and only the
				// FIRST of the burst actually reaches the store; the LAST one
				// (carrying the editingId change the whole feature exists to
				// show) is dropped. Unlike a dropped CURSOR/VIEWPORT update,
				// which the module header's TRAILING-EDGE GAP section
				// accepts as "self-heals on the next event of any
				// kind," a dropped `editing` transition may have NO later
				// event to piggyback on for the rest of the edit (typing
				// itself never touches EditorState — SetText goes straight to
				// the CRDT doc) — so the peer-editing indicator could stay
				// silently absent for the WHOLE edit. Bypassing the throttle
				// only on an actual transition (not on every publish while
				// mid-edit) keeps this rare and cheap: a same-millisecond
				// double-flush (this bypass plus a throttled call that also
				// happens to fire around the same instant) sends the
				// identical `current` object twice — redundant wire traffic,
				// never a correctness issue, since both calls carry the same
				// payload. `flushNow` (not a raw `store.publish` call) so this
				// bypass ALSO updates `lastFlushAt` — the next throttled call
				// correctly sees "a flush just happened" instead of wrongly
				// firing its own redundant write (see `lastFlushAt`'s own doc
				// comment above).
				lastPublishedEditing = editingId
				flushNow()
			} else {
				throttledFlush() // no transition — the ordinary shared, throttled channel
			}
		},
		setPresenting(presenting) {
			current = { ...current, presenting: encodePresenting(presenting) }
			throttledFlush() // same shared channel — see the interface doc comment's ONE WRITE section
		},
	}
}
