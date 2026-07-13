/**
 * Component-golden fixtures for the six custom canvas-v2 shape bodies (Task
 * G2) — see fixtures.ts's module header for the harness/registry contract
 * these plug into the same way.
 *
 * SURVEY FINDINGS (a dedicated read of all six bodies before writing these,
 * per-shape, cited by file:line):
 *   - ALL SIX render real DOM with no live backend and never throw/hang —
 *     none is "genuinely un-fixturable."
 *   - terminal (TerminalShape.tsx): `props: {}` is schema-valid (every field
 *     defaulted by `terminalContentFrom`); the initial React state is
 *     `{status:'connecting'}`, rendering the "Connecting…" overlay
 *     (TerminalShape.tsx's `overlayText`/status!=='open' branch) — the mount
 *     effect's `new WebSocket(...)` fires against a gateway that doesn't
 *     exist in this offline harness and simply fails to open, which is
 *     EXACTLY the natural disconnected state, not a special case.
 *   - screenshare (ScreenshareShape.tsx): `props: {}` defaulted by
 *     `screenshareContentFrom`; `resolveScreenTrack` returns `{kind:
 *     'connecting'}` whenever the module-level `room` (client/src/
 *     screenshare/store.ts) is null — which it always is unless something
 *     calls `setScreenShareRoom` (nothing does here) — rendering "connecting…"
 *     with zero LiveKit object needed at all.
 *   - iframe (IframeShape.tsx): always renders a real `<iframe src={url}>`;
 *     `url: 'about:blank'` is deterministic and needs no network.
 *   - neko (NekoShape.tsx): the header/mute chrome renders regardless of the
 *     iframe's own content, but there is NO dedicated "no session" branch —
 *     unlike the other five. Its iframe src is built from `base` (default
 *     `/shared-browser/`, which resolves to nothing offline) — pointing
 *     `base` at `/canvas-v2-fixtures/neko-splash.html` (a static page at
 *     client/canvas-v2-fixtures/ — the Vite project ROOT, served by the DEV
 *     server only; deliberately NOT client/public/, which `vite build`
 *     copies verbatim into every production dist — see that HTML file's own
 *     LOCATION IS LOAD-BEARING note) makes the WHOLE render deterministic,
 *     not just the chrome. Documented here rather than silently faked: this
 *     is the one shape whose golden needs an explicit same-origin fixture
 *     page, not just empty/default props.
 *   - roadmap (RoadmapShape.tsx): `props: {}` defaults everything; first
 *     paint (before its fetch effect settles) shows "loading…", and a
 *     same-origin `/api/roadmap/doc` 404 (no roadmap ever pushed in this
 *     harness's room) settles into the explicit "No roadmap data yet" empty
 *     state — both are real, non-thrown DOM.
 *   - file-viewer (FileViewerShape.tsx): `props: { path: '' }` (the default)
 *     is the MOST deterministic of all six — its `path ? <iframe> : <div>no
 *     file</div>` branch needs no network at all when `path` is empty.
 */
import type { Shape } from '@ensembleworks/canvas-model'
import type { Fixture } from './fixtures.js'

const PAGE_ID = 'page:goldens'

function embedShape(id: string, kind: string, w: number, h: number, props: Record<string, unknown> = {}): Shape {
	return {
		id, kind, parentId: PAGE_ID, index: 'a1', x: 40, y: 40, rotation: 0,
		isLocked: false, opacity: 1, meta: {}, props: { w, h, ...props },
	} as Shape
}

const CAMERA = { x: -20, y: -20, z: 1 }

export const SHAPE_FIXTURES: Readonly<Record<string, Fixture>> = {
	'terminal-connecting': {
		name: 'terminal-connecting',
		shapes: [embedShape('shape:terminal-1', 'terminal', 480, 320)],
		camera: CAMERA,
	},
	'screenshare-no-track': {
		name: 'screenshare-no-track',
		shapes: [embedShape('shape:screenshare-1', 'screenshare', 480, 320)],
		camera: CAMERA,
	},
	'iframe-blank': {
		name: 'iframe-blank',
		shapes: [embedShape('shape:iframe-1', 'iframe', 480, 320, { url: 'about:blank' })],
		camera: CAMERA,
	},
	'neko-splash': {
		name: 'neko-splash',
		shapes: [embedShape('shape:neko-1', 'neko', 480, 320, { base: '/canvas-v2-fixtures/neko-splash.html' })],
		camera: CAMERA,
	},
	'roadmap-empty': {
		name: 'roadmap-empty',
		shapes: [embedShape('shape:roadmap-1', 'roadmap', 480, 320, { roadmapId: 'golden-fixture-nonexistent' })],
		camera: CAMERA,
	},
	'file-viewer-empty': {
		name: 'file-viewer-empty',
		shapes: [embedShape('shape:file-viewer-1', 'file-viewer', 480, 320, { path: '' })],
		camera: CAMERA,
	},
}
