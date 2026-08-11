// stop/list (decision #7): stop's argv is docker stop <exact stored id> (never
// a filter), --dry-run prints it without spawning, a missing record refuses
// with exit 2; list renders the store as rows (LIVE column only when a live-id
// set is supplied) and --json emits the raw records. Network-free.
// Run with: bun src/codespace/stop-list.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderListRows } from './list.ts'
import { codespaceStop, buildStopArgv } from './stop.ts'
import { codespacesPath, saveCodespaces, type CodespacesFile } from './store.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-stoplist-'))
const env = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, 'config') } as NodeJS.ProcessEnv

const workDir = path.join(tmp, 'stoprepo')
mkdirSync(workDir)
const realWork = realpathSync(workDir)
const store: CodespacesFile = {
	codespaces: {
		[realWork]: {
			gatewayId: 'cs-stoprepo-11223344',
			containerId: 'eff5bf19215854c3e8f20d46b787690f',
			repo: 'stoprepo',
			branch: 'main',
			canvasUrl: 'http://localhost:8788',
		},
		'/elsewhere/other': {
			gatewayId: 'cs-other-99887766',
			repo: 'other',
			branch: '',
			canvasUrl: 'http://localhost:8788',
		},
	},
}
saveCodespaces(codespacesPath(env), store)

// buildStopArgv: the exact stored id, nothing else.
assert.deepEqual(buildStopArgv('abc123'), ['docker', 'stop', 'abc123'])

// stop --dry-run from inside the checkout: prints the exact argv, exit 0.
{
	const prevCwd = process.cwd()
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	try {
		process.chdir(workDir)
		const code = await codespaceStop([], { refresh: false, json: false, dryRun: true, help: false }, env)
		assert.equal(code, 0)
	} finally {
		;(process.stdout as any).write = realOut
		process.chdir(prevCwd)
	}
	const printed = JSON.parse(outChunks.join(''))
	assert.deepEqual(printed.stopArgv, ['docker', 'stop', 'eff5bf19215854c3e8f20d46b787690f'], 'exact stored id — never a filter')
	assert.equal(printed.gatewayId, 'cs-stoprepo-11223344')
}

// stop with no record for the cwd: exit-2 CliError with the up hint.
{
	const bare = path.join(tmp, 'norecord')
	mkdirSync(bare)
	const prevCwd = process.cwd()
	try {
		process.chdir(bare)
		await assert.rejects(
			() => codespaceStop([], { refresh: false, json: false, dryRun: true, help: false }, env),
			/no known container .* ew codespace up/,
		)
	} finally {
		process.chdir(prevCwd)
	}
}

// renderListRows: one row per record; LIVE column only with a live-id set.
{
	const rows = renderListRows(store)
	assert.equal(rows.length, 2)
	const stopRow = rows.find((r) => r[0] === 'cs-stoprepo-11223344')
	assert.ok(stopRow)
	assert.equal(stopRow[1], 'stoprepo@main')
	assert.equal(stopRow[2], 'eff5bf192158', 'containerId shown short')
	const otherRow = rows.find((r) => r[0] === 'cs-other-99887766')
	assert.ok(otherRow)
	assert.equal(otherRow[1], 'other', 'branchless repo renders bare')
	assert.equal(otherRow[2], '-', 'no container yet')

	const live = renderListRows(store, new Set(['cs-stoprepo-11223344']))
	assert.equal(live.find((r) => r[0] === 'cs-stoprepo-11223344')?.at(-1), 'yes')
	assert.equal(live.find((r) => r[0] === 'cs-other-99887766')?.at(-1), 'no')
}

console.log('ok: stop/list — exact-id stop argv, dry-run, missing-record refusal, list rows')
