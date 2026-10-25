# Viewport-Relative Spatial Audio + Legibility Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a teammate's volume depend on where their cursor sits relative to MY current viewport (zoom = reach), and make that volume visible everywhere the teammate is shown (video tile dims, cursor fades, audible-zone ring, hover % readout).

**Architecture:** The falloff curve in `av/spatial.ts` is unchanged; only its input metric changes from page units to screen pixels (`pageDistance × zoom`), with radii as fractions of the viewport half-diagonal. The 150 ms loop in `av/useSpatialGainLoop.ts` computes each peer's applied gain and publishes a quantised per-peer gain map through a new store in `av/bridge.ts` — the single source of truth all visual cues read. Cursor fade is a subclass of tldraw's `CollaboratorCursorOverlayUtil` (replaces the default via the `overlayUtils` prop). PR #29's `gainTarget()` in `av/crosstalk.ts` is untouched.

**Tech Stack:** TypeScript, React, tldraw, LiveKit WebAudio, bare-bun test scripts (`bun src/av/<file>.test.ts` run from `client/`).

**Spec:** `docs/superpowers/specs/2026-07-16-viewport-relative-spatial-audio-design.md`

**Conventions you must follow:**
- All commands below run from the repo's `client/` directory unless stated otherwise.
- Tests in this codebase are **bare-bun scripts**, not `bun test` suites: they `import assert` or throw on failure, print `PASS:` lines, and end with a `console.log('… ALL … PASSED')`. Follow that exact style (see `src/av/spatial.test.ts`, `src/av/bridge.test.ts`).
- Files tested under bare bun MUST NOT import `'tldraw'` or runtime `'livekit-client'` (the tldraw module graph hangs bun on exit — see `src/av/bridge.ts` header). Type-only livekit imports are fine.
- Tabs for indentation, single quotes, no semicolons — match the surrounding files.
- Typecheck gate: `bun run typecheck` from the **repo root** (`cd ..` first or use the root path).

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/av/spatial.ts` | Modify | Add `gainForScreenDistance` + `ScreenSpatialSettings` (pure) |
| `src/av/spatial.test.ts` | Modify | Screen-space gain tests |
| `src/av/legibility.ts` | Create | Pure gain→visual mappings: `tileOpacityForGain`, `cursorAlphaForGain`, `quantizeGain` |
| `src/av/legibility.test.ts` | Create | Tests for the above |
| `src/av/bridge.ts` | Modify | Per-peer gain store (publish/subscribe, change-detecting) |
| `src/av/bridge.test.ts` | Modify | Gain-store tests |
| `src/av/useSpatialGainLoop.ts` | Modify | Screen-space distance input; publish applied gains |
| `src/av/FadedCursorOverlay.ts` | Create | `CollaboratorCursorOverlayUtil` subclass that fades cursors by gain |
| `src/av/zone.tsx` | Create | `AudibleZoneOverlay` — the on-canvas huddle ring |
| `src/av/AvOverlay.tsx` | Modify | Mount zone overlay; clear gains on unmount |
| `src/chrome/PanelTile.tsx` | Modify | Tile dim, quiet glyph, hover % readout |
| `src/App.tsx` | Modify | Pass `overlayUtils` to `<Tldraw>` |

---

### Task 1: Screen-space gain function (`spatial.ts`)

**Files:**
- Modify: `client/src/av/spatial.ts`
- Test: `client/src/av/spatial.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `client/src/av/spatial.test.ts` (before the final `console.log`):

```ts
// --- screen-space (viewport-relative) gain ------------------------------

import { DEFAULT_SCREEN_SPATIAL_SETTINGS, gainForScreenDistance } from './spatial'

const ss = DEFAULT_SCREEN_SPATIAL_SETTINGS // huddleFraction 0.45, falloffFraction 1.6, floor 0.04
// A 1600×1200 viewport: halfDiagonal = 1000 px → huddle 450 px, falloff end 1600 px.
const halfDiag = 1000

expectClose(
	'zero page distance is full volume at any zoom',
	gainForScreenDistance(0, 0.1, halfDiag, ss),
	1
)
expectClose(
	'inside huddle at zoom 1 (400px screen) is full volume',
	gainForScreenDistance(400, 1, halfDiag, ss),
	1
)
expectClose(
	'beyond falloff end at zoom 1 (2000px screen) is the floor',
	gainForScreenDistance(2000, 1, halfDiag, ss),
	0.04
)

// Zoom is reach: the SAME page distance is louder when zoomed out.
{
	const zoomedIn = gainForScreenDistance(1200, 2, halfDiag, ss) // 2400px screen
	const zoomedOut = gainForScreenDistance(1200, 0.2, halfDiag, ss) // 240px screen
	if (!(zoomedOut > zoomedIn)) {
		throw new Error(`zooming out must raise gain: out=${zoomedOut} in=${zoomedIn}`)
	}
	expectClose('fully zoomed out pulls a far peer into the huddle', zoomedOut, 1)
	console.log('PASS: zoom is reach (same page distance, higher gain when zoomed out)')
}

// Equivalence with the page-space curve: screen settings are just
// gainForDistance with pixel radii derived from the half-diagonal.
expectClose(
	'screen-space midpoint matches gainForDistance with derived radii',
	gainForScreenDistance(1025, 1, halfDiag, ss),
	gainForDistance(1025, { huddleRadius: 450, falloffEnd: 1600, floor: 0.04 })
)

// Guards: non-finite inputs and a degenerate viewport fall back to the floor.
expectClose('NaN page distance → floor', gainForScreenDistance(NaN, 1, halfDiag, ss), 0.04)
expectClose('NaN zoom → floor', gainForScreenDistance(100, NaN, halfDiag, ss), 0.04)
expectClose('zero half-diagonal → floor', gainForScreenDistance(100, 1, 0, ss), 0.04)
```

