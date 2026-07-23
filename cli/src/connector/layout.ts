/**
 * Session-layout persistence (SP4 decision #4, design §5.6 — recover INTENT,
 * not processes): on SIGTERM the pty-backend connector snapshots
 * { sessions: [{ id, cwd, scrollbackTail }] } to $HOME/.ensembleworks-layout.json
 * INSIDE the container (state B: survives stop→start, dies on rebuild —
 * honest per design §5.3); on start it pre-seeds the session manager so known
 * sessions respawn in their last cwd and replay the persisted tail as history.
 * Parsing is defensive: any malformed input → null (cold start, never a crash).
 */
import { readlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Bytes of scrollback persisted per session — a quarter of the live 256 KiB
 *  ring: enough history to be useful, small enough to write on SIGTERM. */
export const LAYOUT_TAIL_CAP = 64 * 1024

export interface LayoutSessionEntry {
	id: string
	/** last known cwd (from /proc/<pid>/cwd); absent when unreadable. */
	cwd?: string
	/** base64 of the capped scrollback tail (raw terminal bytes ≠ JSON-safe). */
	scrollbackTail: string
}

export interface LayoutSnapshot {
	version: 1
	sessions: LayoutSessionEntry[]
}

export function serializeLayout(snap: LayoutSnapshot): string {
	return `${JSON.stringify(snap)}\n`
}

/** null on ANY malformed input — a corrupt layout means a cold start. */
export function parseLayout(raw: string | null): LayoutSnapshot | null {
	if (!raw) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const obj = parsed as { version?: unknown; sessions?: unknown }
	if (obj.version !== 1 || !Array.isArray(obj.sessions)) return null
	const sessions: LayoutSessionEntry[] = []
	for (const e of obj.sessions) {
		if (typeof e !== 'object' || e === null) return null
		const { id, cwd, scrollbackTail } = e as { id?: unknown; cwd?: unknown; scrollbackTail?: unknown }
		if (typeof id !== 'string' || id.length === 0) return null
		if (cwd !== undefined && typeof cwd !== 'string') return null
		if (typeof scrollbackTail !== 'string') return null
		sessions.push(cwd === undefined ? { id, scrollbackTail } : { id, cwd, scrollbackTail })
	}
	return { version: 1, sessions }
}

/** Concatenate ring chunks and keep only the last `cap` bytes (the TAIL). */
export function capTail(ring: readonly Buffer[], cap: number = LAYOUT_TAIL_CAP): Buffer {
	const all = Buffer.concat(ring)
	return all.byteLength <= cap ? all : all.subarray(all.byteLength - cap)
}

/** ENSEMBLEWORKS_LAYOUT_FILE override (tests) → $HOME/.ensembleworks-layout.json. */
export function layoutFilePath(env: NodeJS.ProcessEnv): string {
	return env.ENSEMBLEWORKS_LAYOUT_FILE ?? path.join(env.HOME ?? os.homedir(), '.ensembleworks-layout.json')
}

/** Read a live child's cwd from /proc (Linux — which a devcontainer always is);
 *  undefined on any failure (dead pid, no /proc, no pid at all). */
export function readProcCwd(pid: number | undefined): string | undefined {
	if (!pid) return undefined
	try {
		return readlinkSync(`/proc/${pid}/cwd`)
	} catch {
		return undefined
	}
}
