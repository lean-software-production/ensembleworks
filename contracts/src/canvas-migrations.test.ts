/** Store migration: file-viewer→web-viewer retype; iframe→text link. Run: bun contracts/src/canvas-migrations.test.ts */
import assert from 'node:assert/strict'
import { webViewerMigrations } from './canvas-migrations.js'

// The sequence exposes its migrations; apply the store-scoped `up` by hand to
// a serialized-store object, the way tldraw will at snapshot-load time.
const up = webViewerMigrations.sequence[0].up as (store: Record<string, any>) => void

{
	const store: Record<string, any> = {
		'shape:fv1': {
			typeName: 'shape', id: 'shape:fv1', type: 'file-viewer',
			x: 0, y: 0, rotation: 0, index: 'a1', parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
			props: { w: 720, h: 540, path: 'docs/report.html', title: 'report.html', rev: 3 },
		},
	}
	up(store)
	const s = store['shape:fv1']
	assert.equal(s.type, 'web-viewer', 'file-viewer records are retyped')
	assert.equal(s.props.kind, 'file', 'retyped records default to kind file')
	assert.equal(s.props.path, 'docs/report.html', 'path survives')
	assert.equal(s.props.rev, 3, 'rev survives')
}

{
	const store: Record<string, any> = {
		'shape:if1': {
			typeName: 'shape', id: 'shape:if1', type: 'iframe',
			x: 10, y: 20, rotation: 0, index: 'a2', parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
			props: { w: 800, h: 600, url: 'http://localhost:3000/', title: 'vite' },
		},
	}
	up(store)
	const s = store['shape:if1']
	assert.equal(s.type, 'text', 'iframe records become text shapes')
	const json = JSON.stringify(s.props.richText)
	assert.ok(json.includes('http://localhost:3000/'), 'URL is the text')
	assert.ok(json.includes('"link"'), 'URL is link-marked')
	assert.equal(s.x, 10, 'position survives')
}

{
	// Untouched records pass through unchanged.
	const rec = { typeName: 'shape', id: 'shape:n1', type: 'note', props: { color: 'yellow' } }
	const store: Record<string, any> = { 'shape:n1': structuredClone(rec) }
	up(store)
	assert.deepEqual(store['shape:n1'], rec, 'other shapes untouched')
}

console.log('canvas-migrations.test.ts OK')