Note: the `import` lines in this codebase's test files sit at the top — move the added `import` up to join the existing one:

```ts
import {
	DEFAULT_SCREEN_SPATIAL_SETTINGS,
	DEFAULT_SPATIAL_SETTINGS,
	distance,
	gainForDistance,
	gainForScreenDistance,
} from './spatial'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun src/av/spatial.test.ts`
Expected: FAIL — `SyntaxError`/export not found for `DEFAULT_SCREEN_SPATIAL_SETTINGS` / `gainForScreenDistance`.

- [ ] **Step 3: Implement**

Append to `client/src/av/spatial.ts`:

```ts
/**
 * Viewport-relative (screen-space) settings: the same falloff curve, but the
 * radii are FRACTIONS of the viewport's half-diagonal in screen pixels, so
 * the model is resolution-independent and zoom becomes reach — zooming in
 * stretches page distances in screen pixels (peers outside your focus fade);
 * zooming out shrinks them (at full zoom-out the whole page is a huddle).
 */
export interface ScreenSpatialSettings {
	/** Fraction of the viewport half-diagonal within which a voice is full volume. */
	huddleFraction: number
	/** Fraction of the half-diagonal at which the falloff bottoms out. >1 so
	 * drifting just off-screen makes a peer quieter, never a hard cliff. */
	falloffFraction: number
	/** Minimum gain — teammates never fully disappear. */
	floor: number
}

export const DEFAULT_SCREEN_SPATIAL_SETTINGS: ScreenSpatialSettings = {
	huddleFraction: 0.45,
	falloffFraction: 1.6,
	floor: 0.04,
}

/**
 * The screen-space gain: convert a page-space distance to screen pixels
 * (× zoom), derive pixel radii from the viewport half-diagonal, and reuse the
 * existing curve. Non-finite inputs or a degenerate viewport → floor,
 * mirroring gainForDistance's own finite guard.
 */
export function gainForScreenDistance(
	pageDistance: number,
	zoom: number,
	viewportHalfDiagonalPx: number,
	settings: ScreenSpatialSettings
): number {
	const { huddleFraction, falloffFraction, floor } = settings
	if (
		!Number.isFinite(pageDistance) ||
		!Number.isFinite(zoom) ||
		!Number.isFinite(viewportHalfDiagonalPx) ||
		viewportHalfDiagonalPx <= 0
	) {
		return floor
	}
	return gainForDistance(pageDistance * zoom, {
		huddleRadius: huddleFraction * viewportHalfDiagonalPx,
		falloffEnd: falloffFraction * viewportHalfDiagonalPx,
		floor,
	})
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun src/av/spatial.test.ts`
Expected: PASS lines for every assertion, ending `ALL SPATIAL AUDIO TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/av/spatial.ts src/av/spatial.test.ts
git commit -m "feat(av): screen-space viewport-relative spatial gain"
```

---

### Task 2: Pure legibility helpers (`legibility.ts`)

**Files:**
- Create: `client/src/av/legibility.ts`
- Test: `client/src/av/legibility.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/src/av/legibility.test.ts`:

