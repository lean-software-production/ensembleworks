/**
 * Manifest resolution (spec §6.3): a cache hit at
 * ~/.cache/ensembleworks/manifest-<key>.json whose format version matches is
 * USED AS-IS (never auto-refetched — charter). A miss / --refresh / version
 * mismatch tries GET <url>/api/tools and rewrites the cache. Offline or a
 * still-mismatched fetch falls back to the EMBEDDED SNAPSHOT — buildManifest
 * over the compiled-in allTools from @ensembleworks/contracts (static import;
 * compile-safe). The cache is data, not trust: http.toRequestUrl validates
 * every entry path same-origin at render time.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	allTools,
	buildManifest,
	MANIFEST_VERSION,
	type ManifestEnvelope,
} from '@ensembleworks/contracts'
import { CLI_BUILD } from '../build.ts'
import { authHeaders, type Conn } from '../resolve.ts'
import { toRequestUrl } from '../http.ts'

export interface ManifestSource {
	envelope: ManifestEnvelope
	source: 'cache' | 'network' | 'embedded'
	/** The cache file backing this envelope, or '' for network/embedded — passed
	 *  to http.request as the poisoned-cache hint when rendering a cached verb. */
	cacheFile: string
}

export function cacheKey(url: string): string {
	return url.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function cachePath(url: string, env: NodeJS.ProcessEnv = process.env): string {
	const cacheHome = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
	return path.join(cacheHome, 'ensembleworks', `manifest-${cacheKey(url)}.json`)
}

export function embeddedManifest(): ManifestEnvelope {
	return buildManifest(allTools, CLI_BUILD)
}

export async function loadManifest(
	conn: Conn,
	opts: { refresh?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<ManifestSource> {
	const env = opts.env ?? process.env
	const file = cachePath(conn.url, env)

	if (!opts.refresh) {
		const cached = readCache(file)
		if (cached && cached.version === MANIFEST_VERSION) return { envelope: cached, source: 'cache', cacheFile: file }
	}

	try {
		const fetched = await fetchManifest(conn)
		if (fetched.version === MANIFEST_VERSION) {
			writeCache(file, fetched)
			return { envelope: fetched, source: 'network', cacheFile: '' }
		}
	} catch {
		// offline / non-2xx → fall through to the embedded snapshot
	}

	return { envelope: embeddedManifest(), source: 'embedded', cacheFile: '' }
}

function readCache(file: string): ManifestEnvelope | null {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as ManifestEnvelope
		if (parsed && typeof parsed.version === 'number' && Array.isArray(parsed.tools)) return parsed
	} catch {
		// miss / unreadable / malformed → treat as no cache
	}
	return null
}

function writeCache(file: string, envelope: ManifestEnvelope): void {
	mkdirSync(path.dirname(file), { recursive: true })
	writeFileSync(file, JSON.stringify(envelope))
}

async function fetchManifest(conn: Conn): Promise<ManifestEnvelope> {
	const url = toRequestUrl(conn.url, '/api/tools')
	const res = await fetch(url, { headers: authHeaders(conn.auth) })
	if (!res.ok) throw new Error(`GET /api/tools → ${res.status}`)
	return (await res.json()) as ManifestEnvelope
}
