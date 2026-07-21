// codespaces.json store (decision #6): XDG-honoring path, JSON round-trip,
// cs-<dirname>-<hash8(realpath)> minting (stable per checkout, distinct per
// clone), ensure keeps an existing gatewayId/containerId across re-ups, and
// updateContainerId persists. Run with: bun src/codespace/store.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	codespacesPath,
	ensureCodespaceRecord,
	loadCodespaces,
	mintGatewayId,
	saveCodespaces,
	setDesired,
	updateContainerId,
} from './store.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-codespaces-'))

// Path: XDG_CONFIG_HOME wins; falls back under ~/.config.
assert.equal(
	codespacesPath({ XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv),
	path.join(dir, 'ensembleworks', 'codespaces.json'),
)
assert.ok(codespacesPath({} as NodeJS.ProcessEnv).endsWith(path.join('.config', 'ensembleworks', 'codespaces.json')))

// Minting: cs-<dirname>-<8 hex>, deterministic, distinct per realpath.
{
	const a = mintGatewayId('/home/u/work/ensembleworks')
	assert.match(a, /^cs-ensembleworks-[0-9a-f]{8}$/)
	assert.equal(a, mintGatewayId('/home/u/work/ensembleworks'), 'deterministic')
	const b = mintGatewayId('/home/u/other/ensembleworks')
	assert.notEqual(a, b, 'two clones of the same repo get distinct ids')
}

// Absent file → empty store; round-trip; ensure mints once then reuses.
const file = path.join(dir, 'ensembleworks', 'codespaces.json')
assert.deepEqual(loadCodespaces(file), { codespaces: {} }, 'absent file is an empty store')

const first = ensureCodespaceRecord(file, '/home/u/work/ensembleworks', {
	repo: 'ensembleworks',
	branch: 'main',
	canvasUrl: 'http://localhost:8788',
})
assert.match(first.gatewayId, /^cs-ensembleworks-[0-9a-f]{8}$/)
assert.equal(first.containerId, undefined)

updateContainerId(file, '/home/u/work/ensembleworks', 'deadbeef'.repeat(8))
const second = ensureCodespaceRecord(file, '/home/u/work/ensembleworks', {
	repo: 'ensembleworks',
	branch: 'feature/x', // branch moved — record follows, identity does not
	canvasUrl: 'http://localhost:8788',
})
assert.equal(second.gatewayId, first.gatewayId, 're-up reuses the minted id (reattach, never duplicate)')
assert.equal(second.containerId, 'deadbeef'.repeat(8), 'containerId survives ensure')
assert.equal(second.branch, 'feature/x', 'branch metadata refreshed')

const reloaded = loadCodespaces(file)
assert.deepEqual(reloaded.codespaces['/home/u/work/ensembleworks'], second, 'round-trips losslessly')

// SP4 desired-state (decision #1): optional field, round-trips, setDesired
// flips it in place, missing records are a silent no-op, and ensure PRESERVES
// an existing desired (a re-up's metadata refresh must not undo a 'stopped').
{
	setDesired(file, '/home/u/work/ensembleworks', 'up')
	let rec = loadCodespaces(file).codespaces['/home/u/work/ensembleworks']!
	assert.equal(rec.desired, 'up')
	assert.equal(rec.containerId, 'deadbeef'.repeat(8), 'setDesired touches only desired')

	setDesired(file, '/home/u/work/ensembleworks', 'stopped')
	assert.equal(loadCodespaces(file).codespaces['/home/u/work/ensembleworks']!.desired, 'stopped')

	setDesired(file, '/no/such/checkout', 'up') // no record → no-op, no throw
	assert.equal(loadCodespaces(file).codespaces['/no/such/checkout'], undefined)

	const after = ensureCodespaceRecord(file, '/home/u/work/ensembleworks', {
		repo: 'ensembleworks',
		branch: 'main',
		canvasUrl: 'http://localhost:8788',
	})
	assert.equal(after.desired, 'stopped', 'ensure (dry-run path) preserves desired — only the live engine flips it')
}

console.log('ok: codespaces store — XDG path, mint format/stability, ensure/update round-trip, desired-state')