```ts
/**
 * Pure gain→visual mappings for the spatial-audio legibility layer.
 * Run with: bun src/av/legibility.test.ts
 */
import assert from 'node:assert/strict'
import {
	GAIN_QUANTUM,
	QUIET_GAIN_THRESHOLD,
	TILE_OPACITY_FLOOR,
	cursorAlphaForGain,
	quantizeGain,
	tileOpacityForGain,
} from './legibility'

// --- tileOpacityForGain: linear from the floor to 1, clamped, finite-guarded ---
assert.equal(tileOpacityForGain(1), 1)
assert.equal(tileOpacityForGain(0), TILE_OPACITY_FLOOR)
assert.equal(tileOpacityForGain(0.5), TILE_OPACITY_FLOOR + (1 - TILE_OPACITY_FLOOR) * 0.5)
assert.equal(tileOpacityForGain(2), 1, 'gain above 1 clamps to full opacity')
assert.equal(tileOpacityForGain(-1), TILE_OPACITY_FLOOR, 'negative gain clamps to floor')
assert.equal(tileOpacityForGain(NaN), 1, 'non-finite gain shows full (fail visible, not dark)')
assert.ok(TILE_OPACITY_FLOOR >= 0.3, 'quiet tiles stay clearly visible')

// --- cursorAlphaForGain: same shape, its own floor ---
assert.equal(cursorAlphaForGain(1), 1)
assert.ok(cursorAlphaForGain(0) > 0, 'a silent peer’s cursor never fully vanishes')
assert.ok(cursorAlphaForGain(0.2) < cursorAlphaForGain(0.8), 'alpha rises with gain')
assert.equal(cursorAlphaForGain(NaN), 1)

// --- quantizeGain: snaps to GAIN_QUANTUM steps so the store only publishes real changes ---
assert.equal(quantizeGain(0), 0)
assert.equal(quantizeGain(1), 1)
assert.equal(quantizeGain(0.5), 0.5)
assert.equal(quantizeGain(0.512), 0.5, 'sub-quantum jitter snaps down')
assert.equal(quantizeGain(0.537), 0.55, 'rounds to the nearest step')
assert.equal(quantizeGain(1.7), 1, 'clamps above')
assert.equal(quantizeGain(-0.2), 0, 'clamps below')
assert.equal(quantizeGain(NaN), 1, 'non-finite → 1 (matches the loop’s no-cursor default)')
assert.ok(GAIN_QUANTUM > 0 && GAIN_QUANTUM <= 0.1)

// --- QUIET_GAIN_THRESHOLD: the “show the quiet glyph” cutoff sits between floor and half ---
assert.ok(QUIET_GAIN_THRESHOLD > 0.04 && QUIET_GAIN_THRESHOLD < 0.5)

console.log('legibility.test.ts: all assertions passed')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun src/av/legibility.test.ts`
Expected: FAIL — cannot resolve `./legibility`.

- [ ] **Step 3: Implement**

Create `client/src/av/legibility.ts`:

```ts
/**
 * Pure gain→visual mappings for the spatial-audio legibility layer: every
 * surface that shows a teammate also shows how audible they are, driven by
 * the SAME applied per-peer gain the audio loop publishes (av/bridge.ts) —
 * never a parallel computation, so what you see always matches what you hear.
 *
 * Pure — no tldraw / livekit imports — so it's unit-tested under bare bun
 * exactly like spatial.ts and crosstalk.ts.
 */

/** Video tiles never dim below this: a quiet teammate looks distant, not gone. */
export const TILE_OPACITY_FLOOR = 0.35

/** Canvas cursors never fade below this alpha. */
export const CURSOR_ALPHA_FLOOR = 0.3

/** At or below this gain a tile also gets a non-opacity "quiet" cue, so the
 * state is legible to users who can't perceive the dimming. */
export const QUIET_GAIN_THRESHOLD = 0.25

/** Gains are snapped to this step before publishing, so the bridge store only
 * notifies (and React only re-renders) on humanly-visible changes. The audio
 * GainNode gets the raw target; only the visual copy is quantised. */
export const GAIN_QUANTUM = 0.05

function clamp01(value: number): number {
	if (value < 0) return 0
	if (value > 1) return 1
	return value
}

/** Tile opacity for an applied gain (0..1). Non-finite → 1: fail visible. */
export function tileOpacityForGain(gain: number): number {
	if (!Number.isFinite(gain)) return 1
	return TILE_OPACITY_FLOOR + (1 - TILE_OPACITY_FLOOR) * clamp01(gain)
}

/** Cursor alpha for an applied gain (0..1). Non-finite → 1: fail visible. */
export function cursorAlphaForGain(gain: number): number {
	if (!Number.isFinite(gain)) return 1
	return CURSOR_ALPHA_FLOOR + (1 - CURSOR_ALPHA_FLOOR) * clamp01(gain)
}

/** Snap a gain to GAIN_QUANTUM steps, clamped to [0,1]. Non-finite → 1,
 * matching the loop's "peer with no cursor yet counts as full volume". */
export function quantizeGain(gain: number): number {
	if (!Number.isFinite(gain)) return 1
	return Math.round(clamp01(gain) / GAIN_QUANTUM) * GAIN_QUANTUM
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun src/av/legibility.test.ts`
Expected: `legibility.test.ts: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add src/av/legibility.ts src/av/legibility.test.ts
git commit -m "feat(av): pure gain→visual legibility helpers"
```

---

### Task 3: Per-peer gain store in the bridge

**Files:**
- Modify: `client/src/av/bridge.ts`
- Test: `client/src/av/bridge.test.ts`

The gain loop is a 150 ms interval, not a React render, so gains do NOT ride the `AvPanelSnapshot` (that would re-render the whole panel per tick). They get their own tiny store in `bridge.ts`, same pattern as the hovered-face store. The **publisher is the dedupe gate**: `publishPeerGains` compares against the current map and skips notify when nothing changed (callers pass pre-quantised values).

