/** `version`: the CLI build + the connected server's build string (from the
 *  manifest envelope's `.server`). --json emits { cli, server }. Never fails on
 *  a missing/unreachable instance — server falls back to a note. */
import { CLI_BUILD } from '../build.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitJson, emitLine } from '../output.ts'
import { readEnv, resolveConn } from '../resolve.ts'
import { loadManifest } from '../render/manifest.ts'

export async function version(flags: { url?: string; room?: string; json: boolean }, env: NodeJS.ProcessEnv): Promise<number> {
	let server = 'unknown (no reachable instance)'
	try {
		const conn = resolveConn({ url: flags.url, room: flags.room }, readEnv(env), loadHosts(hostsPath(env)))
		const { envelope } = await loadManifest(conn, { env })
		server = envelope.server
	} catch {
		// leave the default note
	}
	if (flags.json) emitJson({ cli: CLI_BUILD, server })
	else {
		emitLine(`ensembleworks ${CLI_BUILD}`)
		emitLine(`server ${server}`)
	}
	return 0
}
