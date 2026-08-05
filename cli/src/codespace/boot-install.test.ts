// boot-install (SP4 decision #3): pure unit-file generation (ExecStart for
// compiled vs dev, restart policy, default.target install), XDG-honoring unit
// path, the Linux-only guard (platform injected), and --dry-run printing
// { unitPath, unitText, enableArgv } without touching systemctl or the FS.
// Run with: bun src/codespace/boot-install.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliError } from '../errors.ts'
import { bootExecStart, bootUnitText, codespaceBootInstall, unitPath } from './boot-install.ts'

// ExecStart: compiled → the ew binary itself; dev → bun + the abs main.ts.
{
	assert.equal(bootExecStart(true, '/usr/local/bin/ew', '/repo/cli/src/main.ts'), '/usr/local/bin/ew codespace reconcile')
	assert.equal(bootExecStart(false, '/usr/bin/bun', '/repo/cli/src/main.ts'), '/usr/bin/bun /repo/cli/src/main.ts codespace reconcile')
}

// Unit text: the full systemd contract, line-exact.
{
	const text = bootUnitText('/usr/local/bin/ew codespace reconcile')
	assert.equal(text, `[Unit]
Description=EnsembleWorks Codespaces reconciler
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart=/usr/local/bin/ew codespace reconcile
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`)
}

// Unit path: XDG_CONFIG_HOME honored; ~/.config fallback.
{
	assert.equal(
		unitPath({ XDG_CONFIG_HOME: '/tmp/cfg' } as NodeJS.ProcessEnv),
		path.join('/tmp/cfg', 'systemd', 'user', 'ensembleworks-codespaces.service'),
	)
	assert.ok(unitPath({} as NodeJS.ProcessEnv).endsWith(path.join('.config', 'systemd', 'user', 'ensembleworks-codespaces.service')))
}

// Linux-only guard (platform injected — testable on any host).
await assert.rejects(
	() => codespaceBootInstall([], { refresh: false, json: false, dryRun: true, help: false }, process.env, 'darwin'),
	(e: unknown) => e instanceof CliError && e.exitCode === 2 && /Linux-only/.test(e.message),
	'non-linux platforms are refused with the v1 boundary message',
)

// --dry-run: prints unitPath + unitText + the exact systemctl argvs; writes nothing.
{
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-boot-'))
	const env = { ...process.env, XDG_CONFIG_HOME: tmp } as NodeJS.ProcessEnv
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	let code: number
	try {
		code = await codespaceBootInstall([], { refresh: false, json: false, dryRun: true, help: false }, env, 'linux')
	} finally {
		;(process.stdout as any).write = realOut
	}
	assert.equal(code, 0)
	const printed = JSON.parse(outChunks.join(''))
	assert.equal(printed.unitPath, path.join(tmp, 'systemd', 'user', 'ensembleworks-codespaces.service'))
	assert.ok(printed.unitText.includes('ExecStart='), 'full unit text in the plan')
	assert.ok(printed.unitText.includes('codespace reconcile'))
	assert.deepEqual(printed.daemonReloadArgv, ['systemctl', '--user', 'daemon-reload'])
	assert.deepEqual(printed.enableArgv, ['systemctl', '--user', 'enable', 'ensembleworks-codespaces.service'])
	assert.ok(!existsSync(printed.unitPath), 'dry-run writes nothing')
}

// Unknown flags refused.
await assert.rejects(
	() => codespaceBootInstall(['--frobnicate'], { refresh: false, json: false, dryRun: true, help: false }, process.env, 'linux'),
	/unknown codespace boot-install flag/,
)

console.log('ok: boot-install — ExecStart modes, exact unit text, XDG path, linux guard, dry-run')
