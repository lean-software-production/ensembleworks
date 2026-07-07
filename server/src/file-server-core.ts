/**
 * file-server core — serve one file from inside rootDir, raw bytes, read-only.
 * Path safety: decode, resolve, then realpath (symlinks) and require the result
 * stays under rootDir. Directories 404 (no listings in v1). CORS * because
 * documents fetch sibling assets from an opaque-origin iframe; no-store because
 * the file on disk IS the document (no stale caches after a refresh).
 */
import { realpath, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8',
	'.markdown': 'text/markdown; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.csv': 'text/csv; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.pdf': 'application/pdf',
	'.map': 'application/json; charset=utf-8',
}

export interface ServedFile {
	status: number
	headers: Record<string, string>
	body: Uint8Array | null
}

const BASE_HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }

export async function serveFile(rootDir: string, rawPath: string): Promise<ServedFile> {
	let decoded: string
	try {
		decoded = decodeURIComponent(rawPath)
	} catch {
		return { status: 400, headers: { ...BASE_HEADERS }, body: null }
	}
	const root = await realpath(rootDir)
	const resolved = path.resolve(root, decoded)
	// Cheap reject before touching the fs: the resolved lexical path must stay
	// under root (catches ../ and absolute paths).
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return { status: 403, headers: { ...BASE_HEADERS }, body: null }
	}
	let real: string
	try {
		real = await realpath(resolved) // resolves symlinks; throws if missing
	} catch {
		return { status: 404, headers: { ...BASE_HEADERS }, body: null }
	}
	// Symlink escape: the REAL location must also stay under root.
	if (real !== root && !real.startsWith(root + path.sep)) {
		return { status: 403, headers: { ...BASE_HEADERS }, body: null }
	}
	const st = await stat(real)
	if (st.isDirectory()) return { status: 404, headers: { ...BASE_HEADERS }, body: null }
	const type = TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream'
	const body = new Uint8Array(await readFile(real))
	return { status: 200, headers: { ...BASE_HEADERS, 'content-type': type }, body }
}
