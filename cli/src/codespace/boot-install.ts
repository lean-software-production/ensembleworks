/**
 * `ew codespace boot-install` (SP4 decision #3; design §5.5 / open decision 4
 * resolved): reboot survival for runtime-injected codespaces NEEDS a host-side
 * unit — docker restart policies cannot re-inject the connector. Linux-only
 * v1: write ~/.config/systemd/user/ensembleworks-codespaces.service running
 * `reconcile`, `systemctl --user daemon-reload` + `enable` it. Deliberately
 * NOT `enable --now`: starting reconcile mid-install would race a foreground
 * `ew codespace up` supervisor for the same gateway — the narration says how
 * to start it. Note systemd USER units run at login, not boot; the narration
 * also points at `loginctl enable-linger` for true boot-time start.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { emitJson, narrate } from '../output.ts'
import { runningCompiled } from './devcontainers-cli.ts'

export const BOOT_UNIT_NAME = 'ensembleworks-codespaces.service'

/** Pure: the ExecStart line. Compiled → the ew binary is the whole command;
 *  dev checkout → bun + the absolute main.ts (systemd wants absolute paths). */
export function bootExecStart(compiled: boolean, execPath: string, mainTsPath: string): string {
	return compiled ? `${execPath} codespace reconcile` : `${execPath} ${mainTsPath} codespace reconcile`
}

/** Pure: the full unit text (line-exact — the test pins it). */
export function bootUnitText(execStart: string): string {
	return `[Unit]
Description=EnsembleWorks Codespaces reconciler
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart=${execStart}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`
}

export function unitPath(env: NodeJS.ProcessEnv): string {
	const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
	return path.join(configHome, 'systemd', 'user', BOOT_UNIT_NAME)
}

export async function codespaceBootInstall(
	args: string[],
	globals: Globals,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): Promise<number> {
	if (args.length > 0) throw new CliError(`unknown codespace boot-install flag: ${args[0]}`, 2)
	if (platform !== 'linux') {
		throw new CliError('codespace boot-install is Linux-only in v1 (systemd user service); a macOS login item is deferred', 2)
	}
	const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url)) // dev-mode only; compiled never reads it
	const execStart = bootExecStart(runningCompiled(), process.execPath, mainTsPath)
	const file = unitPath(env)
	const unitText = bootUnitText(execStart)
	const daemonReloadArgv = ['systemctl', '--user', 'daemon-reload']
	const enableArgv = ['systemctl', '--user', 'enable', BOOT_UNIT_NAME]
	if (globals.dryRun) {
		emitJson({ unitPath: file, unitText, daemonReloadArgv, enableArgv })
		return 0
	}
	mkdirSync(path.dirname(file), { recursive: true })
	writeFileSync(file, unitText)
	for (const argv of [daemonReloadArgv, enableArgv]) {
		const res = Bun.spawnSync(argv, { stdout: 'inherit', stderr: 'inherit' })
		if (res.exitCode !== 0) throw new CliError(`${argv.join(' ')} exited ${res.exitCode}`, 1)
	}
	narrate(`ensembleworks: installed + enabled ${BOOT_UNIT_NAME} (${file})`)
	narrate('ensembleworks: it starts at your next login — start now with: systemctl --user start ensembleworks-codespaces.service')
	narrate('ensembleworks: to run before login after reboot, enable lingering: loginctl enable-linger $USER')
	return 0
}
