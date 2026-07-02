# Screen-Share Tiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any member can share one or more desktop windows/screens into the room as independent, aspect-true, movable tldraw tiles that stream over the existing self-hosted LiveKit SFU, with delivery scoped to each viewer's viewport.

**Architecture:** A new `client/src/screenshare/` module: a `screenshare` custom shape (cloned structurally from the neko shape) whose synced props carry `{participantId, trackName, aspect}` while the pixels are attached per-viewer from LiveKit; a module-level store bridging the LiveKit `Room` to shape components and the toolbar; a share manager that publishes named `getDisplayMedia` tracks and owns the tile lifecycle; and a 150 ms viewport loop (spatial-audio precedent) that drives `setSubscribed` per screen track. Spec: `docs/superpowers/specs/2026-07-02-screenshare-tiles-design.md`.

**Tech Stack:** tldraw 5.1 (`BaseBoxShapeUtil`, `@tldraw/sync`), livekit-client 2.19 (named track publications, simulcast, `adaptiveStream`/`dynacast`), React 19, TypeScript, `npx tsx` node-assert test scripts, Playwright probe for e2e.

## Global Constraints

- Monorepo: npm workspaces `client`, `server`, `transcriber`. Typecheck everything with `npm run typecheck` from the repo root (client-only: `npm run typecheck --workspace=client`).
- Tests are dependency-free `node:assert/strict` scripts run with `npx tsx <file>` from the `client/` directory (see `client/src/av/spatial.test.ts`, `client/src/neko/neko.test.ts`). There is no test framework — do not add one.
- Code style: tabs, single quotes, no semicolons, explanatory block comments that state constraints (match `NekoShapeUtil.tsx`).
- Custom shapes MUST be registered in BOTH `client/src/App.tsx` (`customShapeUtils`) and `server/src/schema.ts` (props validators) — missing the server entry breaks sync validation for every client in the room.
- Never use `setScreenShareEnabled()` or LiveKit's source-keyed single-screen-share getter. Tracks are published with `publishTrack` under names `screen:<uuid>` and routed by name.
- Do not touch the audio path: `autoSubscribe` stays default (true), the WebAudio spatial pipeline in `useLiveKitRoom.ts`/`AvOverlay.tsx` keeps working unchanged.
- The shape header band is exactly 28 px (`SCREENSHARE_HEADER_HEIGHT`), matching the neko shape's header.
- Aspect convention: `aspect = captured width / captured height` (e.g. 16/9 ≈ 1.78). Video area height = `w / aspect`; total shape height = video area + header.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Viewport visibility geometry (`visibility.ts`)

**Files:**
- Create: `client/src/screenshare/visibility.ts`
- Test: `client/src/screenshare/visibility.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, zero imports).
- Produces:
  - `interface Rect { x: number; y: number; w: number; h: number }`
  - `interface VisibilitySettings { subscribeMargin: number; unsubscribeMargin: number }`
  - `const DEFAULT_VISIBILITY_SETTINGS: VisibilitySettings`
  - `function shouldBeSubscribed(shape: Rect | null, viewport: Rect, subscribed: boolean, settings?: VisibilitySettings): boolean`
  - Task 7's viewport loop calls `shouldBeSubscribed` with tldraw `Box` values (structurally `Rect`).

- [ ] **Step 1: Write the failing test**

Create `client/src/screenshare/visibility.test.ts`:

```ts
/**
 * Viewport-vs-tile subscription geometry. Run: npx tsx src/screenshare/visibility.test.ts
 */
import assert from 'node:assert/strict'
import { DEFAULT_VISIBILITY_SETTINGS, shouldBeSubscribed } from './visibility'

const vp = { x: 0, y: 0, w: 1000, h: 800 }
const s = DEFAULT_VISIBILITY_SETTINGS

// Margins must form a hysteresis band or the loop can flap at one boundary.
assert.ok(s.unsubscribeMargin > s.subscribeMargin)

// Tile inside the viewport → subscribe.
assert.equal(shouldBeSubscribed({ x: 100, y: 100, w: 400, h: 300 }, vp, false, s), true)

// Just past the right edge but within the subscribe margin → subscribe early,
// so the stream is already flowing as the tile pans into view.
assert.equal(shouldBeSubscribed({ x: 1100, y: 0, w: 400, h: 300 }, vp, false, s), true)

// Beyond the subscribe margin and not currently subscribed → leave it off.
assert.equal(shouldBeSubscribed({ x: 1300, y: 0, w: 400, h: 300 }, vp, false, s), false)

// Hysteresis: the SAME tile position, but already subscribed → stays on,
// because subscribed tracks only drop beyond the larger unsubscribe margin.
assert.equal(shouldBeSubscribed({ x: 1300, y: 0, w: 400, h: 300 }, vp, true, s), true)

// Far beyond the unsubscribe margin → dropped even when subscribed.
assert.equal(shouldBeSubscribed({ x: 2000, y: 0, w: 400, h: 300 }, vp, true, s), false)

// Above the viewport works the same way (all four edges carry the margin).
assert.equal(shouldBeSubscribed({ x: 0, y: -450, w: 400, h: 300 }, vp, false, s), true)
assert.equal(shouldBeSubscribed({ x: 0, y: -600, w: 400, h: 300 }, vp, false, s), false)

// No tile on this page for the track → never subscribed, whatever the state.
assert.equal(shouldBeSubscribed(null, vp, true, s), false)
assert.equal(shouldBeSubscribed(null, vp, false, s), false)

console.log('ALL VISIBILITY TESTS PASSED')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx tsx src/screenshare/visibility.test.ts`
Expected: FAIL — `Cannot find module './visibility'` (or ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Write the implementation**

Create `client/src/screenshare/visibility.ts`:

```ts
/**
 * Pure viewport-vs-tile geometry for screen-share subscription: decides which
 * LiveKit screen tracks a viewer should receive (the spec's "deterministic"
 * path — the stream stops at the SFU, not merely hidden client-side).
 *
 * Hysteresis: we subscribe a little BEFORE a tile enters the viewport and
 * drop it only when it is WELL outside, so panning along a tile's edge never
 * flaps the subscription. Pure + dependency-free → unit-tests in node, like
 * av/spatial.ts.
 */
export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

export interface VisibilitySettings {
	subscribeMargin: number
	unsubscribeMargin: number
}

// Margins are in page units (canvas coordinates), sized against a typical
// ~1280-wide tile: subscribe when within a fifth of a tile of the viewport,
// keep the stream until it is most of a tile away.
export const DEFAULT_VISIBILITY_SETTINGS: VisibilitySettings = {
	subscribeMargin: 200,
	unsubscribeMargin: 800,
}

function intersectsWithMargin(shape: Rect, viewport: Rect, margin: number): boolean {
	return (
		shape.x < viewport.x + viewport.w + margin &&
		shape.x + shape.w > viewport.x - margin &&
		shape.y < viewport.y + viewport.h + margin &&
		shape.y + shape.h > viewport.y - margin
	)
}

