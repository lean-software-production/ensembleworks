# Pinch-zoom guard — design

Date: 2026-07-15
Status: approved (approach A of the brainstorm)

## Problem

A trackpad pinch is delivered by browsers as a `wheel` event with
`ctrlKey: true`. Both canvas engines (legacy tldraw and canvas-v2's
`canvas-react/src/Viewport.tsx`) attach a non-passive wheel listener to the
**canvas container only**, `preventDefault()` the ctrl/meta+wheel, and turn
the gesture into camera zoom. Anywhere else in the app window nothing
prevents the default, so the browser applies **native page zoom** — the side
panel and control bar scale away and the user "loses" the UI. Two leak
paths:

1. **Fixed chrome** (side panel, control bar, drawers, menus): wheel events
   bubble to the document unhandled.
2. **Interactive file viewer**: the viewer content is an `<iframe>`
   (`/files/*`, served by `server/src/files-render.ts`). Wheel events inside
   an iframe are delivered to the *iframe's* document and never propagate to
   the parent page, so no parent-side listener can catch them. The
   unselected case works only because the shape's idle overlay
   (`pointer-events: none` on the iframe) keeps events in the parent.

## Desired behaviour

- **Pinch over anything in world space** — canvas, shapes, including inside
  an interactive file viewer — zooms the **canvas**, anchored under the
  pointer. (This removes today's inconsistency where the same viewer
  behaves differently selected vs. unselected.)
- **Pinch over fixed chrome** (side panel, control bar, drawers) does
  **nothing**: no browser zoom, no canvas zoom.
- **Browser viewport zoom never fires anywhere in the app window** from the
  pinch/wheel gesture path. Keyboard zoom (Cmd/Ctrl-+/−/0) is deliberately
  untouched — it remains available for accessibility.

## Design (approach A: layered guards + synthetic wheel forwarding)

### 1. App-level pinch guard (fixes chrome leak, both engines)

A small module, `client/src/kernel/pinchGuard.ts`, exporting
`installPinchGuard(win: Window): () => void`:

- Adds a **non-passive, capture-phase** `wheel` listener on `window` that
  calls `e.preventDefault()` when `e.ctrlKey || e.metaKey`.
  `preventDefault()` does not stop propagation, so the canvas containers'
  own listeners still receive and handle the event — canvas zoom is
  unaffected; the guard only removes the browser's default everywhere else.
- Adds `gesturestart` / `gesturechange` / `gestureend` listeners (Safari's
  proprietary non-wheel pinch path) that call `preventDefault()`.
  Registered unconditionally; browsers without these events simply never
  fire them.
- Returns an uninstall function (symmetry for tests; the app installs once).

Installed once from `client/src/App.tsx` in a `useEffect`. Engine-agnostic:
covers tldraw rooms and v2 rooms identically.

### 2. Iframe guard + pinch forwarding (fixes file-viewer leak)

**Bridge script** (`BRIDGE_SCRIPT` in `server/src/files-render.ts`, already
injected into every `/files/*` document): add a non-passive `wheel`
listener; when `ctrlKey || metaKey`:

- `preventDefault()` (kills browser zoom inside the iframe document), and
- `parent.postMessage({ type: 'ew-pinch', deltaX, deltaY, x: clientX,
  y: clientY }, '*')` — same ew-prefixed one-IIFE style as the existing
  scroll bridge (spec R6 of the file-viewer design still holds: no globals,
  never a broken document).

Non-pinch wheel events (plain scrolling) are ignored by the listener and
scroll the document as today.

**Parent forwarding** in both file-viewer components
(`client/src/file-viewer/FileViewerShapeUtil.tsx` and
`client/src/canvas-v2/shapes/FileViewerShape.tsx`), inside their existing
`message` handlers (both already filter on
`e.source === iframeRef.current?.contentWindow`): on `ew-pinch`,

1. Map iframe-content coordinates to parent screen coordinates. The iframe
   sits inside a CSS-scaled world layer, so:
   `rect = iframe.getBoundingClientRect()`;
   `clientX = rect.left + (x / iframe.clientWidth) * rect.width` (same for
   Y with `clientHeight`/`rect.height`). Skip if `clientWidth`/
   `clientHeight` is 0.
2. Dispatch a synthetic
   `new WheelEvent('wheel', { bubbles: true, cancelable: true,
   ctrlKey: true, deltaX, deltaY, deltaMode: 0, clientX, clientY })`
   **on the iframe element**. It bubbles up through the world layer to
   whichever engine container encloses it — tldraw's container listener or
   the v2 `Viewport` listener — which handles it exactly like a real pinch,
   reusing each engine's existing zoom-anchoring math. No engine-specific
   camera code in the shapes.

The coordinate mapping is extracted as a pure function (e.g.
`mapIframePointToClient(rect, innerW, innerH, x, y)`) shared by both
components and unit-tested.

Notes:
- The capture-phase guard from part 1 also sees the synthetic event and
  `preventDefault()`s it — harmless (it is `cancelable` and untrusted, so
  there is no browser default anyway).
- The synthetic event is dispatched in the parent document and cannot
  re-enter the iframe: no feedback loop.
- Message payloads are validated (numeric fields) before use, matching the
  existing handlers' defensive style.

## Testing

- `pinchGuard`: unit test that ctrl-wheel events get `defaultPrevented` and
  plain wheel events don't; uninstall removes the listeners.
- Coordinate mapper: pure unit tests (scaled rect, zero-size guard).
- Bridge script: extend `server/src/files-render.test.ts`'s existing
  string-level assertions (pinch listener present, `ew-pinch` type posted).
- Manual/e2e verification in the running app: pinch over side panel (no
  zoom anywhere), over canvas (canvas zoom, unchanged), over an interactive
  file viewer (canvas zoom anchored under pointer), plain two-finger scroll
  inside the viewer still scrolls the document.

## Known limitations (accepted)

- Iframes whose content we don't serve (`IframeShape` pointing at a
  third-party dev server, neko, etc.) cannot be injected into; pinch over
  those while interactive will still browser-zoom. Only EW-served content
  is fixable this way; the file viewer is the reported case.
- Browser zoom via keyboard shortcuts remains possible by design
  (accessibility escape hatch).
