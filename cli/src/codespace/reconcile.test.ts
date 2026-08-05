// reconcile, the network-free half (SP4 decision #2): planning walks the
// store, targets ONLY desired-up entries, skips missing checkouts with a
// reason, ignores desired-stopped/unmanaged records, resolves each entry's
// conn from its OWN stored canvasUrl, and the printed --dry-run plan is
// secret-free. Live parallel supervision is covered by the manual rehearsal
// (spawns docker) — planning is the testable brain.
// Run with: bun src/codespace/reconcile.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codespaceReconcile, planReconcile } from './reconcile.ts'
import { codespacesPath, saveCodespaces, type CodespacesFile } from './store.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-reconcile-'))
const env = {
	...process.env,
	XDG_CONFIG_HOME: path.join(tmp, 'config'),
	XDG_DATA_HOME: path.join(tmp, 'data'),
	EW_CONNECTOR_BIN: path.join(tmp, 'stub-connector'),
	ENSEMBLEWORKS_TOKEN_ID: 'tid.access',
	ENSEMBLEWORKS_TOKEN_SECRET: 'sekrit-token-value',
} as NodeJS.ProcessEnv
writeFileSync(path.join(tmp, 'stub-connector'), '#!/bin/sh\n')

// A real checkout for the healthy desired-up entry.
const repoDir = path.join(tmp, 'liverepo')
mkdirSync(repoDir)
Bun.spawnSync(['git', 'init', '-b', 'main', repoDir])
Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'x'], { cwd: repoDir })
const liveKey = realpathSync(repoDir)

const store: CodespacesFile = {
	codespaces: {
		[liveKey]: { gatewayId: 'cs-liverepo-aabbccdd', repo: 'liverepo', branch: 'main', canvasUrl: 'http://localhost:8788', desired: 'up' },
		'/gone/checkout': { gatewayId: 'cs-checkout-99887766', repo: 'checkout', branch: 'main', canvasUrl: 'http://localhost:8788', desired: 'up' },
		'/stopped/one': { gatewayId: 'cs-one-11223344', repo: 'one', branch: '', canvasUrl: 'http://localhost:8788', desired: 'stopped' },
		'/unmanaged/two': { gatewayId: 'cs-two-55667788', repo: 'two', branch: '', canvasUrl: 'http://localhost:8788' },
	},
}
saveCodespaces(codespacesPath(env), store)

// planReconcile: one target (with a full UpPlan), one skip, nothing else.
{
	const plan = await planReconcile(env)
	assert.equal(plan.targets.length, 1, 'only the live desired-up entry is a target')
	const t = plan.targets[0]!
	assert.equal(t.workspaceFolder, liveKey)
	assert.equal(t.plan.gatewayId, 'cs-liverepo-aabbccdd', 'reuses the stored id, never re-mints')
	assert.ok(t.plan.upArgv.includes('--workspace-folder'), 'carries the full SP2 UpPlan')
	// targets[].conn deliberately carries the LIVE token pair (the engine needs
	// it and it is never printed); every printable part must be secret-free.
	assert.ok(!JSON.stringify(plan.targets.map((x) => x.plan)).includes('sekrit-token-value'), 'the printable UpPlans are secret-free')
	assert.ok(!JSON.stringify(plan.skipped).includes('sekrit-token-value'))
	assert.deepEqual(plan.skipped, [{ workspaceFolder: '/gone/checkout', reason: 'checkout missing' }])
}

// The slot: --dry-run prints that plan as JSON, exit 0, no spawning.
{
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	let code: number
	try {
		code = await codespaceReconcile([], { refresh: false, json: false, dryRun: true, help: false }, env)
	} finally {
		;(process.stdout as any).write = realOut
	}
	assert.equal(code, 0)
	const printed = JSON.parse(outChunks.join(''))
	assert.equal(printed.targets.length, 1)
	assert.equal(printed.targets[0].plan.gatewayId, 'cs-liverepo-aabbccdd')
	assert.equal(printed.skipped.length, 1)
	assert.ok(!outChunks.join('').includes('sekrit-token-value'), 'dry-run output is secret-free')
}

// Empty/no-target store: exit 0 quietly (idempotent no-op) — both dry and live
// (live with zero targets spawns nothing, so it is safe to call here).
{
	saveCodespaces(codespacesPath(env), { codespaces: {} })
	assert.equal(await codespaceReconcile([], { refresh: false, json: false, dryRun: true, help: false }, env), 0)
	assert.equal(await codespaceReconcile([], { refresh: false, json: false, dryRun: false, help: false }, env), 0, 'live no-op exits 0 without supervising')
}

// Unknown flags refused.
await assert.rejects(
	() => codespaceReconcile(['--frobnicate'], { refresh: false, json: false, dryRun: true, help: false }, env),
	/unknown codespace reconcile flag/,
)

console.log('ok: reconcile plan — desired filtering, missing-checkout skip, stored-id reuse, secret-free, no-op exit')