/**
 * shape is null when the track has no tile on the viewer's current page
 * (deleted, or on another tldraw page) → never subscribe.
 */
export function shouldBeSubscribed(
	shape: Rect | null,
	viewport: Rect,
	subscribed: boolean,
	settings: VisibilitySettings = DEFAULT_VISIBILITY_SETTINGS
): boolean {
	if (!shape) return false
	const margin = subscribed ? settings.unsubscribeMargin : settings.subscribeMargin
	return intersectsWithMargin(shape, viewport, margin)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx tsx src/screenshare/visibility.test.ts`
Expected: `ALL VISIBILITY TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add client/src/screenshare/visibility.ts client/src/screenshare/visibility.test.ts
git commit -m "feat(screenshare): viewport subscription geometry with hysteresis

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Shape constants + aspect helpers (`ScreenShareShapeUtil.tsx`, part 1)

The shape FILE starts life holding only constants and pure helpers (so they
test in node before any React/tldraw code exists); Task 5 appends the shape
class and component to this same file.

**Files:**
- Create: `client/src/screenshare/ScreenShareShapeUtil.tsx`
- Test: `client/src/screenshare/screenshare.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (all exported; used by Tasks 5, 6):
  - `const SCREENSHARE_HEADER_HEIGHT = 28`
  - `const SCREENSHARE_DEFAULT_W = 1280`
  - `const SCREENSHARE_ICON_NAME: string`, `const SCREENSHARE_TOOLBAR_ICON: string` (data URI)
  - `function lockScreenShareAspect(w: number, h: number, prevW: number, prevH: number, aspect: number): { w: number; h: number }`
  - `function propsForAspect(w: number, aspect: number): { h: number; aspect: number }`
  - `function titleFromTrackLabel(label: string): string`

- [ ] **Step 1: Write the failing test**

Create `client/src/screenshare/screenshare.test.ts`:

```ts
/**
 * Screen-share aspect lock + title helpers. Run: npx tsx src/screenshare/screenshare.test.ts
 */
import assert from 'node:assert/strict'
import {
	SCREENSHARE_HEADER_HEIGHT,
	lockScreenShareAspect,
	propsForAspect,
	titleFromTrackLabel,
} from './ScreenShareShapeUtil'

const HDR = SCREENSHARE_HEADER_HEIGHT
const WIDE = 16 / 9

// Width-led drag (height untouched): height follows from the aspect + header.
assert.deepEqual(lockScreenShareAspect(1600, 748, 1280, 748, WIDE), {
	w: 1600,
	h: 1600 / WIDE + HDR,
})

// Height-led drag (width untouched): width follows from the video area height.
assert.deepEqual(lockScreenShareAspect(1280, 1000, 1280, 748, WIDE), {
	w: (1000 - HDR) * WIDE,
	h: 1000,
})

// A portrait window (aspect < 1) locks taller than wide.
const portrait = lockScreenShareAspect(500, 0, 400, 800, 9 / 16)
assert.equal(portrait.h, 0)
assert.equal(portrait.w, (0 - HDR) * (9 / 16)) // formula check only; min sizes clamp in onResize

// propsForAspect: height for a given width, header included, aspect echoed.
assert.deepEqual(propsForAspect(1280, WIDE), { h: Math.round(1280 / WIDE) + HDR, aspect: WIDE })

// Garbage aspect (0 / NaN — e.g. getSettings() returned nothing) falls back
// to 16:9 rather than producing Infinity-sized shapes.
assert.deepEqual(propsForAspect(1280, NaN), { h: Math.round(1280 / WIDE) + HDR, aspect: WIDE })
assert.deepEqual(propsForAspect(1280, 0), { h: Math.round(1280 / WIDE) + HDR, aspect: WIDE })
assert.equal(lockScreenShareAspect(1280, 748, 1280, 700, NaN).w, 1280)

// Chrome labels captures with opaque ids; real window titles pass through.
assert.equal(titleFromTrackLabel('screen:0:0'), 'screen share')
assert.equal(titleFromTrackLabel('window:12345:0'), 'screen share')
assert.equal(titleFromTrackLabel('web-contents-media-stream://5:1'), 'screen share')
assert.equal(titleFromTrackLabel(''), 'screen share')
assert.equal(titleFromTrackLabel('main.ts — my-editor'), 'main.ts — my-editor')

console.log('ALL SCREENSHARE HELPER TESTS PASSED')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx tsx src/screenshare/screenshare.test.ts`
Expected: FAIL — `Cannot find module './ScreenShareShapeUtil'`.

- [ ] **Step 3: Write the implementation**

Create `client/src/screenshare/ScreenShareShapeUtil.tsx`:

```tsx
/**
 * A teammate's shared window/screen as a canvas tile (spec:
 * docs/superpowers/specs/2026-07-02-screenshare-tiles-design.md).
 *
 * Position + size are shared via tldraw sync; the PIXELS are per-viewer —
 * each client attaches the LiveKit track named in the props (store.ts). The
 * sharer attaches their own local track as a self-preview; everyone else
 * receives the remote track only while the tile is in or near their viewport
 * (the loop in AvOverlay). The tile is aspect-locked to the captured surface,
 * and the sharer's client updates `aspect` when the shared window is resized,
 * so the tile always has the window's true proportions.
 */

// ── Constants + pure helpers (unit-tested via screenshare.test.ts) ──────────

// Fixed header band on top of the video area, same height as the neko shape's.
export const SCREENSHARE_HEADER_HEIGHT = 28
// Default tile width in page units — readable text without dwarfing the canvas.
export const SCREENSHARE_DEFAULT_W = 1280

// Toolbar icon: a monitor with an outgoing arrow ("share out"). Single-colour
// silhouette rendered by tldraw as a CSS mask; registered via <Tldraw
// assetUrls> in App.tsx (same mechanism as the neko icon).
export const SCREENSHARE_ICON_NAME = 'screenshare'
const SCREENSHARE_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
	'fill="none" stroke="black" stroke-width="2" stroke-linejoin="round">' +
	'<rect x="2" y="4" width="20" height="13" rx="2"/>' +
	'<path d="M12 17v3M8 20h8" stroke-linecap="round"/>' +
	'<path d="M8.5 12 12 8.5 15.5 12M12 8.5V14" stroke-linecap="round"/></svg>'
export const SCREENSHARE_TOOLBAR_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(SCREENSHARE_ICON_SVG)}`

const FALLBACK_ASPECT = 16 / 9

// getDisplayMedia settings can be empty on some platforms; never let a bad
// aspect produce an Infinity/NaN-sized shape.
function safeAspect(aspect: number): number {
	return Number.isFinite(aspect) && aspect > 0 ? aspect : FALLBACK_ASPECT
}

/**
 * Lock a freely-resized box to the stream's aspect (no letterbox at rest).
 * Drives off whichever dimension the drag changed more, so corner and side
 * handles all feel responsive (same behaviour as lockNekoAspect, but the
 * ratio comes from the shape's props instead of a constant).
 */
export function lockScreenShareAspect(
	w: number,
	h: number,
	prevW: number,
	prevH: number,
	aspect: number
): { w: number; h: number } {
	const a = safeAspect(aspect)
	if (Math.abs(h - prevH) > Math.abs(w - prevW)) {
		return { w: (h - SCREENSHARE_HEADER_HEIGHT) * a, h }
	}
	return { w, h: w / a + SCREENSHARE_HEADER_HEIGHT }
}

/**
 * Height + aspect props for a tile of width `w` showing a surface with the
 * given aspect. Used at share time and again whenever the sharer's window is
 * resized (width is kept, height follows — the tile never drifts sideways).
 */
export function propsForAspect(w: number, aspect: number): { h: number; aspect: number } {
	const a = safeAspect(aspect)
	return { h: Math.round(w / a) + SCREENSHARE_HEADER_HEIGHT, aspect: a }
}

/**
 * Chrome labels capture tracks with opaque ids like "screen:0:0" or
 * "window:12345:0"; real window titles (some platforms provide them) pass
 * through as the tile title.
 */
export function titleFromTrackLabel(label: string): string {
	if (!label || /^(screen|window|web-contents-media-stream):/i.test(label)) return 'screen share'
	return label
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx tsx src/screenshare/screenshare.test.ts`
Expected: `ALL SCREENSHARE HELPER TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add client/src/screenshare/ScreenShareShapeUtil.tsx client/src/screenshare/screenshare.test.ts
git commit -m "feat(screenshare): aspect-lock helpers, constants and toolbar icon

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Pure track resolution (`resolve.ts`)

Maps `(participantId, trackName)` from shape props to a track state. Kept free
of livekit-client imports (duck-typed room) so it unit-tests in plain node.

**Files:**
- Create: `client/src/screenshare/resolve.ts`
- Test: `client/src/screenshare/resolve.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 4's store and Task 5's component):
  - `interface AttachableTrack { attach(): HTMLMediaElement; detach(element: HTMLMediaElement): HTMLMediaElement }`
  - `interface PublicationLike { trackName: string; track?: AttachableTrack }`
  - `interface ParticipantLike { identity: string; getTrackPublications(): PublicationLike[] }`
  - `interface RoomLike { localParticipant: ParticipantLike; remoteParticipants: Map<string, ParticipantLike> }`
  - `type ScreenTrackState = { kind: 'connecting' } | { kind: 'ended' } | { kind: 'live'; track: AttachableTrack }`
  - `function resolveScreenTrack(room: RoomLike | null, participantId: string, trackName: string): ScreenTrackState`

