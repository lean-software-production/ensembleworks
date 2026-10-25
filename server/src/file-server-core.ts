/**
 * file-server core — serve one file from inside rootDir, raw bytes, read-only.
 * Path safety: decode, resolve, then realpath (symlinks) and require the result
 * stays under rootDir. Directories 404 (no listings in v1). CORS * because
 * documents fetch sibling assets from an opaque-origin iframe; no-store because
 * the file on disk IS the document (no stale caches after a refresh).
 *
 * Bodies are streamed (never read whole into memory) and byte ranges are
 * honoured, so <video>/<audio> can seek and a 300 MB recording costs one fd,
 * not 300 MB of heap.
 */
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import type { Readable } from 'node:stream'

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
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.m4a': 'audio/mp4',
	'.mp3': 'audio/mpeg',
}

export interface ServedFile {
	status: number
	headers: Record<string, string>
	/** Node stream for a served body; null for every error status. */
	body: Readable | null
}

export interface ServeOptions {
	/** The request's inbound `Range` header, verbatim. */
	range?: string | null
}

const BASE_HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }

/**
 * Parse a single-range `bytes=` header against a known size.
 * Returns null when the header is absent/unparseable/multi-range (caller then
 * serves the whole file, per RFC 9110 §14.2 "ignore what you don't grok"), or
 * 'unsatisfiable' when it parses but falls outside the file.
 */
function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
	if (!header) return null
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (!m) return null // multi-range or another unit: serve the whole file
	const [, rawStart, rawEnd] = m
	if (rawStart === '' && rawEnd === '') return null
	let start: number
	let end: number
	if (rawStart === '') {
		// suffix range: the last N bytes
		const suffix = Number(rawEnd)
		if (suffix === 0) return 'unsatisfiable'
		start = Math.max(0, size - suffix)
		end = size - 1
	} else {
		start = Number(rawStart)
		end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
	}
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null
	if (start >= size || end < start) return 'unsatisfiable'
	return { start, end }
}

export async function serveFile(rootDir: string, rawPath: string, opts: ServeOptions = {}): Promise<ServedFile> {
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
	// TOCTOU: v1 accepts the realpath->read race (single-user home, localhost only).
	const st = await stat(real)
	if (st.isDirectory()) return { status: 404, headers: { ...BASE_HEADERS }, body: null }
	const type = TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream'
	const size = st.size
	const headers: Record<string, string> = { ...BASE_HEADERS, 'content-type': type, 'accept-ranges': 'bytes' }

	const range = parseRange(opts.range, size)
	if (range === 'unsatisfiable') {
		return { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` }, body: null }
	}
	if (range) {
		const length = range.end - range.start + 1
		return {
			status: 206,
			headers: {
				...headers,
				'content-range': `bytes ${range.start}-${range.end}/${size}`,
				'content-length': String(length),
			},
			body: createReadStream(real, { start: range.start, end: range.end }),
		}
	}
	return {
		status: 200,
		headers: { ...headers, 'content-length': String(size) },
		body: createReadStream(real),
	}
}

/**
 * Write a ServedFile to a node response: pipes the body, and for HEAD (or any
 * body-less status) destroys the stream so the fd is not leaked.
 */
export function sendServedFile(res: ServerResponse, served: ServedFile, method = 'GET'): void {
	res.writeHead(served.status, served.headers)
	if (!served.body) return void res.end()
	if (method === 'HEAD') {
		served.body.destroy()
		return void res.end()
	}
	served.body.on('error', () => res.destroy())
	served.body.pipe(res)
}
