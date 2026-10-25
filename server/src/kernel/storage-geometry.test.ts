// Run: bun src/kernel/storage-geometry.test.ts
// Locks the storage-geometry contract: the DATA_DIR / DATABASE_DIR /
// DATABASE_BACKUPS_DIR triple is required, and every collision shape that can
// reproduce the 2026-07-10 backup-over-live-DB corruption is refused.
import assert from 'node:assert/strict'
import { resolveStorageGeometry } from './storage-geometry.ts'

const PROD = {
	DATA_DIR: '/home/ensembleworks/data',
	DATABASE_DIR: '/var/lib/ensembleworks/databases',
	DATABASE_BACKUPS_DIR: '/home/ensembleworks/data/database-backups',
}

// Happy path: the prod shape resolves, normalized.
{
	const g = resolveStorageGeometry({ ...PROD, DATABASE_DIR: '/var/lib/ensembleworks/databases/' })
	assert.equal(g.dataDir, '/home/ensembleworks/data')
	assert.equal(g.databaseDir, '/var/lib/ensembleworks/databases', 'trailing slash normalized')
	assert.equal(g.databaseBackupsDir, '/home/ensembleworks/data/database-backups')
}

// Happy path: sibling scratch dirs (the deploy boot-check / dev shape).
resolveStorageGeometry({
	DATA_DIR: '/tmp/scratch-a',
	DATABASE_DIR: '/tmp/scratch-b',
	DATABASE_BACKUPS_DIR: '/tmp/scratch-c',
})

// DATABASE_BACKUPS_DIR inside DATA_DIR is the EXPECTED prod shape — allowed.
resolveStorageGeometry(PROD)

// Missing vars: every absent key is named in one error.
assert.throws(
	() => resolveStorageGeometry({ DATA_DIR: '/d' }),
	/unset: DATABASE_DIR, DATABASE_BACKUPS_DIR/,
	'names all missing vars at once',
)
assert.throws(() => resolveStorageGeometry({}), /DATA_DIR, DATABASE_DIR, DATABASE_BACKUPS_DIR/)
assert.throws(
	() => resolveStorageGeometry({ ...PROD, DATABASE_DIR: '   ' }),
	/unset: DATABASE_DIR/,
	'whitespace-only counts as unset',
)

// The incident's geometry: DATABASE_DIR falling inside DATA_DIR.
assert.throws(
	() => resolveStorageGeometry({ ...PROD, DATABASE_DIR: '/home/ensembleworks/data/rooms' }),
	/DATABASE_DIR .* and DATA_DIR .* coincide or nest/,
	'live DBs inside the data root refused',
)
// ...and the inverse nesting.
assert.throws(
	() => resolveStorageGeometry({ ...PROD, DATA_DIR: '/var/lib/ensembleworks/databases/data' }),
	/DATABASE_DIR .* and DATA_DIR .* coincide or nest/,
	'data root inside the live-DB dir refused',
)

// Live == backup destination, equality and both nestings.
assert.throws(
	() => resolveStorageGeometry({ ...PROD, DATABASE_BACKUPS_DIR: '/var/lib/ensembleworks/databases' }),
	/DATABASE_DIR .* and DATABASE_BACKUPS_DIR .* coincide/,
	'backup dest == live dir refused',
)
assert.throws(
	() =>
		resolveStorageGeometry({
			...PROD,
			DATABASE_BACKUPS_DIR: '/var/lib/ensembleworks/databases/backups',
		}),
	/DATABASE_DIR .* and DATABASE_BACKUPS_DIR .* coincide or nest/,
	'backup dest inside live dir refused',
)
assert.throws(
	() =>
		resolveStorageGeometry({
			...PROD,
			DATABASE_DIR: '/home/ensembleworks/data/database-backups/live',
		}),
	/coincide or nest/,
	'live dir inside backup dest refused',
)

// Multiple violations surface together in one error.
assert.throws(
	() =>
		resolveStorageGeometry({
			DATA_DIR: '/x',
			DATABASE_DIR: '/x',
			DATABASE_BACKUPS_DIR: '/x',
		}),
	(e: Error) =>
		/DATABASE_BACKUPS_DIR/.test(e.message) && /DATA_DIR/.test(e.message),
	'all violated rules reported in one boot attempt',
)

// Containment is path-segment aware: /a/bc is NOT inside /a/b.
resolveStorageGeometry({
	DATA_DIR: '/srv/ew',
	DATABASE_DIR: '/srv/ew-databases',
	DATABASE_BACKUPS_DIR: '/srv/ew/backups',
})

console.log('ok: storage-geometry contract')
