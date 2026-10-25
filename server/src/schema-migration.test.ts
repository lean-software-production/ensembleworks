/** Snapshot with legacy file-viewer + iframe records loads and migrates. Run: bun server/src/schema-migration.test.ts */
import assert from 'node:assert/strict'
import { schema } from './schema.ts'

const snapshot = {
	'document:document': { typeName: 'document', id: 'document:document', gridSize: 10, name: '', meta: {} },
	'page:page': { typeName: 'page', id: 'page:page', name: 'Page 1', index: 'a1', meta: {} },
	'shape:fv': {
		typeName: 'shape', id: 'shape:fv', type: 'file-viewer',
		x: 0, y: 0, rotation: 0, index: 'a1', parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
		props: { w: 720, h: 540, path: 'a/b.html', title: 'b.html', rev: 1 },
	},
}
const result = schema.migrateStoreSnapshot({
	schema: { schemaVersion: 2, sequences: {} }, // ancient empty schema → all retroactive sequences apply
	store: structuredClone(snapshot) as any,
})
assert.equal(result.type, 'success', `migration succeeds (got ${JSON.stringify((result as any).reason ?? '')})`)
const store = (result as any).value
assert.equal(store['shape:fv'].type, 'web-viewer', 'file-viewer retyped on snapshot load')
console.log('schema-migration.test.ts OK')
