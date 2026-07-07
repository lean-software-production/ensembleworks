/**
 * `terminal connect` — the native SLOT (spec §10). #4 delivers full flag
 * parsing, connection resolution (§5), a stable per-box gateway-id default (NOT
 * bare hostname — collisions would trip the server's resolveGatewayOwner
 * binding), and --dry-run (prints the config the connector WOULD use, exit 0).
 * A plain run prints a "#5" notice and exits non-zero. #5 fills the engine
 * behind resolveConnectConfig — this resolved object is its exact input, so #5
 * changes no dispatch or flag code.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitJson } from '../output.ts'
import { authHeaders, type Conn, readEnv, resolveConn } from '../resolve.ts'
import { runConnector } from '../connector/index.ts'

export interface ConnectConfig {
	url: string
	wsUrl: string
	room: string
	gatewayId: string
	label: string
	authMethod: 'service-token' | 'none'
}

export function resolveConnectConfig(conn: Conn, flags: { label?: string; gatewayId?: string }, env: NodeJS.ProcessEnv): ConnectConfig {
	const label = flags.label ?? hostname()
	const gatewayId = flags.gatewayId ?? stableGatewayId(env)
	const wsBase = conn.url.replace(/^http/, 'ws') // http→ws, https→wss
	const ws = new URL('/api/terminal/connect', wsBase.endsWith('/') ? wsBase : `${wsBase}/`)
	ws.searchParams.set('gatewayId', gatewayId)
	ws.searchParams.set('label', label)
	return { url: conn.url, wsUrl: ws.toString(), room: conn.room, gatewayId, label, authMethod: conn.auth.method }
}

export async function connectSlot(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	const flags = parseConnectFlags(args)
	const conn = resolveConn({ url: globals.url, room: globals.room }, readEnv(env), loadHosts(hostsPath(env)))
	const cfg = resolveConnectConfig(conn, flags, env)
	if (globals.dryRun) {
		emitJson(cfg)
		return 0
	}
	return runConnector(cfg, authHeaders(conn.auth), env) // conn + env already in scope
}

function parseConnectFlags(args: string[]): { label?: string; gatewayId?: string } {
	const flags: { label?: string; gatewayId?: string } = {}
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--label':
				flags.label = args[++i]
				break
			case '--gateway-id':
				flags.gatewayId = args[++i]
				break
			default:
				throw new CliError(`unknown terminal connect flag: ${args[i]}`, 2)
		}
	}
	return flags
}

/** A stable per-box gateway id: hostname + the OS machine-id (or a persisted
 *  random suffix). Two boxes sharing a hostname get distinct ids, so the
 *  server's gateway-owner identity binding never collides (charter #5). */
function stableGatewayId(env: NodeJS.ProcessEnv): string {
	const host = hostname()
	const machine = readMachineId()
	if (machine) return `${host}-${machine.slice(0, 12)}`
	const idFile = path.join(path.dirname(hostsPath(env)), 'gateway-id')
	try {
		const existing = readFileSync(idFile, 'utf8').trim()
		if (existing) return `${host}-${existing}`
	} catch {
		// fall through to mint one
	}
	const suffix = randomBytes(6).toString('hex')
	try {
		mkdirSync(path.dirname(idFile), { recursive: true })
		writeFileSync(idFile, suffix)
	} catch {
		// best-effort persistence; the id is still stable within this process
	}
	return `${host}-${suffix}`
}

function readMachineId(): string | null {
	for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
		try {
			const v = readFileSync(f, 'utf8').trim()
			if (v) return v
		} catch {
			// try the next candidate
		}
	}
	return null
}