- [ ] **Step 1: Write the failing test**

Create `client/src/screenshare/resolve.test.ts`:

```ts
/**
 * Shape-props → LiveKit track resolution. Run: npx tsx src/screenshare/resolve.test.ts
 */
import assert from 'node:assert/strict'
import {
	type AttachableTrack,
	type ParticipantLike,
	type PublicationLike,
	type RoomLike,
	resolveScreenTrack,
} from './resolve'

const track: AttachableTrack = {
	attach: () => ({}) as HTMLMediaElement,
	detach: (el) => el,
}
const participant = (identity: string, pubs: PublicationLike[]): ParticipantLike => ({
	identity,
	getTrackPublications: () => pubs,
})
const roomWith = (local: ParticipantLike, remotes: ParticipantLike[]): RoomLike => ({
	localParticipant: local,
	remoteParticipants: new Map(remotes.map((p) => [p.identity, p])),
})

// No room yet (A/V still connecting or disabled) → connecting placeholder.
assert.equal(resolveScreenTrack(null, 'a', 'screen:1').kind, 'connecting')

// Sharer's own tile: local publication with a live track → self-preview.
{
	const r = roomWith(participant('me', [{ trackName: 'screen:1', track }]), [])
	const s = resolveScreenTrack(r, 'me', 'screen:1')
	assert.equal(s.kind, 'live')
	if (s.kind === 'live') assert.equal(s.track, track)
}

// Sharer's own tile after unpublish → ended (tombstone).
{
	const r = roomWith(participant('me', []), [])
	assert.equal(resolveScreenTrack(r, 'me', 'screen:1').kind, 'ended')
}

// Remote sharer not in the room (left / tab died) → ended.
{
	const r = roomWith(participant('me', []), [])
	assert.equal(resolveScreenTrack(r, 'them', 'screen:1').kind, 'ended')
}

// Remote publication exists but no track yet (not subscribed — e.g. the tile
// is outside my viewport, or subscription is still in flight) → connecting.
{
	const r = roomWith(participant('me', []), [participant('them', [{ trackName: 'screen:1' }])])
	assert.equal(resolveScreenTrack(r, 'them', 'screen:1').kind, 'connecting')
}

// Remote publication subscribed → live.
{
	const r = roomWith(participant('me', []), [
		participant('them', [{ trackName: 'screen:1', track }]),
	])
	assert.equal(resolveScreenTrack(r, 'them', 'screen:1').kind, 'live')
}

// Remote participant present but THIS trackName is gone (that share was
// stopped; they may still have other screen tracks) → ended.
{
	const r = roomWith(participant('me', []), [
		participant('them', [{ trackName: 'screen:2', track }]),
	])
	assert.equal(resolveScreenTrack(r, 'them', 'screen:1').kind, 'ended')
}

console.log('ALL RESOLVE TESTS PASSED')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx tsx src/screenshare/resolve.test.ts`
Expected: FAIL — `Cannot find module './resolve'`.

- [ ] **Step 3: Write the implementation**

Create `client/src/screenshare/resolve.ts`:

```ts
/**
 * Pure resolution from a screenshare shape's synced props (participantId +
 * trackName) to the track a viewer should attach — or a placeholder state.
 * Duck-typed against the LiveKit Room (no livekit-client import) so it
 * unit-tests in plain node; store.ts adapts the real Room to RoomLike.
 *
 * Tracks are matched by NAME across a participant's full publication list —
 * never LiveKit's source-keyed getter, which assumes a single screen share
 * per participant (a rule the design spec is explicit about).
 */
export interface AttachableTrack {
	attach(): HTMLMediaElement
	detach(element: HTMLMediaElement): HTMLMediaElement
}

export interface PublicationLike {
	trackName: string
	track?: AttachableTrack
}

export interface ParticipantLike {
	identity: string
	getTrackPublications(): PublicationLike[]
}

export interface RoomLike {
	localParticipant: ParticipantLike
	remoteParticipants: Map<string, ParticipantLike>
}

export type ScreenTrackState =
	| { kind: 'connecting' }
	| { kind: 'ended' }
	| { kind: 'live'; track: AttachableTrack }

export function resolveScreenTrack(
	room: RoomLike | null,
	participantId: string,
	trackName: string
): ScreenTrackState {
	// No room: A/V is still connecting (or disabled) — show the placeholder
	// rather than a tombstone, since the share may be perfectly alive.
	if (!room) return { kind: 'connecting' }
	const findByName = (p: ParticipantLike) =>
		p.getTrackPublications().find((pub) => pub.trackName === trackName)
	if (room.localParticipant.identity === participantId) {
		// My own share: the local track is the self-preview. No publication
		// under this name means I unpublished it → the tile is a tombstone.
		const pub = findByName(room.localParticipant)
		return pub?.track ? { kind: 'live', track: pub.track } : { kind: 'ended' }
	}
	const participant = room.remoteParticipants.get(participantId)
	if (!participant) return { kind: 'ended' }
	const pub = findByName(participant)
	if (!pub) return { kind: 'ended' }
	// Published but not subscribed yet (out of viewport, or in flight).
	return pub.track ? { kind: 'live', track: pub.track } : { kind: 'connecting' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx tsx src/screenshare/resolve.test.ts`
