/**
 * Component-golden fixtures (Task G2) — a named registry of static, fully
 * offline scene descriptions the golden harness (GoldenHarness.tsx) renders
 * one at a time, driven by `?fixture=<name>` (see goldens/main.tsx). Every
 * fixture is pure data: a `Shape[]` plus an optional selection/camera/
 * presence map — NO doc, NO editor, NO sync of any kind lives here. The
 * harness is what turns one Fixture into a real (in-memory, unconnected)
 * `LoroCanvasDoc` + `Editor` + `ToolContext`.
 *
 * HONEST SCOPE (per the plan's own G2 task text): these are the states
 * renderable WITHOUT a live backend. BoxShape variants (note/text/geo/frame
 * all currently fall back to BoxShape — shapeRegistry.ts's FALLBACK POLICY;
 * D7 hasn't given the core kinds their own bodies yet, so "BoxShape variant"
 * IS the real current render for each), a rotated multi-select (outline +
 * handles), straight + curved arrows, and collaborator cursors are all pure
 * canvas-model/canvas-editor/canvas-react state with zero network
 * dependency. The six custom embed shapes' fixtures (client/src/canvas-v2/
 * shapes/*) are defined in shape-fixtures.ts — see that file's own header
 * for which of the six are safely fixturable this way and which (if any)
 * are documented as NOT fixturable rather than faked.
 */
import type { Shape } from '@ensembleworks/canvas-model'
import type { RemotePresence } from '@ensembleworks/canvas-react'

export interface Fixture {
	readonly name: string
	readonly shapes: readonly Shape[]
	readonly selection?: readonly string[]
	readonly camera?: { readonly x: number; readonly y: number; readonly z: number }
	/** Only the 'cursors' fixture sets this — a fixture presence map fed
	 * straight to canvas-react's Cursors component (no PresenceStore, no
	 * wire, just the post-adaptPresence shape it already expects). */
	readonly presence?: Readonly<Record<string, RemotePresence>>
	readonly selfKey?: string
}

const PAGE_ID = 'page:goldens'

function baseShape(over: Partial<Shape> & Pick<Shape, 'id' | 'kind'>): Shape {
	return {
		parentId: PAGE_ID,
		index: 'a1',
		x: 0,
		y: 0,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: {},
		...over,
	} as Shape
}

const richText = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

function boxKindFixture(name: string, kind: 'note' | 'text' | 'geo' | 'frame'): Fixture {
	const shape =
		kind === 'frame'
			? baseShape({ id: 'shape:f1', kind, x: 40, y: 40, props: { w: 260, h: 160, name: 'Planning' } })
			: baseShape({ id: 'shape:s1', kind, x: 40, y: 40, props: { w: 220, h: 120, richText: richText(`${kind} shape`) } })
	return { name, shapes: [shape], camera: { x: -20, y: -20, z: 1 } }
}

function arrowFixture(name: string, bend: number): Fixture {
	const anchor = baseShape({ id: 'shape:anchor', kind: 'geo', x: 40, y: 40, props: { w: 100, h: 100 } })
	const target = baseShape({ id: 'shape:target', kind: 'geo', x: 320, y: 220, props: { w: 100, h: 100 } })
	const arrow = baseShape({ id: 'shape:arrow', kind: 'arrow', x: 140, y: 90, props: { end: { x: 230, y: 180 }, bend } })
	return { name, shapes: [anchor, target, arrow], camera: { x: -20, y: -20, z: 1 } }
}

function rotatedSelectionFixture(): Fixture {
	const rotated = baseShape({ id: 'shape:rotated', kind: 'geo', x: 150, y: 100, rotation: Math.PI / 6, props: { w: 160, h: 100 } })
	const plain = baseShape({ id: 'shape:plain', kind: 'geo', x: 30, y: 260, props: { w: 100, h: 100 } })
	return { name: 'selection-rotated', shapes: [rotated, plain], selection: ['shape:rotated'], camera: { x: -20, y: -20, z: 1 } }
}

function cursorsFixture(): Fixture {
	return {
		name: 'cursors',
		shapes: [baseShape({ id: 'shape:bg', kind: 'geo', x: 40, y: 40, props: { w: 120, h: 120 } })],
		camera: { x: 0, y: 0, z: 1 },
		selfKey: 'self',
		presence: {
			self: { cursor: { x: 40, y: 40 } }, // must NOT render (self-filtered)
			'peer-a': { cursor: { x: 220, y: 140 }, name: 'Ada', color: '#4b8bf4' },
			'peer-b': { cursor: { x: 340, y: 260 } }, // no name/color -> Cursors' deterministic fallback
		},
	}
}

export const FIXTURES: Readonly<Record<string, Fixture>> = {
	'box-note': boxKindFixture('box-note', 'note'),
	'box-text': boxKindFixture('box-text', 'text'),
	'box-geo': boxKindFixture('box-geo', 'geo'),
	'box-frame': boxKindFixture('box-frame', 'frame'),
	'selection-rotated': rotatedSelectionFixture(),
	'arrow-straight': arrowFixture('arrow-straight', 0),
	'arrow-curved': arrowFixture('arrow-curved', 40),
	cursors: cursorsFixture(),
}

export { PAGE_ID }