- [ ] **Step 1: Write the failing tests**

Append to `client/src/av/bridge.test.ts` (before the final `console.log`), and add the new imports to the existing `import { … } from './bridge'` block: `getPeerGains`, `publishPeerGains`, `subscribePeerGains`.

```ts
// --- per-peer gain store: publish/subscribe with change detection ---
{
	assert.deepEqual(getPeerGains(), {}, 'gain store starts empty')

	let calls = 0
	const unsubscribe = subscribePeerGains(() => {
		calls += 1
	})

	publishPeerGains({ u1: 0.5, u2: 1 })
	assert.equal(calls, 1, 'first publish notifies')
	assert.deepEqual(getPeerGains(), { u1: 0.5, u2: 1 })

	// Identical content (fresh object) → publisher dedupes, no notify.
	publishPeerGains({ u1: 0.5, u2: 1 })
	assert.equal(calls, 1, 'identical gains must not notify')
	// The stored map keeps its identity when deduped, so useSyncExternalStore
	// consumers don't re-render.
	const before = getPeerGains()
	publishPeerGains({ u2: 1, u1: 0.5 }) // key order must not matter
	assert.equal(getPeerGains(), before, 'deduped publish keeps map identity')

	publishPeerGains({ u1: 0.55, u2: 1 })
	assert.equal(calls, 2, 'a changed value notifies')

	publishPeerGains({ u1: 0.55 })
	assert.equal(calls, 3, 'a removed peer notifies')

	publishPeerGains({})
	assert.equal(calls, 4, 'clearing notifies')

	unsubscribe()
	publishPeerGains({ u9: 1 })
	assert.equal(calls, 4, 'unsubscribed listener is not notified')
	publishPeerGains({}) // reset for any later blocks
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun src/av/bridge.test.ts`
Expected: FAIL — `getPeerGains` is not exported.

- [ ] **Step 3: Implement**

Append to `client/src/av/bridge.ts` (after the hovered-face section):

```ts
// --- Per-peer applied gains ----------------------------------------------
// Published by the spatial gain loop each tick (values pre-quantised via
// legibility.ts's quantizeGain), keyed by RAW user id. This is the single
// source of truth the legibility cues read (tile dim, cursor fade, % readout)
// — the exact numbers the audio is applying, so seen and heard can't drift.
// The PUBLISHER dedupes: identical content skips notify and keeps the map's
// identity, so useSyncExternalStore consumers don't re-render on quiet ticks.

let peerGains: Record<string, number> = {}
const gainListeners = new Set<() => void>()

function gainsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
	const aKeys = Object.keys(a)
	if (aKeys.length !== Object.keys(b).length) return false
	for (const key of aKeys) {
		if (a[key] !== b[key]) return false
	}
	return true
}

/** Publish the tick's applied gains; no-op (identity-preserving) when unchanged. */
export function publishPeerGains(gains: Record<string, number>): void {
	if (gainsEqual(peerGains, gains)) return
	peerGains = gains
	for (const listener of gainListeners) listener()
}

/** The last published gain map, non-reactively (empty before first publish). */
export function getPeerGains(): Record<string, number> {
	return peerGains
}

/** Plain (non-React) subscribe seam — the base usePeerGain builds on. */
export function subscribePeerGains(listener: () => void): () => void {
	gainListeners.add(listener)
	return () => gainListeners.delete(listener)
}

/** Reactive read of one peer's applied gain. Defaults to 1 (full volume /
 * full brightness) until the loop's first publish, matching the loop's own
 * "no cursor yet counts as full volume" default. */
export function usePeerGain(id: string): number {
	return useSyncExternalStore(subscribePeerGains, () => peerGains[id] ?? 1)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun src/av/bridge.test.ts`
Expected: `bridge.test.ts: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add src/av/bridge.ts src/av/bridge.test.ts
git commit -m "feat(av): per-peer applied-gain store on the bridge"
```

---

### Task 4: Wire the loop — screen-space input, publish applied gains

**Files:**
- Modify: `client/src/av/useSpatialGainLoop.ts`

No bare-bun test (this file imports tldraw); the pure pieces it calls were tested in Tasks 1–3. Gate is typecheck.

- [ ] **Step 1: Rewrite `useSpatialGainLoop.ts`**

Replace the file's contents with:

```ts
/**
 * The spatial audio loop: every 150 ms, set each peer's GainNode from where
 * they are relative to me. On my page, volume falls off with SCREEN-SPACE
 * distance between my viewport centre and their cursor — page distance × my
 * zoom, against radii derived from my viewport's half-diagonal (spatial.ts's
 * gainForScreenDistance). Zoom is reach: zoom into a corner and peers outside
 * your focus fade; zoom all the way out and the whole page is a huddle.
 * Standup mode still pins everyone on my page to full. A peer on ANOTHER page
 * is held at the crosstalk bleed level (av/crosstalk.ts) — 0 fades them to
 * silence as before. A peer absent from presence entirely fades to 0.
 *
 * Crucially this drives the SAME single GainNode per participant either way,
 * so cross-page bleed is the exact same audio path as in-room voice — one
 * gain, no echo, no doubled voice. The 0.08 s setTargetAtTime constant is the
 * smoothing that keeps pans (and crossing a page boundary) from clicking.
 *
 * Each tick also publishes the APPLIED per-peer gains (quantised) through
 * av/bridge.ts — the single source of truth the legibility cues read (tile
 * dim, cursor fade, hover % readout), so what you see matches what you hear.
 */
import { rawUserId } from '@ensembleworks/contracts'
import type { Editor } from 'tldraw'
import { useEvery } from '../kernel/useEvery'
import { publishPeerGains } from './bridge'
import { gainTarget, type PeerLocation } from './crosstalk'
import { quantizeGain } from './legibility'
import { DEFAULT_SCREEN_SPATIAL_SETTINGS, distance, gainForScreenDistance } from './spatial'
import type { LiveKitState } from './useLiveKitRoom'

export function useSpatialGainLoop(
	editor: Editor,
	lk: LiveKitState,
	standupMode: boolean,
	crosstalkLevel: number
): void {
	useEvery(150, () => {
		const ctx = lk.audioContext
		if (!ctx) return
		const my = editor.getViewportPageBounds().center
		const myPageId = editor.getCurrentPageId()
		// Read the camera once per tick, not per peer.
		const zoom = editor.getZoomLevel()
		const screen = editor.getViewportScreenBounds()
		const halfDiagonalPx = Math.hypot(screen.w, screen.h) / 2
		// Scan collaborators on ALL pages, not just the current one: an off-page
		// teammate must still be found so crosstalk can bleed them in, instead of
		// the loop treating "off my page" as "gone" and hard-muting them.
		// (getCollaboratorsOnCurrentPage() is exactly this list filtered to
		// currentPageId, so on-page peers behave identically to before.)
		const collaborators = editor.getCollaborators()
		const appliedGains: Record<string, number> = {}
		for (const peer of lk.peers) {
			if (!peer.gain) continue
			const presence = collaborators.find((c) => rawUserId(c.userId) === rawUserId(peer.identity))
			const location: PeerLocation = !presence
				? 'absent'
				: presence.currentPageId === myPageId
					? 'my-page'
					: 'other-page'
			// In-page distance gain — the screen-space spatial model. A peer on my
			// page with no cursor yet counts as full volume, exactly as before.
			const pageGain = presence?.cursor
				? gainForScreenDistance(
						distance(my.x, my.y, presence.cursor.x, presence.cursor.y),
						zoom,
						halfDiagonalPx,
						DEFAULT_SCREEN_SPATIAL_SETTINGS
					)
				: 1
			const target = gainTarget({ location, standupMode, pageGain, crosstalk: crosstalkLevel })
			peer.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08)
			appliedGains[rawUserId(peer.identity)] = quantizeGain(target)
		}
		// publishPeerGains dedupes internally, so quiet ticks cost one map compare.
		publishPeerGains(appliedGains)
	})
}
```

- [ ] **Step 2: Typecheck**

Run: `cd .. && bun run typecheck && cd client`
Expected: PASS (no errors).

- [ ] **Step 3: Run all bare-bun av tests (regression)**

Run: `bun src/av/spatial.test.ts && bun src/av/crosstalk.test.ts && bun src/av/bridge.test.ts && bun src/av/legibility.test.ts`
Expected: each prints its ALL-PASSED line.

- [ ] **Step 4: Commit**

```bash
git add src/av/useSpatialGainLoop.ts
git commit -m "feat(av): drive spatial gain from screen-space distance; publish applied gains"
```

---

### Task 5: Video tile dims + quiet glyph + hover % readout

**Files:**
- Modify: `client/src/chrome/PanelTile.tsx`

The dim applies to the **media area only** (video/avatar/initials), never the control strip — the name and buttons stay fully legible. Local tile never dims (your own gain is always 1 to you).

- [ ] **Step 1: Add imports and the reduced-motion constant**

In `client/src/chrome/PanelTile.tsx`, extend the bridge import (line 18) and add the legibility import after it:

```ts
import {
	getHoveredFace,
	registerFaceEl,
	setHoveredFace,
	usePeerGain,
	type AvPanelSnapshot,
} from '../av/bridge'
import { QUIET_GAIN_THRESHOLD, tileOpacityForGain } from '../av/legibility'
```

Below the `INITIALS_FONT_TWO_UP` constant, add:

```ts
// Visual cues ease on roughly the audio ramp's time constant (the loop's
// 0.08 s setTargetAtTime), so eyes and ears agree. Module-level read is fine:
// a changed OS preference applies on next page load.
const REDUCED_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const DIM_TRANSITION = REDUCED_MOTION ? undefined : 'opacity 150ms linear'
```

- [ ] **Step 2: Read the gain inside `PanelTile`**

After the `const avAvailable = …` line (line 97), add:

