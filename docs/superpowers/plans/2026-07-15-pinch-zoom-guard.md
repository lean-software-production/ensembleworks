# Pinch-Zoom Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trackpad pinch never triggers browser page zoom anywhere in the app; pinch over an interactive file viewer zooms the canvas instead.

**Architecture:** (spec: `docs/superpowers/specs/2026-07-15-pinch-zoom-guard-design.md`) Two layered guards. (1) A capture-phase non-passive `wheel` listener on `window` preventDefaults all ctrl/meta+wheel — kills browser zoom over fixed chrome for both engines without touching canvas zoom (preventDefault doesn't stop propagation). (2) The `/files/*` bridge script intercepts pinch inside the file-viewer iframe, postMessages `ew-pinch` to the parent, and the two file-viewer shape components re-dispatch it as a synthetic ctrl-wheel on the iframe element so it bubbles into the enclosing engine's normal zoom path.

**Tech Stack:** TypeScript, React, Bun workspaces. Tests are plain `bun src/<file>.test.ts` scripts using `node:assert/strict` (no DOM in the test runner — keep DOM-touching code thin, test the pure parts).

---

### Task 1: App-level pinch guard

**Files:**
- Create: `client/src/kernel/pinchGuard.ts`
- Create: `client/src/kernel/pinchGuard.test.ts`
- Modify: `client/src/App.tsx` (install in a `useEffect`)

- [ ] **Step 1: Write the failing test**

`client/src/kernel/pinchGuard.test.ts`:

```ts
/**
 * Run: bun src/kernel/pinchGuard.test.ts
 * Pure-structural test: a fake window records listeners; we invoke them with
 * fake events and assert preventDefault behaviour + uninstall symmetry.
 */
import assert from 'node:assert/strict'
import { installPinchGuard, type GuardWindow } from './pinchGuard'

type Entry = { type: string; fn: (e: any) => void; opts: unknown }
const added: Entry[] = []
const removed: Entry[] = []
const fakeWin: GuardWindow = {
	addEventListener: (type: string, fn: any, opts?: unknown) => added.push({ type, fn, opts }),
	removeEventListener: (type: string, fn: any, opts?: unknown) => removed.push({ type, fn, opts }),
}

const uninstall = installPinchGuard(fakeWin)

// 1. wheel listener registered non-passive + capture.
const wheel = added.find((e) => e.type === 'wheel')
assert.ok(wheel, 'wheel listener registered')
assert.deepEqual(wheel!.opts, { passive: false, capture: true })

// 2. ctrl+wheel and meta+wheel are preventDefaulted; plain wheel is not.
function fire(fn: (e: any) => void, mods: { ctrlKey?: boolean; metaKey?: boolean }): boolean {
	let prevented = false
	fn({ ctrlKey: false, metaKey: false, ...mods, preventDefault: () => { prevented = true } })
	return prevented
}
assert.equal(fire(wheel!.fn, { ctrlKey: true }), true, 'ctrl+wheel prevented')
assert.equal(fire(wheel!.fn, { metaKey: true }), true, 'meta+wheel prevented')
assert.equal(fire(wheel!.fn, {}), false, 'plain wheel untouched')

// 3. Safari gesture events registered and preventDefaulted.
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
	const g = added.find((e) => e.type === t)
	assert.ok(g, `${t} listener registered`)
	assert.equal(fire(g!.fn, {}), true, `${t} prevented`)
}

// 4. Uninstall removes exactly what was added (same fn + type pairs).
uninstall()
assert.equal(removed.length, added.length, 'uninstall removes every listener')
for (const r of removed) {
	assert.ok(added.some((a) => a.type === r.type && a.fn === r.fn), `removed ${r.type} matches added`)
}

console.log('pinchGuard.test.ts OK')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && bun src/kernel/pinchGuard.test.ts`
Expected: FAIL — cannot resolve `./pinchGuard`.

- [ ] **Step 3: Write the implementation**

`client/src/kernel/pinchGuard.ts`:

```ts
/**
 * App-wide browser-zoom guard (spec: docs/superpowers/specs/
 * 2026-07-15-pinch-zoom-guard-design.md). A trackpad pinch arrives as a
 * `wheel` event with ctrlKey:true; only the canvas containers preventDefault
 * it, so a pinch over fixed chrome (side panel, control bar) page-zooms the
 * whole app. This capture-phase, NON-PASSIVE window listener preventDefaults
 * every ctrl/meta+wheel — preventDefault does not stop propagation, so the
 * engines' own canvas-zoom listeners still run unchanged. Safari's
 * proprietary gesture* pinch path gets the same treatment. Keyboard zoom
 * (Cmd/Ctrl-+/−/0) is deliberately untouched (accessibility escape hatch).
 */

/** The slice of Window the guard needs — lets tests pass a stub. */
export interface GuardWindow {
	addEventListener(type: string, fn: (e: any) => void, opts?: AddEventListenerOptions): void
	removeEventListener(type: string, fn: (e: any) => void, opts?: AddEventListenerOptions): void
}

const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const

export function installPinchGuard(win: GuardWindow): () => void {
	const onWheel = (e: { ctrlKey: boolean; metaKey: boolean; preventDefault(): void }) => {
		if (e.ctrlKey || e.metaKey) e.preventDefault()
	}
	const onGesture = (e: { preventDefault(): void }) => e.preventDefault()
	const wheelOpts: AddEventListenerOptions = { passive: false, capture: true }
	const gestureOpts: AddEventListenerOptions = { passive: false, capture: true }
	win.addEventListener('wheel', onWheel, wheelOpts)
	for (const t of GESTURE_EVENTS) win.addEventListener(t, onGesture, gestureOpts)
	return () => {
		win.removeEventListener('wheel', onWheel, wheelOpts)
		for (const t of GESTURE_EVENTS) win.removeEventListener(t, onGesture, gestureOpts)
	}
}
```

Note: the test asserts `wheel.opts` deep-equals `{ passive: false, capture: true }` — keep the literal in that shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && bun src/kernel/pinchGuard.test.ts`
Expected: `pinchGuard.test.ts OK`

- [ ] **Step 5: Install in App.tsx**

In `client/src/App.tsx`, inside the `App` component (alongside the existing `useEffect`s, e.g. right before the first one at ~line 127), add:

```tsx
useEffect(() => installPinchGuard(window), [])
```

and add to the imports:

```tsx
import { installPinchGuard } from './kernel/pinchGuard'
```

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck`
Expected: clean.

```bash
git add client/src/kernel/pinchGuard.ts client/src/kernel/pinchGuard.test.ts client/src/App.tsx
git commit -m "feat(client): app-wide pinch guard — browser page-zoom never fires over chrome"
```

---

### Task 2: Bridge-script pinch interception (`/files/*` iframe)

**Files:**
- Modify: `server/src/files-render.ts` (`BRIDGE_SCRIPT`, lines 14–39)
- Modify: `server/src/files-render.test.ts` (extend existing assertions)

- [ ] **Step 1: Write the failing test**

Look at `server/src/files-render.test.ts` and follow its existing style. Append assertions:

```ts
// Pinch interception (spec: 2026-07-15-pinch-zoom-guard-design.md): the
// bridge preventDefaults ctrl/meta wheel inside the iframe document and
// forwards it to the parent as an ew-pinch message.
assert.ok(BRIDGE_SCRIPT.includes("addEventListener('wheel'"), 'bridge has a wheel listener')
assert.ok(BRIDGE_SCRIPT.includes('{ passive: false }'), 'wheel listener is non-passive')
assert.ok(BRIDGE_SCRIPT.includes("type: 'ew-pinch'"), 'bridge posts ew-pinch')
```

(If the file doesn't already import `BRIDGE_SCRIPT`, add it to the existing import from `./files-render`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && bun src/files-render.test.ts`
Expected: FAIL on `bridge has a wheel listener`.

- [ ] **Step 3: Extend BRIDGE_SCRIPT**

In `server/src/files-render.ts`, inside the IIFE, immediately before the final `parent.postMessage({ type: 'ew-file-viewer-ready' }, '*')` line, add:

```js
	// Pinch guard + forward (spec: 2026-07-15-pinch-zoom-guard-design.md):
	// a trackpad pinch is ctrl+wheel; unhandled it browser-zooms the WHOLE
	// parent page (wheel never propagates out of an iframe). Swallow it here
	// and forward to the parent, which replays it on the canvas so pinch
	// over an interactive viewer zooms the canvas. Plain wheel (scrolling)
	// is untouched.
	window.addEventListener('wheel', function (e) {
		if (!e.ctrlKey && !e.metaKey) return
		e.preventDefault()
		parent.postMessage({ type: 'ew-pinch', deltaX: e.deltaX, deltaY: e.deltaY, x: e.clientX, y: e.clientY }, '*')
	}, { passive: false })
```

(Keep it ES5-style `function`/`var` like the rest of the script; it must stay one IIFE, no globals.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && bun src/files-render.test.ts`
Expected: all assertions pass (existing + new).

- [ ] **Step 5: Commit**

```bash
git add server/src/files-render.ts server/src/files-render.test.ts
git commit -m "feat(server): file-viewer bridge intercepts pinch and forwards ew-pinch to parent"
```

---

### Task 3: Pinch forwarding module (shared by both file-viewer components)

**Files:**
- Create: `client/src/file-viewer/pinchForward.ts`
- Create: `client/src/file-viewer/pinchForward.test.ts`

- [ ] **Step 1: Write the failing test**

`client/src/file-viewer/pinchForward.test.ts`:

```ts
/**
 * Run: bun src/file-viewer/pinchForward.test.ts
 * Pure halves only — parsePinchMessage validation and the iframe-content →
 * parent-client coordinate map. The WheelEvent dispatch half is a thin DOM
 * shim exercised manually (plan Task 5).
 */
import assert from 'node:assert/strict'
import { mapIframePointToClient, parsePinchMessage } from './pinchForward'

// parsePinchMessage: accepts only well-formed ew-pinch payloads.
assert.deepEqual(
	parsePinchMessage({ type: 'ew-pinch', deltaX: 1, deltaY: -20, x: 100, y: 50 }),
	{ deltaX: 1, deltaY: -20, x: 100, y: 50 },
)
assert.equal(parsePinchMessage(null), null)
assert.equal(parsePinchMessage({ type: 'ew-scroll', fraction: 0.5 }), null)
assert.equal(parsePinchMessage({ type: 'ew-pinch', deltaX: 'x', deltaY: 0, x: 0, y: 0 }), null)
assert.equal(parsePinchMessage({ type: 'ew-pinch', deltaX: 0, deltaY: 0, x: 0 }), null)

// mapIframePointToClient: the iframe sits in a CSS-scaled world layer, so
// rect (visual) and clientWidth/Height (layout px) differ by the zoom factor.
// rect 200x100 at (10,20), layout 400x200 (canvas zoom 0.5) → content point
// (200,100) is the layout midpoint → rect midpoint (10+100, 20+50) = (110,70).
assert.deepEqual(
	mapIframePointToClient({ left: 10, top: 20, width: 200, height: 100 }, 400, 200, 200, 100),
	{ clientX: 110, clientY: 70 },
)
// Unscaled (zoom 1): identity offset.
assert.deepEqual(
	mapIframePointToClient({ left: 0, top: 0, width: 300, height: 150 }, 300, 150, 30, 15),
	{ clientX: 30, clientY: 15 },
)
// Zero-size layout → null (guards divide-by-zero on a collapsed iframe).
assert.equal(mapIframePointToClient({ left: 0, top: 0, width: 0, height: 0 }, 0, 0, 5, 5), null)

console.log('pinchForward.test.ts OK')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && bun src/file-viewer/pinchForward.test.ts`
Expected: FAIL — cannot resolve `./pinchForward`.

- [ ] **Step 3: Write the implementation**

`client/src/file-viewer/pinchForward.ts`:

```ts
/**
 * ew-pinch → synthetic canvas wheel (spec: docs/superpowers/specs/
 * 2026-07-15-pinch-zoom-guard-design.md). The /files/* bridge swallows a
 * pinch inside the iframe and posts {type:'ew-pinch', deltaX, deltaY, x, y}
 * (x/y in iframe-content CSS px). This module maps that point through the
 * iframe's on-screen rect (the iframe lives inside a CSS-scaled world
 * layer, so rect and clientWidth differ by the zoom factor) and re-dispatches
 * a synthetic ctrl-wheel ON the iframe element. It bubbles to whichever
 * engine container encloses it (tldraw's, or canvas-react's Viewport), which
 * handles it exactly like a real pinch — no engine-specific camera code.
 * Shared by both file-viewer components (legacy tldraw + canvas-v2).
 */

export interface PinchPayload {
	readonly deltaX: number
	readonly deltaY: number
	readonly x: number
	readonly y: number
}

/** Validate an untrusted postMessage payload; null unless a complete ew-pinch. */
export function parsePinchMessage(d: unknown): PinchPayload | null {
	if (!d || typeof d !== 'object') return null
	const p = d as Record<string, unknown>
	if (p.type !== 'ew-pinch') return null
	if (typeof p.deltaX !== 'number' || typeof p.deltaY !== 'number' || typeof p.x !== 'number' || typeof p.y !== 'number') return null
	return { deltaX: p.deltaX, deltaY: p.deltaY, x: p.x, y: p.y }
}

export interface RectLike {
	readonly left: number
	readonly top: number
	readonly width: number
	readonly height: number
}

/** Iframe-content point → parent client coordinates; null if the iframe has no layout size. */
export function mapIframePointToClient(
	rect: RectLike,
	layoutW: number,
	layoutH: number,
	x: number,
	y: number,
): { clientX: number; clientY: number } | null {
	if (layoutW <= 0 || layoutH <= 0) return null
	return {
		clientX: rect.left + (x / layoutW) * rect.width,
		clientY: rect.top + (y / layoutH) * rect.height,
	}
}

/** The thin DOM half: replay a validated pinch as a bubbling ctrl-wheel on the iframe. */
export function forwardPinchToCanvas(iframe: HTMLIFrameElement, pinch: PinchPayload): void {
	const pt = mapIframePointToClient(iframe.getBoundingClientRect(), iframe.clientWidth, iframe.clientHeight, pinch.x, pinch.y)
	if (!pt) return
	iframe.dispatchEvent(
		new WheelEvent('wheel', {
			bubbles: true,
			cancelable: true,
			ctrlKey: true,
			deltaX: pinch.deltaX,
			deltaY: pinch.deltaY,
			deltaMode: 0,
			clientX: pt.clientX,
			clientY: pt.clientY,
		}),
	)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && bun src/file-viewer/pinchForward.test.ts`
Expected: `pinchForward.test.ts OK`

- [ ] **Step 5: Commit**

```bash
git add client/src/file-viewer/pinchForward.ts client/src/file-viewer/pinchForward.test.ts
git commit -m "feat(client): pinch-forward module — ew-pinch to synthetic canvas wheel"
```

---

### Task 4: Wire ew-pinch into both file-viewer components

**Files:**
- Modify: `client/src/file-viewer/FileViewerShapeUtil.tsx` (message handler, ~lines 156–185)
- Modify: `client/src/canvas-v2/shapes/FileViewerShape.tsx` (message handler, ~lines 88–109)

Both components already have a `message` listener filtered by `e.source === iframeRef.current?.contentWindow` — the pinch branch slots in there.

- [ ] **Step 1: Legacy component**

In `client/src/file-viewer/FileViewerShapeUtil.tsx` add the import:

```ts
import { forwardPinchToCanvas, parsePinchMessage } from './pinchForward'
```

Inside `onMessage`, after the source/shape guards (right after `if (!d || typeof d !== 'object') return`), add:

```ts
			const pinch = parsePinchMessage(d)
			if (pinch) {
				// Pinch over the interactive viewer zooms the CANVAS (spec:
				// 2026-07-15-pinch-zoom-guard-design.md) — replay on the iframe
				// element so it bubbles into tldraw's own wheel/zoom path.
				if (iframeRef.current) forwardPinchToCanvas(iframeRef.current, pinch)
				return
			}
```

(Note: `d` is typed `{ type?: unknown; fraction?: unknown } | null` — `parsePinchMessage(d)` accepts `unknown`, no cast needed.)

- [ ] **Step 2: v2 component**

In `client/src/canvas-v2/shapes/FileViewerShape.tsx` add the import (note the path):

```ts
import { forwardPinchToCanvas, parsePinchMessage } from '../../file-viewer/pinchForward.js'
```

(Use the `.js` suffix — this file's local imports use it. Check whether importing from `client/src/file-viewer/` violates the repo's import-boundary audit: the audited rule is "no static import of canvas-v2 **outside** client/src/canvas-v2/" — this import points the *other* direction and is fine. `pinchForward.ts` must not import tldraw or canvas-v2 anything; it doesn't.)

Inside its `onMessage`, after `if (!d || typeof d !== 'object') return`, add the same branch:

```ts
      const pinch = parsePinchMessage(d)
      if (pinch) {
        // Pinch over the interactive viewer zooms the CANVAS (spec:
        // 2026-07-15-pinch-zoom-guard-design.md) — replay on the iframe
        // element so it bubbles into the Viewport's wheel/zoom path.
        if (iframeRef.current) forwardPinchToCanvas(iframeRef.current, pinch)
        return
      }
```

(This file uses 2-space indent; the legacy one uses tabs — match each file.)

- [ ] **Step 3: Typecheck, run client tests, commit**

Run: `bun run typecheck`
Expected: clean.

Run: `cd client && bun src/file-viewer/pinchForward.test.ts && bun src/kernel/pinchGuard.test.ts`
Expected: both OK.

```bash
git add client/src/file-viewer/FileViewerShapeUtil.tsx client/src/canvas-v2/shapes/FileViewerShape.tsx
git commit -m "feat(client): pinch over an interactive file viewer zooms the canvas (both engines)"
```

---

### Task 5: Full-suite gate + manual verification

- [ ] **Step 1: Full checks**

Run from the repo root: `bun run typecheck && bun run build && bun run test`
Expected: all green.

- [ ] **Step 2: Manual verification in the running app**

With the dev stack up (`bin/dev up`, app at `http://localhost:8080` or the offset-adjusted port), verify with a trackpad:

1. Pinch over the canvas → canvas zooms (unchanged behaviour).
2. Pinch with the pointer over the side panel / control bar → **nothing** (no browser zoom, no canvas zoom).
3. Double-click a file-viewer shape to make it interactive, pinch over its content → **canvas zooms**, anchored under the pointer (the browser must not page-zoom).
4. Plain two-finger scroll inside the interactive viewer → document scrolls as before.
5. Cmd/Ctrl-+ keyboard zoom → still browser-zooms (deliberate accessibility escape hatch). Reset with Cmd/Ctrl-0.
6. Repeat 2–3 in both a tldraw room and a v2 room (`?engine=v2` on a non-`team` room).

- [ ] **Step 3: Commit any fixes; done**

If manual verification surfaces fixes, commit them individually. No further commits needed otherwise.
