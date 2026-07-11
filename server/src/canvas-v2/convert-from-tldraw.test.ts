// Converter seam D: tldraw store records → @ensembleworks/canvas-model
// CanvasDocument. Fixture mirrors getCurrentSnapshot().documents.map(d =>
// d.state) shapes — flat records, no store machinery involved.
// Run with: bun src/canvas-v2/convert-from-tldraw.test.ts
import assert from 'node:assert/strict'
import { fromTldraw } from './convert.ts'

const records = [
	{ typeName: 'document', id: 'document:document' },
	{ typeName: 'page', id: 'page:p', name: 'Page 1', index: 'a1', meta: {} },
	{
		typeName: 'shape',
		id: 'shape:f',
		type: 'frame',
		parentId: 'page:p',
		index: 'a1',
		x: 0,
		y: 0,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: { name: 'Planning', w: 400, h: 300, color: 'black' },
	},
	{
		typeName: 'shape',
		id: 'shape:n',
		type: 'note',
		parentId: 'shape:f',
		index: 'a1',
		x: 10,
		y: 10,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: {
			color: 'yellow',
			richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
		},
	},
	{
		typeName: 'shape',
		id: 'shape:term',
		type: 'terminal',
		parentId: 'page:p',
		index: 'a2',
		x: 0,
		y: 0,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: { w: 640, h: 480, sessionId: 'abc', title: 't' },
	},
	{
		typeName: 'shape',
		id: 'shape:ar',
		type: 'arrow',
		parentId: 'page:p',
		index: 'a3',
		x: 0,
		y: 0,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: { color: 'black' },
	},
	// A native tldraw group (Ctrl+G): a structural container with empty props.
	// Must survive conversion — dropping it would orphan its children's parentId.
	{
		typeName: 'shape',
		id: 'shape:grp',
		type: 'group',
		parentId: 'shape:f',
		index: 'a4',
		x: 5,
		y: 5,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: {},
	},
	{ typeName: 'binding', id: 'binding:1', type: 'arrow', fromId: 'shape:ar', toId: 'shape:f', meta: {}, props: { terminal: 'start' } },
	{ typeName: 'binding', id: 'binding:2', type: 'arrow', fromId: 'shape:ar', toId: 'shape:n', meta: {}, props: { terminal: 'end' } },
	{ typeName: 'asset', id: 'asset:x', props: { src: 'http://x' } },
	// Edge cases: an unknown shape type and a non-arrow binding type must both
	// be dropped, never smuggled into the model.
	{
		typeName: 'shape',
		id: 'shape:bogus',
		type: 'sticky-legacy',
		parentId: 'page:p',
		index: 'a9',
		x: 0,
		y: 0,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		meta: {},
		props: {},
	},
	{ typeName: 'binding', id: 'binding:weird', type: 'weird', fromId: 'shape:ar', toId: 'shape:f', meta: {}, props: {} },
]

const doc = fromTldraw(records)
assert.deepEqual(
	doc.pages.map((p) => p.id),
	['page:p']
)
assert.equal(doc.shapes.length, 5) // 5 shapes, asset/page/document/bogus excluded
assert.equal(doc.byId.get('shape:term')!.kind, 'terminal') // custom shape preserved
assert.equal(doc.byId.get('shape:grp')!.kind, 'group') // native group survives (container, not dropped)
assert.equal((doc.byId.get('shape:n')!.props as any).richText.content[0].content[0].text, 'hi') // richText verbatim
assert.equal(doc.byId.get('shape:bogus'), undefined) // unknown shape type dropped
assert.equal(doc.bindings.length, 2) // non-arrow binding dropped
assert.ok(!doc.bindings.some((b) => b.id === 'binding:weird'), 'non-arrow binding type dropped')
console.log('ok: fromTldraw')