Expected: `ALL RESOLVE TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add client/src/screenshare/resolve.ts client/src/screenshare/resolve.test.ts
git commit -m "feat(screenshare): pure shape-props to track-state resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: LiveKit room store + React hooks (`store.ts`)

A module-level singleton (the codebase's established pattern — cf.
`peekIdentity()`), because two consumers can't get the Room through React
context: the toolbar tool closure in `uiOverrides.tools` and shape components
deep inside tldraw's own tree.

**Files:**
- Create: `client/src/screenshare/store.ts`

**Interfaces:**
- Consumes: `resolveScreenTrack`, `RoomLike`, `ScreenTrackState` from `./resolve` (Task 3); `Room`, `RoomEvent` from `livekit-client`.
- Produces (used by Tasks 5, 6, 7):
  - `function setScreenShareRoom(next: Room | null): void` — called by `useLiveKitRoom` on connect/cleanup (Task 7). Also mirrors the room onto `window.__ewScreenShareRoom` as a debug/e2e hook.
  - `function getScreenShareRoom(): Room | null`
  - `function useScreenShareTrack(participantId: string, trackName: string): ScreenTrackState` — re-renders on any relevant RoomEvent.
  - `function useScreenShareAvailable(): boolean` — room connected AND local participant may publish; drives toolbar visibility.

- [ ] **Step 1: Write the implementation**

(No isolated node test — this file is livekit-client + React glue over the
already-tested `resolveScreenTrack`; it is exercised by typecheck now and the
e2e probe in Task 8.)

Create `client/src/screenshare/store.ts`:

```ts
/**
 * Module-level registry connecting the LiveKit Room to screen-share consumers
 * that can't receive it through React context: the toolbar tool (a closure in
 * uiOverrides, outside any component) and shape components (rendered deep in
 * tldraw's tree, far from AvOverlay where useLiveKitRoom lives). AvOverlay's
 * useLiveKitRoom registers the room here on connect and clears it on cleanup.
 */
import { Room, RoomEvent } from 'livekit-client'
import { useMemo, useSyncExternalStore } from 'react'
import { type RoomLike, type ScreenTrackState, resolveScreenTrack } from './resolve'

let room: Room | null = null
let version = 0
const listeners = new Set<() => void>()

const bump = () => {
	version += 1
	for (const listener of listeners) listener()
}

// Every event that can change what resolveScreenTrack returns for some shape.
const ROOM_EVENTS = [
	RoomEvent.TrackPublished,
	RoomEvent.TrackUnpublished,
	RoomEvent.TrackSubscribed,
	RoomEvent.TrackUnsubscribed,
	RoomEvent.LocalTrackPublished,
	RoomEvent.LocalTrackUnpublished,
	RoomEvent.ParticipantConnected,
	RoomEvent.ParticipantDisconnected,
] as const

export function setScreenShareRoom(next: Room | null): void {
	if (room === next) return
	if (room) for (const ev of ROOM_EVENTS) room.off(ev, bump)
	room = next
	if (room) for (const ev of ROOM_EVENTS) room.on(ev, bump)
	// Debug/e2e hook: lets a headless probe (and a human console) inspect
	// per-publication subscription state. Harmless in production.
	;(window as { __ewScreenShareRoom?: Room | null }).__ewScreenShareRoom = next
	bump()
}

export function getScreenShareRoom(): Room | null {
	return room
}

function subscribeStore(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

function getVersion(): number {
	return version
}

/**
 * The track (or placeholder state) a shape component should render for its
 * synced (participantId, trackName) props. The returned `track` object is
 * stable across re-renders while the underlying publication doesn't change,
 * so components can key attach/detach effects on it directly.
 */
export function useScreenShareTrack(participantId: string, trackName: string): ScreenTrackState {
	const v = useSyncExternalStore(subscribeStore, getVersion)
	return useMemo(
		// Room structurally satisfies RoomLike (identity, getTrackPublications,
		// remoteParticipants map); the cast keeps resolve.ts livekit-free.
		() => resolveScreenTrack(room as unknown as RoomLike | null, participantId, trackName),
		[v, participantId, trackName]
	)
}

/** Sharing is offered only when A/V is up and this participant may publish
 * (the scribe role is subscribe-only). */
export function useScreenShareAvailable(): boolean {
	const v = useSyncExternalStore(subscribeStore, getVersion)
	void v
	return room != null && room.localParticipant.permissions?.canPublish !== false
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=client`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add client/src/screenshare/store.ts
git commit -m "feat(screenshare): module-level LiveKit room store and track hooks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: The `screenshare` shape — class, component, client + server registration

**Files:**
- Modify: `client/src/screenshare/ScreenShareShapeUtil.tsx` (append to Task 2's file)
- Modify: `client/src/App.tsx:17-26` (imports, `customShapeUtils`, `assetUrls`)
- Modify: `server/src/schema.ts` (props validator + schema entry)

**Interfaces:**
- Consumes: `useScreenShareTrack` from `./store` (Task 4); `lockScreenShareAspect`, `SCREENSHARE_HEADER_HEIGHT`, `SCREENSHARE_DEFAULT_W`, `propsForAspect` (Task 2).
- Produces (used by Tasks 6, 7, 8):
  - `class ScreenShareShapeUtil extends BaseBoxShapeUtil<ScreenShareShape>` with `static type = 'screenshare'`
  - `interface ScreenShareShapeProps { w: number; h: number; participantId: string; trackName: string; title: string; aspect: number }`
  - Shape type string `'screenshare'` used by `editor.createShape` in Task 6 and the viewport loop in Task 7.
  - DOM contract for the e2e probe: container carries `data-screenshare={trackName}` and `data-screenshare-state={'connecting' | 'live' | 'ended'}`; the live video is a `<video>` inside it.

- [ ] **Step 1: Append the shape class and component**

Append to `client/src/screenshare/ScreenShareShapeUtil.tsx` (below the helpers; add the imports at the top of the file):

```tsx
import { useEffect, useRef } from 'react'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	T,
	TLBaseShape,
	TLResizeInfo,
	resizeBox,
} from 'tldraw'
import { wm } from '../theme'
import { useScreenShareTrack } from './store'
```

```tsx
// ── Shape ────────────────────────────────────────────────────────────────────

export interface ScreenShareShapeProps {
	w: number
	h: number
	// LiveKit participant identity of the sharer + their track name — the join
	// key between this shape and the media plane. Never route by source.
	participantId: string
	trackName: string
	title: string
	// Captured surface width/height ratio; the sharer's client rewrites it
	// when the shared window is resized, and everyone's aspect lock follows.
	aspect: number
}

declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		screenshare: ScreenShareShapeProps
	}
}

