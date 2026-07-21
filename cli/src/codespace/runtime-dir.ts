/**
 * Connector staging (decisions #3/#4): resolve the connector binary
 * (EW_CONNECTOR_BIN override → the running compiled ew binary itself → refuse
 * with the build hint), then stage it as
 * <XDG_DATA_HOME|~/.local/share>/ensembleworks/ew-runtime/ensembleworks — the
 * dir `devcontainer up` bind-mounts at /ew. Upgrading the connector is a
 * one-file swap host-side (design §2.1). v1 arch boundary (decision #10): the
 * staged binary is the bun-compiled glibc x64 build; a musl or arm64 container
 * will fail to exec /ew/ensembleworks — documented, not detected.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliError } from '../errors.ts'

export function runtimeDir(env: NodeJS.ProcessEnv): string {
	const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
	return path.join(dataHome, 'ensembleworks', 'ew-runtime')
}

export function resolveConnectorBin(env: NodeJS.ProcessEnv, compiled: boolean): string {
	const override = env.EW_CONNECTOR_BIN
	if (override) {
		if (!existsSync(override)) throw new CliError(`EW_CONNECTOR_BIN points at a missing file: ${override}`, 2)
		return override
	}
	if (compiled) return process.execPath // the one ew binary is also the connector (design §2.2)
	throw new CliError(
		'no connector binary: running from source — build one with `bun run --filter @ensembleworks/cli build:binary` and/or set EW_CONNECTOR_BIN',
		2,
	)
}

/** Copy the connector into the runtime dir as `ensembleworks`, exec bit set. */
export function stageRuntimeDir(dir: string, connectorBin: string): string {
	mkdirSync(dir, { recursive: true })
	const dest = path.join(dir, 'ensembleworks')
	copyFileSync(connectorBin, dest)
	chmodSync(dest, 0o755)
	return dest
}
