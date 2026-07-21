// codespace up, the network-free half (decision #5): argv shapes for
// up/exec (mount string, --remove-existing-container on rebuild, --remote-env
// creds, the pty connector invocation), REDACTED secrets in the printable
// plan, parseUpResult against the spike-verified stdout shape, and the
// --dry-run slot. Run with: bun src/codespace/up.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliError } from '../errors.ts'
import type { Conn } from '../resolve.ts'
import { runnerFor } from './devcontainers-cli.ts'
import { buildExecArgv, buildUpArgv, codespaceUp, parseUpResult, resolveUpPlan } from './up.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-up-'))
const conn: Conn = {
	url: 'http://localhost:8788',
	room: 'team',
	auth: { method: 'service-token', tokenId: 'tid.access', tokenSecret: 'sekrit-token-value' },
}
const runner = runnerFor('dev', '/v/devcontainer.js', '/usr/bin/ew')

// buildUpArgv: workspace + the /ew bind mount; rebuild appends the remove flag.
{
	const argv = buildUpArgv(runner, '/work/myrepo', '/data/ew-runtime', false)
	assert.deepEqual(argv, [
		'bun', '/v/devcontainer.js', 'up',
		'--workspace-folder', '/work/myrepo',
		'--mount', 'type=bind,source=/data/ew-runtime,target=/ew',
	])
	const rebuild = buildUpArgv(runner, '/work/myrepo', '/data/ew-runtime', true)
	assert.ok(rebuild.includes('--remove-existing-container'), 'rebuild = up + --remove-existing-container (decision #7)')
}

// buildExecArgv: remote-env creds, the pty connector invocation, redaction.
{
	const rec = { gatewayId: 'cs-myrepo-0a1b2c3d', repo: 'myrepo', branch: 'main' }
	const real = buildExecArgv(runner, '/work/myrepo', conn, rec, { redact: false })
	assert.deepEqual(real, [
		'bun', '/v/devcontainer.js', 'exec',
		'--workspace-folder', '/work/myrepo',
		'--remote-env', 'ENSEMBLEWORKS_URL=http://localhost:8788',
		'--remote-env', 'ENSEMBLEWORKS_TOKEN_ID=tid.access',
		'--remote-env', 'ENSEMBLEWORKS_TOKEN_SECRET=sekrit-token-value',
		'--', '/ew/ensembleworks', 'terminal', 'connect',
		'--backend', 'pty',
		'--gateway-id', 'cs-myrepo-0a1b2c3d',
		'--label', 'myrepo@main',
		'--repo', 'myrepo',
		'--branch', 'main',
	])
	const redacted = buildExecArgv(runner, '/work/myrepo', conn, rec, { redact: true })
	assert.ok(redacted.includes('ENSEMBLEWORKS_TOKEN_SECRET=REDACTED'), 'secret redacted')
	assert.ok(!JSON.stringify(redacted).includes('sekrit-token-value'), 'no secret leaks into the printable form')

	// A none-auth instance sends only the URL; branchless repos get a bare label.
	const none = buildExecArgv(runner, '/w', { url: 'http://x', room: 'team', auth: { method: 'none' } }, { gatewayId: 'g', repo: 'r', branch: '' }, { redact: false })
	assert.ok(!none.some((a) => a.includes('TOKEN')), 'none auth → no token remote-env')
	assert.ok(none.includes('--label') && none[none.indexOf('--label') + 1] === 'r', 'branchless label is just the repo')
	assert.ok(!none.includes('--branch'), 'no empty --branch flag')
}

// parseUpResult: the spike-verified shape, with progress noise above it.
{
	const ok = parseUpResult('pulling image…\nsome log line\n{"outcome":"success","containerId":"eff5bf192158","remoteUser":"root","remoteWorkspaceFolder":"/workspaces/testrepo"}\n')
	assert.equal(ok.containerId, 'eff5bf192158')
	assert.equal(ok.remoteUser, 'root')

	assert.throws(
		() => parseUpResult('{"outcome":"error","message":"Dockerfile exploded"}\n'),
		(e: unknown) => e instanceof CliError && /Dockerfile exploded/.test(e.message),
		'failure outcome surfaces the message',
	)
	assert.throws(
		() => parseUpResult('no json here at all\n'),
		(e: unknown) => e instanceof CliError && /no outcome JSON/.test(e.message),
		'garbage stdout refused',
	)
}

// resolveUpPlan + the --dry-run slot, end to end but network-free: temp git
// repo, isolated XDG dirs, EW_CONNECTOR_BIN pointing at a stub.
{
	const repoDir = path.join(tmp, 'planrepo')
	mkdirSync(repoDir)
	Bun.spawnSync(['git', 'init', '-b', 'main', repoDir])
	Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'x'], { cwd: repoDir })
	const stub = path.join(tmp, 'stub-connector')
	writeFileSync(stub, '#!/bin/sh\n')
	const env = {
		...process.env,
		XDG_CONFIG_HOME: path.join(tmp, 'config'),
		XDG_DATA_HOME: path.join(tmp, 'data'),
		EW_CONNECTOR_BIN: stub,
		ENSEMBLEWORKS_URL: conn.url,
		ENSEMBLEWORKS_TOKEN_ID: conn.auth.method === 'service-token' ? conn.auth.tokenId : '',
		ENSEMBLEWORKS_TOKEN_SECRET: conn.auth.method === 'service-token' ? conn.auth.tokenSecret : '',
	} as NodeJS.ProcessEnv

	const plan = await resolveUpPlan(conn, repoDir, env, { removeExisting: false })
	assert.equal(plan.workspaceFolder, realpathSync(repoDir))
	assert.match(plan.gatewayId, /^cs-planrepo-[0-9a-f]{8}$/)
	assert.equal(plan.repo, 'planrepo')
	assert.equal(plan.branch, 'main')
	assert.equal(plan.connectorBin, stub)
	assert.equal(plan.runtimeDir, path.join(tmp, 'data', 'ensembleworks', 'ew-runtime'))
	assert.equal(plan.upArgv[0], 'bun', 'dev-mode runner')
	assert.ok(plan.upArgv.includes(`type=bind,source=${plan.runtimeDir},target=/ew`))
	assert.ok(plan.execArgv.includes('ENSEMBLEWORKS_TOKEN_SECRET=REDACTED'), 'plan.execArgv is the printable, redacted form')
	assert.ok(!JSON.stringify(plan).includes('sekrit-token-value'), 'the whole printable plan is secret-free')

	// The slot: --dry-run prints the plan JSON, exit 0, no spawning.
	const prevCwd = process.cwd()
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	try {
		process.chdir(repoDir)
		const code = await codespaceUp([], { refresh: false, json: false, dryRun: true, help: false }, env, { removeExisting: false })
		assert.equal(code, 0, '--dry-run exits 0')
	} finally {
		;(process.stdout as any).write = realOut
		process.chdir(prevCwd)
	}
	const printed = JSON.parse(outChunks.join(''))
	assert.equal(printed.gatewayId, plan.gatewayId, 'dry-run reuses the persisted id (stable across runs)')
	assert.ok(!outChunks.join('').includes('sekrit-token-value'), 'dry-run output is secret-free')

	// Unknown own-flags refused (exit-2 CliError).
	await assert.rejects(
		() => codespaceUp(['--frobnicate'], { refresh: false, json: false, dryRun: true, help: false }, env, { removeExisting: false }),
		/unknown codespace up flag/,
	)
}

console.log('ok: codespace up plan — argv shapes, redaction, parseUpResult, --dry-run slot')