export type ScreenShareShape = TLBaseShape<'screenshare', ScreenShareShapeProps>

export class ScreenShareShapeUtil extends BaseBoxShapeUtil<ScreenShareShape> {
	static override type = 'screenshare' as const
	// Keep in sync with server/src/schema.ts
	static override props = {
		w: T.number,
		h: T.number,
		participantId: T.string,
		trackName: T.string,
		title: T.string,
		aspect: T.number,
	}

	override getDefaultProps(): ScreenShareShape['props'] {
		return {
			w: SCREENSHARE_DEFAULT_W,
			...propsForAspect(SCREENSHARE_DEFAULT_W, 16 / 9),
			participantId: '',
			trackName: '',
			title: 'screen share',
		}
	}

	// Locked to the captured surface's proportions — a screen tile with dead
	// letterbox bars invites annotating empty space.
	override isAspectRatioLocked() {
		return true
	}

	override hideRotateHandle() {
		return true
	}

	override onResize(shape: ScreenShareShape, info: TLResizeInfo<ScreenShareShape>) {
		const next = resizeBox(shape, info, { minWidth: 320, minHeight: 200 })
		const locked = lockScreenShareAspect(
			next.props.w,
			next.props.h,
			shape.props.w,
			shape.props.h,
			shape.props.aspect
		)
		return { ...next, props: { ...next.props, ...locked } }
	}

	override component(shape: ScreenShareShape) {
		return <ScreenShareComponent shape={shape} />
	}

	override getIndicatorPath(shape: ScreenShareShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function ScreenShareComponent({ shape }: { shape: ScreenShareShape }) {
	const { w, h, title, participantId, trackName } = shape.props
	const state = useScreenShareTrack(participantId, trackName)
	// Keyed on the track object (stable per publication) so version bumps that
	// don't change the track never re-attach the video element.
	const track = state.kind === 'live' ? state.track : null
	const videoRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const el = videoRef.current
		if (!el || !track) return
		const video = track.attach() as HTMLVideoElement
		// No track audio in v1 (video-only capture) — muted also keeps
		// autoplay policies out of the way.
		video.muted = true
		// contain, not cover: during a source-window resize the aspect prop
		// lags the pixels by up to a second — letterbox briefly, never distort.
		Object.assign(video.style, {
			width: '100%',
			height: '100%',
			objectFit: 'contain',
			background: '#000',
		})
		el.appendChild(video)
		return () => {
			track.detach(video)
			video.remove()
		}
	}, [track])

	const statusColor =
		state.kind === 'live' ? wm.ok : state.kind === 'connecting' ? wm.warn : wm.inkSubtle

