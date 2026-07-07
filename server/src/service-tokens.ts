/**
 * Server-side service-token config map: a CF Access service token's common_name
 * → a bot identity + write scope. Operator config, NOT server data (and it holds
 * no secrets — CF Access validates the token; this only names the
 * already-authenticated caller), so it lives in the config folder alongside the
 * deploy's *.env files, not DATA_DIR. Read + mtime-cached so edits are picked up
 * without a restart; a missing or unparseable file recognises no tokens
 * (fail closed). Scope is parsed and stored here but ENFORCED in a later slice.
 */
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ServiceTokenEntry {
	identity: string
	scope: 'read-only' | 'read-write'
}

function configPath(): string {
	const override = process.env.EW_SERVICE_TOKENS_FILE
	if (override) return override
	const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
	return path.join(base, 'ensembleworks', 'service-tokens.toml')
}

let cache: { path: string; mtimeMs: number; map: Map<string, ServiceTokenEntry> } | null = null

function load(): Map<string, ServiceTokenEntry> {
	const p = configPath()
	let mtimeMs: number
	try {
		mtimeMs = statSync(p).mtimeMs
	} catch {
		// Missing/unreadable file → empty map (the "none"-instance case).
		if (!(cache && cache.path === p && cache.mtimeMs === -1)) cache = { path: p, mtimeMs: -1, map: new Map() }
		return cache.map
	}
	if (cache && cache.path === p && cache.mtimeMs === mtimeMs) return cache.map

	const map = new Map<string, ServiceTokenEntry>()
	try {
		const parsed = Bun.TOML.parse(readFileSync(p, 'utf8')) as { tokens?: Record<string, unknown> }
		for (const [commonName, raw] of Object.entries(parsed.tokens ?? {})) {
			const e = (raw ?? {}) as Record<string, unknown>
			const identity = typeof e.identity === 'string' ? e.identity : null
			if (!identity) continue // an entry without an identity is ignored
			const scope: ServiceTokenEntry['scope'] = e.scope === 'read-write' ? 'read-write' : 'read-only'
			map.set(commonName, { identity, scope })
		}
	} catch (err) {
		console.warn(`[service-tokens] failed to parse ${p} — recognising no tokens`, err)
		// fall through with the empty map (fail closed)
	}
	cache = { path: p, mtimeMs, map }
	return map
}

export function lookupServiceToken(commonName: string): ServiceTokenEntry | null {
	return load().get(commonName) ?? null
}