```ts
	// Applied spatial gain for this peer (bridge store, published by the gain
	// loop). Local tile: you always hear yourself at "full" — never dimmed.
	const peerGain = usePeerGain(rawId)
	const gain = isLocal ? 1 : peerGain
	const quiet = !isLocal && gain <= QUIET_GAIN_THRESHOLD
```

(Call `usePeerGain` unconditionally — hooks can't be inside a conditional — then override for local.)

- [ ] **Step 3: Dim the media area and add the quiet glyph + readout**

Change the media-area `<div>`'s style (the one with `aspectRatio: MEDIA_ASPECT`) to add opacity and transition:

```ts
				<div
					style={{
						position: 'relative',
						width: '100%',
						aspectRatio: MEDIA_ASPECT,
						overflow: 'hidden',
						background: `${color}22`,
						opacity: tileOpacityForGain(gain),
						transition: DIM_TRANSITION,
					}}
				>
```

Inside that div, after the existing remote cam-status glyph block (`{!isLocal && ( … <AvIcon kind="camera" … /> … )}`), add the quiet glyph and the hover readout:

```tsx
					{quiet && (
						// Non-opacity "quiet" cue (a11y: legible without perceiving the
						// dim): same glyph style as the cam-status badge, bottom-left.
						<span
							title={`Quiet — far from your view (${Math.round(gain * 100)}%)`}
							data-testid={'ew-tile-quiet-' + rawId}
							style={{
								position: 'absolute',
								bottom: 4,
								left: 4,
								width: 22,
								height: 22,
								display: 'grid',
								placeItems: 'center',
								pointerEvents: 'none',
								borderRadius: 3,
								background: 'rgba(15,23,42,0.45)',
								color: wm.inkMuted,
							}}
						>
							<AvIcon kind="spatial" crossedOut />
						</span>
					)}

					{!isLocal && hovered && (
						// On-demand exact volume readout (legibility cue #4).
						<span
							data-testid={'ew-tile-volume-' + rawId}
							style={{
								position: 'absolute',
								bottom: 4,
								right: 4,
								pointerEvents: 'none',
								borderRadius: 3,
								padding: '1px 4px',
								background: 'rgba(15,23,42,0.55)',
								color: wm.cream,
								fontFamily: wm.mono,
								fontSize: 10,
							}}
						>
							vol {Math.round(gain * 100)}%
						</span>
					)}
```

Note the quiet glyph sits INSIDE the dimmed media div — that's fine (a dimmed badge on a dimmed tile still reads), but the hover readout must stay crisp: both are inside the media area for positioning; opacity 0.35 keeps them readable against the dark scrim backgrounds. No change needed.

- [ ] **Step 4: Typecheck**

Run: `cd .. && bun run typecheck && cd client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chrome/PanelTile.tsx
git commit -m "feat(chrome): video tiles dim with applied spatial gain (+quiet glyph, hover readout)"
```

---

### Task 6: Cursor fade — `CollaboratorCursorOverlayUtil` subclass

**Files:**
- Create: `client/src/av/FadedCursorOverlay.ts`
- Modify: `client/src/App.tsx`

tldraw draws collaborator cursors on a canvas via `CollaboratorCursorOverlayUtil` (exported from `'tldraw'`, replaceable through the `<Tldraw overlayUtils>` prop — `mergeArraysAndReplaceDefaults('type', …)` swaps the default for any util with the same static `type`). The subclass multiplies `ctx.globalAlpha` per cursor by the peer's applied gain, read non-reactively from the bridge (the overlay repaints on every cursor/camera change — exactly the events that change gains).

- [ ] **Step 1: Create `client/src/av/FadedCursorOverlay.ts`**

```ts
/**
 * Collaborator cursors fade with their applied spatial gain (legibility cue
 * #2): the cause (distance from my viewport) and the effect (volume) are
 * shown in the same place. Subclasses tldraw's canvas cursor overlay and
 * multiplies per-cursor alpha by the bridge's applied gain — the same number
 * driving the peer's GainNode, so a faint cursor IS a quiet voice.
 *
 * Same static `type`, so passing this via <Tldraw overlayUtils> REPLACES the
 * default cursor overlay (mergeArraysAndReplaceDefaults keys on `type`).
 * Gains are read non-reactively: the overlay already repaints on cursor and
 * camera changes, which are the events that change gains. (A standup-mode
 * toggle shows on the next repaint — any pointer/camera motion.)
 */
import { rawUserId } from '@ensembleworks/contracts'
import { CollaboratorCursorOverlayUtil } from 'tldraw'
import { getPeerGains } from './bridge'
import { cursorAlphaForGain } from './legibility'

const ID_PREFIX = 'collaborator_cursor:'

export class FadedCollaboratorCursorOverlayUtil extends CollaboratorCursorOverlayUtil {
	override render(
		ctx: Parameters<CollaboratorCursorOverlayUtil['render']>[0],
		overlays: Parameters<CollaboratorCursorOverlayUtil['render']>[1]
	): void {
		const gains = getPeerGains()
		for (const overlay of overlays) {
			const userId = overlay.id.startsWith(ID_PREFIX) ? overlay.id.slice(ID_PREFIX.length) : ''
			const gain = gains[rawUserId(userId)] ?? 1
			ctx.save()
			ctx.globalAlpha *= cursorAlphaForGain(gain)
			super.render(ctx, [overlay])
			ctx.restore()
		}
	}
}

/** Stable module-level array so <Tldraw overlayUtils> deps don't churn. */
export const avOverlayUtils = [FadedCollaboratorCursorOverlayUtil]
```

If typecheck complains about the `Parameters<…>` types (the base class may type `render(ctx: CanvasRenderingContext2D, overlays: TLCollaboratorCursorOverlay[])`), import and use the concrete types instead:

```ts
import { CollaboratorCursorOverlayUtil, type TLCollaboratorCursorOverlay } from 'tldraw'
// …
override render(ctx: CanvasRenderingContext2D, overlays: TLCollaboratorCursorOverlay[]): void {
```

- [ ] **Step 2: Wire into `App.tsx`**

In `client/src/App.tsx`, add the import alongside the other av imports:

```ts
import { avOverlayUtils } from './av/FadedCursorOverlay'
```

and add the prop to the `<Tldraw>` element (currently at App.tsx:202-210):

```tsx
				<Tldraw
					store={store}
					onMount={handleMount}
					deepLinks
					assetUrls={assetUrls}
					shapeUtils={customShapeUtils}
					overlayUtils={avOverlayUtils}
					overrides={uiOverrides}
					components={components}
				>
```

- [ ] **Step 3: Typecheck**

Run: `cd .. && bun run typecheck && cd client`
Expected: PASS. If `CollaboratorCursorOverlayUtil` or the overlay type isn't exported under those names, check `node_modules/tldraw/dist-cjs/index.d.ts` (grep `CollaboratorCursorOverlayUtil`) and adjust the import — do not silently drop the feature.

- [ ] **Step 4: Commit**

```bash
git add src/av/FadedCursorOverlay.ts src/App.tsx
git commit -m "feat(av): collaborator cursors fade with applied spatial gain"
```

---

### Task 7: Audible-zone ring overlay

**Files:**
- Create: `client/src/av/zone.tsx`
- Modify: `client/src/av/AvOverlay.tsx`

A fixed screen-space dashed circle at the huddle radius (0.45 × half-diagonal), centred on the viewport centre — the "your voice is full-volume inside this" hint. It's constant on screen; the zoom-to-reach teaching comes from canvas content flowing under it as you zoom. Shown only when proximity audio is actually shaping volumes: connected, NOT standup mode, and at least one human peer. Same fixed-SVG pattern as `LeashOverlay`.

- [ ] **Step 1: Create `client/src/av/zone.tsx`**

```tsx
/**
 * The "audible zone" ring (legibility cue #3): a faint dashed circle at the
 * huddle radius — teammates whose cursors are inside it are at full volume.
 * Screen-space and therefore constant on screen (the radius is a fraction of
 * the viewport half-diagonal, spatial.ts); zooming changes which CONTENT sits
 * inside it, which is what teaches zoom-to-reach. Hidden in standup mode
 * (volumes are pinned, the ring would lie) and when there's no one to hear.
 * Non-interactive; sits above the canvas like LeashOverlay.
 */
import { useValue, type Editor } from 'tldraw'
import { wm } from '../theme'
import { DEFAULT_SCREEN_SPATIAL_SETTINGS } from './spatial'

export function AudibleZoneOverlay({ editor, show }: { editor: Editor; show: boolean }) {
	const geo = useValue(
		'audible-zone',
		() => {
			const screen = editor.getViewportScreenBounds()
			const halfDiagonalPx = Math.hypot(screen.w, screen.h) / 2
			return {
				cx: screen.midX,
				cy: screen.midY,
				r: DEFAULT_SCREEN_SPATIAL_SETTINGS.huddleFraction * halfDiagonalPx,
			}
		},
		[editor]
	)
	if (!show) return null
	return (
		<svg
			data-testid="ew-audible-zone"
			style={{
				position: 'fixed',
				inset: 0,
				width: '100%',
				height: '100%',
				pointerEvents: 'none',
				zIndex: 998, // just under the leashes (999)
			}}
		>
			<circle
				cx={geo.cx}
				cy={geo.cy}
				r={geo.r}
				fill="none"
				stroke={wm.sealBlue}
				strokeWidth={1.5}
				strokeDasharray="6 8"
				opacity={0.35}
			/>
		</svg>
	)
}
```

- [ ] **Step 2: Mount it from `AvOverlay.tsx`**

In `client/src/av/AvOverlay.tsx`:

Add the imports:

```ts
import { publishPeerGains } from './bridge' // extend the existing ./bridge import list
import { AudibleZoneOverlay } from './zone'
```

(`publishPeerGains` joins the existing `import { avSnapshotsEqual, getAvSnapshot, getFaceEl, publishAvSnapshot, useHoveredFace, type AvPanelSnapshot } from './bridge'` line.)

Change the mount-only cleanup effect (currently `return () => publishAvSnapshot(null)`) to also clear gains so tiles/cursors don't hold stale dims after an A/V teardown:

```ts
	useEffect(() => {
		return () => {
			publishAvSnapshot(null)
			publishPeerGains({})
		}
	}, [])
```

Replace the return statement:

```tsx
	// The zone ring only when proximity audio is shaping volumes: connected,
	// not standup-pinned, and there's at least one human (non-scribe) peer.
	const showZone =
		lk.status === 'connected' && !standupMode && lk.peers.some((peer) => !peer.readOnly)

	return (
		<>
			<AudibleZoneOverlay editor={editor} show={showZone} />
			<LeashOverlay leashes={leashes} />
		</>
	)
```

Check the actual connected status string: grep `status` values in `client/src/av/useLiveKitRoom.ts` (`grep -n "status" src/av/useLiveKitRoom.ts`) and use its literal for "connected". If statuses are e.g. `'connected' | 'connecting' | 'disabled' | 'error'`, the check above stands.

- [ ] **Step 3: Typecheck**

Run: `cd .. && bun run typecheck && cd client`
Expected: PASS. (If `Box` lacks `midX`/`midY` in this tldraw build, use `screen.x + screen.w / 2` and `screen.y + screen.h / 2`.)

- [ ] **Step 4: Commit**

```bash
git add src/av/zone.tsx src/av/AvOverlay.tsx
git commit -m "feat(av): audible-zone ring overlay"
```

---

### Task 8: Full gates + manual verification

- [ ] **Step 1: All bare-bun av tests**

Run from `client/`:
`bun src/av/spatial.test.ts && bun src/av/crosstalk.test.ts && bun src/av/bridge.test.ts && bun src/av/legibility.test.ts && bun src/av/reconnect.test.ts && bun src/av/connectionLog.test.ts`
Expected: every file prints its ALL-PASSED line.

- [ ] **Step 2: Typecheck + build (repo root)**

Run: `cd .. && bun install && bun run typecheck && bun run build`
Expected: all three workspaces pass.

- [ ] **Step 3: Manual smoke (two browser sessions on the dev stack)**

Start the stack if not running (from the HOST repo root): `bin/dev up`, client at `:5173` (or Caddy `:8080`). Open two browser sessions as different users on the same page, both with mic+cam, and in the crosstalk popover UNTICK nothing — turn ON "Proximity audio on this page" (i.e. standup mode off) in the listening session. Verify:

1. **Zoom is reach:** zoom session A into an empty corner far from B's cursor → B's voice fades, B's tile dims (but stays visible, ≥35%), B's canvas cursor fades. Zoom all the way out → B returns to full volume, tile brightens, cursor solidifies.
2. **Never bright-but-silent:** at any zoom/pan position, if B is inaudible, B's tile must be visibly dimmed with the quiet glyph showing.
3. **Zone ring:** the dashed ring appears (proximity on, peer present), disappears in standup mode, and content flows through it while zooming.
4. **Hover readout:** hovering B's tile shows `vol N%` matching what you hear.
5. **Crosstalk unchanged:** move B to another page → B silent (crosstalk 0), tile dims to floor with quiet glyph; raise crosstalk slider → B audible at the bleed level and the tile brightens to match.
6. **Standup mode:** toggle proximity off → everyone full volume, all tiles full brightness, ring hidden.

- [ ] **Step 4: Commit any fixes; done**

If manual testing surfaced tuning changes (radii fractions, opacity floor), change the constants (`DEFAULT_SCREEN_SPATIAL_SETTINGS` in `spatial.ts`, `TILE_OPACITY_FLOOR` in `legibility.ts`), re-run the affected bare-bun test, and commit:

```bash
git add -A && git commit -m "feat(av): tune viewport spatial-audio constants after feel-test"
```

---

## Self-review notes

- **Spec coverage:** gain model → Tasks 1+4; composition with crosstalk → Task 4 (gainTarget untouched); tile dim + quiet a11y cue → Task 5; cursor fade → Task 6; zone ring → Task 7; hover % → Task 5; quantised bridge publishing → Tasks 2+3+4; reduced motion → Task 5; server impact none → no server tasks; testing strategy → per-task RED/GREEN + Task 8 gates.
- **Deviation from spec (deliberate):** gains ride a dedicated bridge store, not `AvPanelSnapshot`/`avSnapshotsEqual` — the loop isn't a React render, and a separate store means only tiles re-render on gain changes instead of the whole panel. Quantisation dedupe lives in the publisher, as the spec intends.
- **Known limitation (accepted):** cursor fade reads gains non-reactively; a standup toggle updates cursors on the next canvas repaint rather than instantly. Tiles and the ring update immediately.
