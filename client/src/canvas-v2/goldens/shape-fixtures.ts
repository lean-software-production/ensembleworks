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

// --- Task C7: component goldens for the four core rich bodies -------------
// note/frame/text/geo (canvas-react/src/shapes/{Note,Frame,Text,Geo}Shape.tsx,
// registered by GoldenHarness.tsx's registerCoreShapes() call — see that
// file's own Task C7 comment for why that call is load-bearing: without it
// every one of these renders as the generic BoxShape fallback instead). A
// general-purpose shape builder (unlike embedShape above, these need
// per-shape `x`/`w`/`h` for multi-shape galleries, and some need `meta` for
// the note author badge).
function richText(text: string) {
	return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

function coreShape(
	id: string,
	kind: string,
	x: number,
	w: number,
	h: number,
	props: Record<string, unknown> = {},
	meta: Record<string, unknown> = {},
): Shape {
	return {
		id, kind, parentId: PAGE_ID, index: 'a1', x, y: 40, rotation: 0,
		isLocked: false, opacity: 1, meta, props: { w, h, ...props },
	} as Shape
}

// note: bounds DoD #1's representative states — a couple of colors (yellow/
// blue/green), one WITH `meta.author` set (the corner author badge,
// NoteShape.tsx's `authorOf`) and two without, all showing the handwriting
// font (NoteShape.tsx's fixed `HANDWRITING_FONT`, no per-note override).
function noteColorsFixture(): Fixture {
	const yellow = coreShape('shape:note-yellow', 'note', 40, 180, 140, {
		color: 'yellow',
		richText: richText('Yellow sticky'),
	})
	const blue = coreShape('shape:note-blue', 'note', 260, 180, 140, {
		color: 'blue',
		richText: richText('Blue sticky (authored)'),
	}, { author: 'Ada Lovelace' })
	const green = coreShape('shape:note-green', 'note', 480, 180, 140, {
		color: 'green',
		richText: richText('Green sticky'),
	})
	return { name: 'note-colors', shapes: [yellow, blue, green], camera: CAMERA }
}

// frame: bounds DoD #1's "frame with a label" — non-empty `props.name`
// rendered by FrameShape.tsx's header chrome (as opposed to fixtures.ts's
// own `box-frame`, which also sets a name but predates this task and lives
// in the OTHER fixture registry this task was told not to touch).
function frameLabeledFixture(): Fixture {
	const frame = coreShape('shape:frame-labeled', 'frame', 40, 260, 160, { name: 'Sprint Planning' })
	return { name: 'frame-labeled', shapes: [frame], camera: CAMERA }
}

// text: a STYLED text shape (non-default font/size/color/align) to exercise
// TextShape.tsx's full prop-resolution path, not just its defaults — default
// font/size/color/align are already covered by fixtures.ts's `box-text`.
function textStyledFixture(): Fixture {
	const text = coreShape('shape:text-styled', 'text', 40, 320, 140, {
		richText: richText('Styled text body'),
		color: 'violet',
		font: 'serif',
		size: 'l',
		textAlign: 'end',
	})
	return { name: 'text-styled', shapes: [text], camera: CAMERA }
}

// geo: the four SPECIAL_CASED_VARIANTS GeoShape.tsx draws with real geometry
// (rectangle/ellipse/triangle/diamond), plus one variant NOT in that set
// (hexagon) to lock in the documented rectangle-outline FALLBACK path too —
// each filled/labeled so both the SVG geometry and the centered label render.
function geoVariantsFixture(): Fixture {
	const rectangle = coreShape('shape:geo-rectangle', 'geo', 40, 120, 100, {
		geo: 'rectangle', color: 'blue', fill: 'solid', richText: richText('rectangle'),
	})
	const ellipse = coreShape('shape:geo-ellipse', 'geo', 200, 120, 100, {
		geo: 'ellipse', color: 'orange', fill: 'solid', richText: richText('ellipse'),
	})
	const triangle = coreShape('shape:geo-triangle', 'geo', 360, 120, 100, {
		geo: 'triangle', color: 'green', fill: 'solid', richText: richText('triangle'),
	})
	const diamond = coreShape('shape:geo-diamond', 'geo', 520, 120, 100, {
		geo: 'diamond', color: 'violet', fill: 'solid', richText: richText('diamond'),
	})
	const fallback = coreShape('shape:geo-fallback', 'geo', 680, 120, 100, {
		geo: 'hexagon', color: 'red', fill: 'solid', richText: richText('hexagon (fallback)'),
	})
	return {
		name: 'geo-variants',
		shapes: [rectangle, ellipse, triangle, diamond, fallback],
		camera: CAMERA,
	}
}

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
	'note-colors': noteColorsFixture(),
	'frame-labeled': frameLabeledFixture(),
	'text-styled': textStyledFixture(),
	'geo-variants': geoVariantsFixture(),
}
