/** `canvas pull-images <frame> [dir]` (native composition, §6.4): GET the frame,
 *  download every /uploads/* asset to <dir> (a temp dir by default), print each
 *  local path one per line (its bin/canvas contract). /dev/... iframe urls are
 *  skipped — only stored uploads are downloadable. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { request, toRequestUrl } from '../http.ts'
import { emitData, emitLine, narrate } from '../output.ts'
import { authHeaders, readEnv, resolveConn } from '../resolve.ts'

export async function pullImages(args: string[], flags: { url?: string; room?: string }, env: NodeJS.ProcessEnv): Promise<number> {
	const frame = args[0]
	const dirArg = args[1]
	if (!frame) throw new CliError('pull-images requires <frame> [dir]', 2)
	const conn = resolveConn({ url: flags.url, room: flags.room }, readEnv(env), loadHosts(hostsPath(env)))

	const res = await request(conn, { method: 'GET', path: '/api/canvas/frame', query: { room: conn.room, name: frame } })
	if (res.status < 200 || res.status >= 300) {
		emitData(res.body) // surface the server error body on stdout, exit non-zero
		return 1
	}

	const dir = dirArg || mkdtempSync(path.join(os.tmpdir(), 'ew-frame-'))
	mkdirSync(dir, { recursive: true })
	const urls = [...res.body.matchAll(/"url":"(\/uploads\/[^"]+)"/g)].map((m) => m[1] as string)
	if (urls.length === 0) {
		narrate(`no images in frame ${frame}`)
		return 0
	}
	for (const u of urls) {
		const dest = path.join(dir, path.basename(u))
		const dl = await fetch(toRequestUrl(conn.url, u), { headers: authHeaders(conn.auth) })
		if (!dl.ok) {
			narrate(`failed to download ${u}: ${dl.status}`)
			continue
		}
		writeFileSync(dest, Buffer.from(await dl.arrayBuffer()))
		emitLine(dest)
	}
	return 0
}
