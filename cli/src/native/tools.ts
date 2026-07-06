/** `tools` (list) / `tools refresh`. List reads the cache/embedded snapshot
 *  (no forced network) and prints a verb table or --json. refresh forces a
 *  GET /api/tools and rewrites the cache. */
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitJson, emitTable, narrate } from '../output.ts'
import { readEnv, resolveConn } from '../resolve.ts'
import { embeddedManifest, loadManifest } from '../render/manifest.ts'

export async function tools(args: string[], flags: { url?: string; room?: string; json: boolean }, env: NodeJS.ProcessEnv): Promise<number> {
	const refresh = args[0] === 'refresh'
	// list may run without a configured instance (embedded); refresh needs one.
	let envelope
	let source = 'embedded'
	try {
		const conn = resolveConn({ url: flags.url, room: flags.room }, readEnv(env), loadHosts(hostsPath(env)))
		const loaded = await loadManifest(conn, { env, refresh })
		envelope = loaded.envelope
		source = loaded.source
	} catch (err) {
		if (refresh) throw err // refresh genuinely needs a target
		envelope = embeddedManifest()
	}
	if (refresh) {
		narrate(`refreshed ${envelope.tools.length} tools from ${source === 'network' ? 'the server' : source}`)
		return 0
	}
	if (flags.json) {
		emitJson(envelope)
		return 0
	}
	emitTable(
		['COMMAND', 'METHOD', 'PATH', 'HELP'],
		envelope.tools.map((t) => [`${t.plugin} ${t.id}`, t.method, t.path, t.help]),
	)
	return 0
}
