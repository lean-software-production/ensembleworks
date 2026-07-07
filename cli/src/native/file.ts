/**
 * `file open|refresh <path>` (native pair, shadows the manifest-rendered
 * `file open`/`file refresh` blunt verbs): resolves a relative path against
 * $PWD then home-relativises it — the ergonomics a generic renderer can't do
 * (it has no notion of "the agent's cwd") — and passes gateway from the env.
 * Mirrors pull-images' conn/fetch/CliError conventions; unlike the manifest's
 * verbatim-body contract, a plain run prints a short human line and reserves
 * the raw JSON body for --json.
 */
import os from 'node:os'
import path from 'node:path'
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { request } from '../http.ts'
import { emitData, emitLine } from '../output.ts'
import { readEnv, resolveConn } from '../resolve.ts'

/** Resolve a user-supplied path against cwd, then home-relativise. null = outside home. */
export function resolveFileArg(raw: string, cwd: string, home: string): string | null {
	const expanded = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw === '~' ? home : raw
	const abs = path.resolve(cwd, expanded)
	if (abs === home) return null // home itself is a directory
	if (!abs.startsWith(home + path.sep)) return null
	return abs.slice(home.length + 1)
}

interface FileFlags {
	frame?: string
	title?: string
}

function parseFileFlags(args: string[]): { positional: string[]; flags: FileFlags } {
	const positional: string[] = []
	const flags: FileFlags = {}
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--frame':
				flags.frame = args[++i]
				break
			case '--title':
				flags.title = args[++i]
				break
			default:
				positional.push(args[i] as string)
		}
	}
	return { positional, flags }
}

/** Resolve raw against $PWD/home, or throw the CliError the caller should surface. */
function resolveOrThrow(raw: string | undefined, usage: string): string {
	if (!raw) throw new CliError(usage, 2)
	const resolved = resolveFileArg(raw, process.cwd(), os.homedir())
	if (resolved === null) throw new CliError(`path resolves outside the agent home: ${raw}`, 2)
	return resolved
}

export async function fileOpen(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	const { positional, flags } = parseFileFlags(args)
	const resolved = resolveOrThrow(positional[0], 'file open requires <path> [--frame <name>] [--title <title>]')
	const conn = resolveConn({ url: globals.url, room: globals.room }, readEnv(env), loadHosts(hostsPath(env)))

	const body: Record<string, unknown> = { op: 'open', room: conn.room, path: resolved }
	if (flags.title) body.title = flags.title
	if (flags.frame) body.frame = flags.frame
	if (env.ENSEMBLEWORKS_GATEWAY_ID) body.gateway = env.ENSEMBLEWORKS_GATEWAY_ID

	const res = await request(conn, { method: 'POST', path: '/api/canvas/file-viewer', json: body })
	if (res.status < 200 || res.status >= 300) {
		emitData(res.body) // surface the server error body on stdout, exit non-zero
		return 1
	}
	if (globals.json) {
		emitData(res.body)
		return 0
	}
	const parsed = JSON.parse(res.body) as { ok: boolean; id: string }
	emitLine(`opened ${resolved} → ${parsed.id}`)
	return 0
}

export async function fileRefresh(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	const { positional } = parseFileFlags(args)
	const resolved = resolveOrThrow(positional[0], 'file refresh requires <path>')
	const conn = resolveConn({ url: globals.url, room: globals.room }, readEnv(env), loadHosts(hostsPath(env)))

	const body: Record<string, unknown> = { op: 'refresh', room: conn.room, path: resolved }
	if (env.ENSEMBLEWORKS_GATEWAY_ID) body.gateway = env.ENSEMBLEWORKS_GATEWAY_ID

	const res = await request(conn, { method: 'POST', path: '/api/canvas/file-viewer', json: body })
	if (res.status < 200 || res.status >= 300) {
		emitData(res.body) // surface the server error body on stdout, exit non-zero
		return 1
	}
	if (globals.json) {
		emitData(res.body)
		return 0
	}
	const parsed = JSON.parse(res.body) as { ok: boolean; updated: number }
	emitLine(`refreshed ${resolved} — ${parsed.updated} viewer(s)`)
	return 0
}