	return (
		<HTMLContainer
			data-screenshare={trackName}
			data-screenshare-state={state.kind}
			style={{
				display: 'flex',
				flexDirection: 'column',
				width: w,
				height: h,
				borderRadius: 4,
				overflow: 'hidden',
				background: '#000',
				border: `1px solid ${wm.ruleStrong}`,
				boxShadow: wm.shadowPaper,
				// Display-only tile: all interaction is tldraw's (move/resize/
				// annotate). No edit mode, unlike neko — there's nothing to drive.
				pointerEvents: 'none',
			}}
		>
			<div
				style={{
					height: SCREENSHARE_HEADER_HEIGHT,
					flexShrink: 0,
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					padding: '0 10px',
					background: wm.panel,
					color: wm.inkMuted,
					fontFamily: wm.mono,
					fontSize: 10,
					borderBottom: `1px solid ${wm.rule}`,
					userSelect: 'none',
				}}
				title="A minimized or fully covered source window may freeze — keep it visible on the sharer's machine"
			>
				<span
					style={{
						width: 8,
						height: 8,
						borderRadius: '50%',
						background: statusColor,
						flex: '0 0 auto',
					}}
				/>
				<span
					style={{
						color: wm.ink,
						fontWeight: 700,
						textTransform: 'uppercase',
						letterSpacing: 1.5,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
				>
					{title}
				</span>
				<span style={{ opacity: 0.6, whiteSpace: 'nowrap', marginLeft: 'auto' }}>
					screen share · {state.kind}
				</span>
			</div>
			<div ref={videoRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
				{state.kind !== 'live' && (
					<div
						style={{
							position: 'absolute',
							inset: 0,
							display: 'grid',
							placeItems: 'center',
							color: wm.inkMuted,
							fontFamily: wm.mono,
							fontSize: 12,
							background: '#111',
						}}
					>
						{state.kind === 'connecting'
							? 'connecting…'
							: 'share ended — safe to delete this tile'}
					</div>
				)}
			</div>
		</HTMLContainer>
	)
}
```

- [ ] **Step 2: Register the shape on the client**

In `client/src/App.tsx`, add the import next to the neko import:

```tsx
import {
	SCREENSHARE_ICON_NAME,
	SCREENSHARE_TOOLBAR_ICON,
	ScreenShareShapeUtil,
} from './screenshare/ScreenShareShapeUtil'
```

Change the two registration lines:

```tsx
const customShapeUtils = [
	TerminalShapeUtil,
	IframeShapeUtil,
	NekoShapeUtil,
	RoadmapShapeUtil,
	ScreenShareShapeUtil,
]
```

```tsx
const assetUrls = {
	icons: {
		[NEKO_ICON_NAME]: NEKO_TOOLBAR_ICON,
		[SCREENSHARE_ICON_NAME]: SCREENSHARE_TOOLBAR_ICON,
	},
}
```

- [ ] **Step 3: Register the shape on the server**

In `server/src/schema.ts`, add after `roadmapShapeProps`:

```ts
// Keep in sync with client/src/screenshare/ScreenShareShapeUtil.tsx
const screenshareShapeProps = {
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
}
```

and register it in `createTLSchema`:

```ts
		roadmap: { props: roadmapShapeProps },
		screenshare: { props: screenshareShapeProps },
```

- [ ] **Step 4: Typecheck + run all unit tests**

Run: `npm run typecheck` (repo root)
Expected: exits 0.

Run: `cd client && npx tsx src/screenshare/screenshare.test.ts && npx tsx src/screenshare/resolve.test.ts && npx tsx src/screenshare/visibility.test.ts`
Expected: all three PASS lines.

- [ ] **Step 5: Commit**

```bash
git add client/src/screenshare/ScreenShareShapeUtil.tsx client/src/App.tsx server/src/schema.ts
git commit -m "feat(screenshare): screenshare shape with per-viewer video attach

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Share lifecycle manager + toolbar tool (`share.ts`, `ui.tsx`)

**Files:**
- Create: `client/src/screenshare/share.ts`
- Modify: `client/src/ui.tsx` (tool registration + toolbar item)

**Interfaces:**
- Consumes: `getScreenShareRoom` (Task 4); `SCREENSHARE_DEFAULT_W`, `SCREENSHARE_ICON_NAME`, `propsForAspect`, `titleFromTrackLabel` (Task 2); `useScreenShareAvailable` (Task 4); livekit-client `ScreenSharePresets`, `Track`, `VideoPreset`; tldraw `Editor`, `createShapeId`.
- Produces:
  - `async function startScreenShare(editor: Editor): Promise<void>` — the toolbar entry point; safe to call repeatedly (each call = one new independent share).
  - `function stopScreenShare(editor: Editor, trackName: string): void`

- [ ] **Step 1: Write the implementation**

(The pure pieces — `titleFromTrackLabel`, `propsForAspect` — were TDD'd in
Task 2; this file is browser-API + LiveKit glue, verified by typecheck now
and the e2e probe in Task 8.)

Create `client/src/screenshare/share.ts`:

```ts
/**
 * Local screen-share lifecycle: capture → publish → shape, and teardown from
 * whichever end dies first (browser "Stop sharing" bar, tile deletion by
 * anyone, unpublish). Module-level rather than a hook so the toolbar tool —
 * a closure in uiOverrides with only the editor in hand — can call it; the
 * LiveKit room arrives via the screenshare store.
 *
 * Each call to startScreenShare is one independent share: one browser picker
 * (one surface — the browser's consent boundary, by design), one named track
 * `screen:<uuid>`, one tile. Multi-window sharing = press the button again.
 * Never setScreenShareEnabled(): it manages exactly one screen track.
 */
import { ScreenSharePresets, Track, VideoPreset } from 'livekit-client'
import { Editor, TLShapeId, createShapeId } from 'tldraw'
import {
	SCREENSHARE_DEFAULT_W,
	propsForAspect,
	titleFromTrackLabel,
} from './ScreenShareShapeUtil'
import { getScreenShareRoom } from './store'

// Capped top layer: 1080p / 15 fps / 2.5 Mbps — screen content favours
// resolution over smoothness (the spec's honest baseline), and the cap keeps
// a canvas of many tiles inside the self-hosted SFU's bandwidth budget. One
// cheap simulcast layer serves zoomed-out tiles via adaptiveStream.
const SCREEN_TOP_LAYER = new VideoPreset(1920, 1080, 2_500_000, 15)
const SCREEN_LOW_LAYER = ScreenSharePresets.h360fps3

interface ActiveShare {
	shapeId: TLShapeId
	mediaTrack: MediaStreamTrack
	pollTimer: ReturnType<typeof setInterval>
}

// Keyed by trackName. Only the sharer's own client has entries here.
const active = new Map<string, ActiveShare>()
const deleteHandlerInstalled = new WeakSet<Editor>()

export async function startScreenShare(editor: Editor): Promise<void> {
	const room = getScreenShareRoom()
	// The toolbar item is hidden when unavailable, but guard anyway (a stale
	// toolbar during a reconnect can still fire this).
	if (!room || room.localParticipant.permissions?.canPublish === false) {
		window.alert('Screen sharing is unavailable — audio/video is not connected.')
		return
	}

	let stream: MediaStream
	try {
		// Video only in v1: voice already flows through spatial mic audio.
		stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
	} catch {
		return // picker cancelled or denied — a non-event, not an error
	}
	const mediaTrack = stream.getVideoTracks()[0]
	if (!mediaTrack) return
	// Crisp text under bitrate pressure beats smooth motion for screen content.
	mediaTrack.contentHint = 'detail'

	const settings = mediaTrack.getSettings()
	const aspect =
		settings.width && settings.height ? settings.width / settings.height : 16 / 9
	const trackName = `screen:${crypto.randomUUID()}`

	try {
		await room.localParticipant.publishTrack(mediaTrack, {
			name: trackName,
			source: Track.Source.ScreenShare,
			simulcast: true,
			screenShareEncoding: SCREEN_TOP_LAYER.encoding,
			screenShareSimulcastLayers: [SCREEN_LOW_LAYER],
		})
	} catch (err) {
		console.error('screen share publish failed', err)
		mediaTrack.stop()
		return
	}

	const w = SCREENSHARE_DEFAULT_W
	const sized = propsForAspect(w, aspect)
	const { x, y } = editor.getViewportPageBounds().center
	const shapeId = createShapeId()
	editor.createShape({
		id: shapeId,
		type: 'screenshare',
		x: x - w / 2,
		y: y - sized.h / 2,
		props: {
			w,
			h: sized.h,
			participantId: room.localParticipant.identity,
			trackName,
			title: titleFromTrackLabel(mediaTrack.label),
			aspect: sized.aspect,
		},
	})
	editor.setSelectedShapes([shapeId])

	// Aspect follows the source: when the shared window is resized, rewrite
	// the tile's height/aspect (width kept, so the tile never drifts). Capture
	// settings only change on real resizes, so a 1 s poll is plenty and avoids
	// wiring per-frame media events.
	const pollTimer = setInterval(() => {
		const cur = mediaTrack.getSettings()
		if (!cur.width || !cur.height) return
		const nextAspect = cur.width / cur.height
		const shape = editor.getShape(shapeId)
		if (!shape) return
		const props = shape.props as { w: number; aspect: number }
		if (Math.abs(nextAspect - props.aspect) < 0.01) return
		editor.updateShape({
			id: shapeId,
			type: 'screenshare',
			props: propsForAspect(props.w, nextAspect),
		})
	}, 1000)

	active.set(trackName, { shapeId, mediaTrack, pollTimer })
	// Browser "Stop sharing" bar (or the OS revoking capture) → tear down.
	mediaTrack.addEventListener('ended', () => stopScreenShare(editor, trackName))
	installDeleteHandler(editor)
}

export function stopScreenShare(editor: Editor, trackName: string): void {
	const share = active.get(trackName)
	if (!share) return
	active.delete(trackName)
	clearInterval(share.pollTimer)
	getScreenShareRoom()?.localParticipant.unpublishTrack(share.mediaTrack, true)
	share.mediaTrack.stop()
	// Absent when teardown started FROM a deletion (delete handler below).
	if (editor.getShape(share.shapeId)) editor.deleteShape(share.shapeId)
}

// Deleting a live share's tile — locally or by a teammate over sync — stops
// the capture: a tile-less stream would otherwise keep uploading invisibly.
function installDeleteHandler(editor: Editor) {
	if (deleteHandlerInstalled.has(editor)) return
	deleteHandlerInstalled.add(editor)
	editor.sideEffects.registerAfterDeleteHandler('shape', (shape) => {
		if (shape.type !== 'screenshare') return
		const trackName = (shape.props as { trackName: string }).trackName
		if (active.has(trackName)) stopScreenShare(editor, trackName)
	})
}
```

- [ ] **Step 2: Add the toolbar tool**

In `client/src/ui.tsx`:

Add imports:

```tsx
import { SCREENSHARE_ICON_NAME } from './screenshare/ScreenShareShapeUtil'
import { startScreenShare } from './screenshare/share'
import { useScreenShareAvailable } from './screenshare/store'
```

In `uiOverrides.tools`, after the `roadmap` tool:

```tsx
		tools['screenshare'] = {
			id: 'screenshare',
			icon: SCREENSHARE_ICON_NAME,
			label: 'Share screen',
			readonlyOk: false,
			onSelect() {
				void startScreenShare(editor)
			},
		}
```

In `ToolbarWithTerminal`, read availability and render the item conditionally
(hidden when A/V is disabled or this participant can't publish):

```tsx
function ToolbarWithTerminal() {
	const tools = useTools()
	const screenShareAvailable = useScreenShareAvailable()
	return (
		<DefaultToolbar>
			<DefaultToolbarContent />
			{tools['terminal'] && <TldrawUiMenuItem {...tools['terminal']} />}
			{tools['dev-server'] && <TldrawUiMenuItem {...tools['dev-server']} />}
			{tools['neko'] && <TldrawUiMenuItem {...tools['neko']} />}
			{tools['roadmap'] && <TldrawUiMenuItem {...tools['roadmap']} />}
			{screenShareAvailable && tools['screenshare'] && (
				<TldrawUiMenuItem {...tools['screenshare']} />
			)}
		</DefaultToolbar>
	)
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=client`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add client/src/screenshare/share.ts client/src/ui.tsx
git commit -m "feat(screenshare): share lifecycle manager and toolbar tool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Room wiring — adaptiveStream/dynacast, store registration, viewport loop

**Files:**
- Modify: `client/src/av/useLiveKitRoom.ts` (Room options + store registration)
- Modify: `client/src/av/AvOverlay.tsx` (viewport subscription loop)
- Modify: `client/src/App.tsx` (expose editor debug hook for the e2e probe)

**Interfaces:**
- Consumes: `setScreenShareRoom` (Task 4), `shouldBeSubscribed` (Task 1), shape type `'screenshare'` with `trackName` prop (Task 5).
- Produces: `window.__ewEditor` (tldraw `Editor`) and `window.__ewScreenShareRoom` (via Task 4) — the e2e probe's contract (Task 8). Room now runs with `adaptiveStream` + `dynacast`.

- [ ] **Step 1: Room options + store registration in `useLiveKitRoom.ts`**

Add the import:

```ts
import { setScreenShareRoom } from '../screenshare/store'
```

Change the Room construction (line ~138) from `const r = new Room()` to:

```ts
			// adaptiveStream: delivered video layer follows the attached element's
			// on-screen size, and fully hidden elements pause server-side (tldraw
			// culls off-viewport shapes from the DOM, so panning away pauses the
			// stream). dynacast: layers nobody subscribes to stop being ENCODED at
			// the publisher. Both were unset pre-screen-share; camera bubbles in
			// the faces rail benefit too. Audio is unaffected (video-only features).
			const r = new Room({ adaptiveStream: true, dynacast: true })
```

After the successful connect block (immediately after `rebuildPeers(r)` that
follows `setStatus('connected')`), add:

```ts
			setScreenShareRoom(r)
```

In the effect cleanup, before `lkRoom?.disconnect()`, add:

```ts
			setScreenShareRoom(null)
```

- [ ] **Step 2: Viewport subscription loop in `AvOverlay.tsx`**

Add the import:

```ts
import { shouldBeSubscribed } from '../screenshare/visibility'
```

(`Track` is already imported from `livekit-client` in this file.)

Directly after the spatial audio loop `useEffect` (ends around line 206), add:

```ts
	// Viewport-scoped screen-share delivery (spec §6.3, deterministic path):
	// subscribe only to screen tracks whose tile is in — or within a margin of
	// — my viewport, with hysteresis so edge-panning doesn't flap. Same 150 ms
	// cadence as the spatial audio loop above; audio subscriptions untouched.
	useEffect(() => {
		const room = lk.room
		if (!room) return
		const timer = setInterval(() => {
			const viewport = editor.getViewportPageBounds()
			const boundsByTrackName = new Map<string, { x: number; y: number; w: number; h: number }>()
			for (const shape of editor.getCurrentPageShapes()) {
				if (shape.type !== 'screenshare') continue
				const bounds = editor.getShapePageBounds(shape.id)
				if (bounds) {
					boundsByTrackName.set((shape.props as { trackName: string }).trackName, bounds)
				}
			}
			for (const participant of room.remoteParticipants.values()) {
				for (const pub of participant.getTrackPublications()) {
					if (pub.source !== Track.Source.ScreenShare) continue
					// A tile on another page (or deleted) maps to null → unsubscribe.
					const want = shouldBeSubscribed(
						boundsByTrackName.get(pub.trackName) ?? null,
						viewport,
						pub.isSubscribed
					)
					if (want !== pub.isSubscribed) pub.setSubscribed(want)
				}
			}
		}, 150)
		return () => clearInterval(timer)
	}, [editor, lk.room])
```

- [ ] **Step 3: Expose the editor for headless probes**

In `client/src/App.tsx`, inside `handleMount` (first line of the callback,
before the preferences update):

```ts
				// Debug/e2e hook: headless probes (docs/headless-browser.md) drive
				// the canvas through this. Harmless in production.
				;(window as unknown as { __ewEditor?: Editor }).__ewEditor = editor
```

- [ ] **Step 4: Typecheck + unit tests**

Run: `npm run typecheck`
Expected: exits 0.

Run: `cd client && npx tsx src/screenshare/visibility.test.ts && npx tsx src/av/spatial.test.ts`
Expected: both PASS (spatial re-run guards the AvOverlay edit).

- [ ] **Step 5: Commit**

```bash
git add client/src/av/useLiveKitRoom.ts client/src/av/AvOverlay.tsx client/src/App.tsx
git commit -m "feat(screenshare): adaptiveStream/dynacast + viewport-scoped subscription loop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end probe (sharer publishes, viewer sees, viewport scoping, teardown)

**Files:**
- Create: `client/e2e/screenshare-probe.mjs`

**Interfaces:**
- Consumes: the DOM contract from Task 5 (`[data-screenshare]`, `data-screenshare-state`, inner `<video>`); debug hooks `window.__ewScreenShareRoom` (Task 4) and `window.__ewEditor` (Task 7); toolbar item `[title="Share screen"]` (Task 6).
- Produces: a self-contained pass/fail script; exit code 0 = all assertions held.

**Preconditions (verify before running, per `docs/headless-browser.md` and the
dev tmux stack):**

1. Dev stack running: vite on :5173, sync server on :8788.
2. LiveKit configured in dev:
   `curl -s 'http://localhost:8788/api/livekit-token?room=probe&identity=p&name=p' | grep -o '"enabled":[a-z]*'`
   must print `"enabled":true`. If it prints `false`, the probe cannot run —
   report this as a blocker rather than faking a pass.
3. Playwright scratch install exists: `/tmp/canvas-probe` with `playwright`
   installed (`docs/headless-browser.md` setup section).

- [ ] **Step 1: Write the probe**

Create `client/e2e/screenshare-probe.mjs`:

```js
/**
 * End-to-end probe for screen-share tiles (spec §testing):
 *   1. sharer publishes a (fake) screen capture via the toolbar tool
 *   2. a second client sees the tile go live and render frames
 *   3. panning the viewer away unsubscribes the track at the SFU; back resubscribes
 *   4. the viewer deleting the tile stops the sharer's capture + publication
 *
 * Run from the playwright scratch dir (docs/headless-browser.md):
 *   cd /tmp/canvas-probe && node <repo>/client/e2e/screenshare-probe.mjs
 * Requires the dev stack (vite :5173, sync :8788) and LiveKit enabled.
 */
import { createRequire } from 'node:module'
// Resolve playwright from the CWD (the scratch dir), not this repo.
const require = createRequire(process.cwd() + '/')
const { chromium } = require('playwright')

const BASE = process.env.CANVAS_URL ?? 'http://localhost:5173'
const ROOM = `ss-probe-${Date.now().toString(36)}`
const HOME = 'd=v0.0.1600.900' // deep link back to the origin viewport
const AWAY = 'd=v50000.50000.1600.900' // far off-canvas — nothing subscribed here

function fail(msg) {
	console.error(`FAIL: ${msg}`)
	process.exit(1)
}

/** Poll an async predicate until truthy or timeout; returns the last value. */
async function until(label, fn, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs
	let last
	while (Date.now() < deadline) {
		last = await fn().catch(() => undefined)
		if (last) {
			console.log(`PASS: ${label}`)
			return last
		}
		await new Promise((r) => setTimeout(r, 250))
	}
	fail(`${label} (timed out; last=${JSON.stringify(last)})`)
}

/** Read a named screen publication's isSubscribed on a page, or null. */
const subscriptionState = (page, trackName) =>
	page.evaluate((name) => {
		const room = window.__ewScreenShareRoom
		if (!room) return null
		for (const p of room.remoteParticipants.values()) {
			for (const pub of p.getTrackPublications()) {
				if (pub.trackName === name) return { isSubscribed: pub.isSubscribed }
			}
		}
		return null
	}, trackName)

const browser = await chromium.launch({
	headless: true,
	args: [
		// Auto-consent the capture picker and hand it the (virtual) screen —
		// the only way to exercise getDisplayMedia headlessly.
		'--use-fake-ui-for-media-stream',
		'--auto-select-desktop-capture-source=Entire screen',
		'--use-fake-device-for-media-stream',
	],
})

// ── Sharer ───────────────────────────────────────────────────────────────────
const sharerCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
const sharer = await sharerCtx.newPage()
sharer.on('dialog', (d) => d.accept('sharer-bot').catch(() => {}))
await sharer.goto(`${BASE}/?room=${ROOM}&${HOME}`, { waitUntil: 'domcontentloaded' })
await sharer.waitForSelector('.tl-canvas', { timeout: 20000 })
await until('sharer A/V connected', () => sharer.evaluate(() => !!window.__ewScreenShareRoom))

await sharer.click('[title="Share screen"]')
await until(
	'sharer tile created and live (self-preview)',
	() => sharer.locator('[data-screenshare][data-screenshare-state="live"]').count()
)
const trackName = await sharer
	.locator('[data-screenshare]')
	.first()
	.getAttribute('data-screenshare')
if (!trackName?.startsWith('screen:')) fail(`bad trackName: ${trackName}`)
console.log(`PASS: track published as ${trackName}`)

// ── Viewer sees the stream ───────────────────────────────────────────────────
const viewerCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
const viewer = await viewerCtx.newPage()
viewer.on('dialog', (d) => d.accept('viewer-bot').catch(() => {}))
await viewer.goto(`${BASE}/?room=${ROOM}&${HOME}`, { waitUntil: 'domcontentloaded' })
await viewer.waitForSelector('.tl-canvas', { timeout: 20000 })
await until('viewer A/V connected', () => viewer.evaluate(() => !!window.__ewScreenShareRoom))
await until(
	'viewer tile live',
	() => viewer.locator('[data-screenshare][data-screenshare-state="live"]').count()
)
await until('viewer video has frames', () =>
	viewer.evaluate(() => {
		const v = document.querySelector('[data-screenshare] video')
		return !!v && v.videoWidth > 0
	})
)

// ── Viewport scoping ─────────────────────────────────────────────────────────
await viewer.goto(`${BASE}/?room=${ROOM}&${AWAY}`, { waitUntil: 'domcontentloaded' })
await viewer.waitForSelector('.tl-canvas', { timeout: 20000 })
await until('panned-away viewer unsubscribes at the SFU', async () => {
	const s = await subscriptionState(viewer, trackName)
	return s !== null && s.isSubscribed === false
})
await viewer.goto(`${BASE}/?room=${ROOM}&${HOME}`, { waitUntil: 'domcontentloaded' })
await viewer.waitForSelector('.tl-canvas', { timeout: 20000 })
await until('returning viewer resubscribes', async () => {
	const s = await subscriptionState(viewer, trackName)
	return s !== null && s.isSubscribed === true
})

// ── Teardown: viewer deletes the tile → sharer stops capture + publication ──
await viewer.evaluate(() => {
	const editor = window.__ewEditor
	const shape = editor.getCurrentPageShapes().find((s) => s.type === 'screenshare')
	editor.deleteShape(shape.id)
})
await until(
	'sharer tile removed after remote delete',
	async () => (await sharer.locator('[data-screenshare]').count()) === 0
)
await until('sharer publication withdrawn', () =>
	sharer.evaluate(() => {
		const room = window.__ewScreenShareRoom
		return (
			room &&
			room.localParticipant
				.getTrackPublications()
				.every((pub) => !pub.trackName?.startsWith('screen:'))
		)
	})
)

await browser.close()
console.log('ALL SCREENSHARE E2E CHECKS PASSED')
```

- [ ] **Step 2: Run the probe**

Run:

```bash
cd /tmp/canvas-probe && node /home/mrdavidlaing/Work/ensembleworks/client/e2e/screenshare-probe.mjs
```

Expected output ends with `ALL SCREENSHARE E2E CHECKS PASSED`, exit 0.

If it fails: debug with `headless: false` locally impossible on the VM — add
`await page.screenshot({ path: '/tmp/ss-<step>.png' })` calls at the failing
step and inspect. Do NOT mark this task complete until the probe passes or
the failure is a documented environment blocker (e.g. LiveKit disabled in
dev), reported to the user verbatim.

- [ ] **Step 3: Full verification sweep**

```bash
npm run typecheck
cd client \
  && npx tsx src/screenshare/visibility.test.ts \
  && npx tsx src/screenshare/screenshare.test.ts \
  && npx tsx src/screenshare/resolve.test.ts \
  && npx tsx src/av/spatial.test.ts \
  && npx tsx src/neko/neko.test.ts \
  && npx tsx src/roadmap/model.test.ts
```

Expected: typecheck exits 0; every test script prints its PASS line.

- [ ] **Step 4: Commit**

```bash
git add client/e2e/screenshare-probe.mjs
git commit -m "test(screenshare): end-to-end probe for publish, view, viewport scoping, teardown

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
