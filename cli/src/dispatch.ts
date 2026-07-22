/**
 * Global-flag extraction + the three-layer dispatch (spec §6.1):
 *   1. native single-word groups: version, auth, tools, help
 *   2. native (group, verb) pairs: terminal connect, canvas pull-images,
 *      file open, file refresh (checked BEFORE the manifest so they win over
 *      like-named future verbs)
 *   3. manifest-rendered: <group> matches a plugin and <verb> a tool id
 *   4. extension (Layer 2): ensembleworks-<group> from the TRUSTED
 *      ~/.config/ensembleworks/extensions/ dir ONLY (never bare PATH — it
 *      inherits live credentials), exec'd with the resolved-connection env
 *   5. error: unknown group/verb → stderr + exit 2, with a did-you-mean.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { login } from './auth/login.ts'
import { logout } from './auth/logout.ts'
import { status } from './auth/status.ts'
import { codespaceGroup } from './codespace/index.ts'
import { CliError } from './errors.ts'
import { hostsPath } from './hosts.ts'
import { connectSlot } from './native/connect.ts'
import { fileOpen, fileRefresh } from './native/file.ts'
import { pullImages } from './native/pull-images.ts'
import { tools } from './native/tools.ts'
import { version } from './native/version.ts'
import { emitLine, narrate } from './output.ts'
import type { Conn } from './resolve.ts'
import { resolveConnFresh } from './auth/fresh.ts'
import { embeddedManifest, loadManifest } from './render/manifest.ts'
import { renderVerbHelp, runVerb } from './render/run.ts'

export interface Globals {
	url?: string
	room?: string
	refresh: boolean
	json: boolean
	dryRun: boolean
	help: boolean
}

export function extractGlobals(argv: string[]): { globals: Globals; rest: string[] } {
	const g: Globals = { refresh: false, json: false, dryRun: false, help: false }
	const rest: string[] = []
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case '--url':
				g.url = argv[++i]
				break
			case '--room':
				g.room = argv[++i]
				break
			case '--refresh':
				g.refresh = true
				break
			case '--json':
				g.json = true
				break
			case '--dry-run':
				g.dryRun = true
				break
			case '-h':
			case '--help':
				g.help = true
				break
			default:
				rest.push(argv[i] as string)
		}
	}
	return { globals: g, rest }
}

export async function dispatch(rest: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	const group = rest[0]
	const verb = rest[1]

	// 1. Native single-word groups.
	if (group === undefined || group === 'help') return printTopHelp()
	if (group === 'version') return version({ url: globals.url, room: globals.room, json: globals.json }, env)
	if (group === 'auth') return authGroup(rest.slice(1), globals, env)
	if (group === 'codespace') return codespaceGroup(rest.slice(1), globals, env)
	if (group === 'tools') return tools(rest.slice(1), { url: globals.url, room: globals.room, json: globals.json }, env)

	// 2. Native (group, verb) pairs — win over the manifest.
	if (group === 'terminal' && verb === 'connect') return connectSlot(rest.slice(2), globals, env)
	if (group === 'canvas' && verb === 'pull-images') return pullImages(rest.slice(2), { url: globals.url, room: globals.room }, env)
	if (group === 'file' && verb === 'open') return fileOpen(rest.slice(2), globals, env)
	if (group === 'file' && verb === 'refresh') return fileRefresh(rest.slice(2), globals, env)

	// Verb help works without a configured instance (embedded manifest).
	if (globals.help) {
		const e = embeddedManifest().tools.find((t) => t.plugin === group && t.id === verb)
		if (e) {
			renderVerbHelp(e)
			return 0
		}
		return printTopHelp()
	}

	// 3. Manifest-rendered — needs a resolved connection (url/room/auth).
	// SP5: async resolution — an access-browser instance silently mints a fresh
	// app token here (cache-first); everything else is byte-identical.
	const conn = await resolveConnFresh({ url: globals.url, room: globals.room }, env)
	const { envelope, cacheFile } = await loadManifest(conn, { refresh: globals.refresh, env })
	const entry = envelope.tools.find((t) => t.plugin === group && t.id === verb)
	if (entry) return runVerb(entry, rest.slice(2), conn, cacheFile)

	// 4. Extension (only when the group matches NO manifest plugin).
	const groupVerbs = envelope.tools.filter((t) => t.plugin === group)
	if (groupVerbs.length === 0) {
		const code = tryExtension(group, rest.slice(1), conn, env)
		if (code !== null) return code
	}

	// 5. Error with did-you-mean.
	return unknownError(group, verb, envelope.tools, groupVerbs)
}

async function authGroup(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	const sub = args[0]
	switch (sub) {
		case 'login':
			return login(parseLoginFlags(args.slice(1), globals), env)
		case 'status':
			return status({ url: globals.url, json: globals.json }, env)
		case 'logout':
			return logout({ url: globals.url }, env)
		default:
			throw new CliError(`unknown auth command: ${sub ?? '(none)'} (expected login | status | logout)`, 2)
	}
}

function parseLoginFlags(args: string[], globals: Globals): import('./auth/login.ts').LoginFlags {
	const flags: import('./auth/login.ts').LoginFlags = { url: globals.url, room: globals.room }
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--method':
				flags.method = args[++i] as 'service-token' | 'none'
				break
			case '--token-id':
				flags.tokenId = args[++i]
				break
			case '--token-secret':
				flags.tokenSecret = args[++i]
				break
			default:
				throw new CliError(`unknown auth login flag: ${args[i]}`, 2)
		}
	}
	return flags
}

/** Layer 2: exec ensembleworks-<group> ONLY if it resolves inside the trusted
 *  extensions dir; hand it the resolved connection env (incl. live token pair).
 *  Returns the child exit code, or null when no such trusted extension exists. */
function tryExtension(group: string, args: string[], conn: Conn, env: NodeJS.ProcessEnv): number | null {
	const dir = path.join(path.dirname(hostsPath(env)), 'extensions')
	const bin = path.join(dir, `ensembleworks-${group}`)
	let realBin: string
	let realDir: string
	try {
		// must exist AND resolve (post-symlink) to a direct child of the trusted
		// dir — `group` is raw argv, so without this containment check a
		// traversal payload (e.g. `../../../../tmp/evil`) could make `bin`
		// resolve outside `dir` entirely and still pass a bare existence check.
		realBin = realpathSync(bin)
		realDir = realpathSync(dir)
	} catch {
		return null
	}
	if (path.dirname(realBin) !== realDir) return null
	const childEnv: NodeJS.ProcessEnv = {
		...env,
		ENSEMBLEWORKS_URL: conn.url,
		ENSEMBLEWORKS_ROOM: conn.room,
	}
	if (conn.auth.method === 'service-token') {
		childEnv.ENSEMBLEWORKS_TOKEN_ID = conn.auth.tokenId
		childEnv.ENSEMBLEWORKS_TOKEN_SECRET = conn.auth.tokenSecret
	}
	if (conn.auth.method === 'access') {
		childEnv.ENSEMBLEWORKS_ACCESS_TOKEN = conn.auth.appToken
	}
	const res = spawnSync(bin, args, { stdio: 'inherit', env: childEnv })
	return res.status ?? 1
}

function unknownError(group: string, verb: string | undefined, all: { plugin: string; id: string }[], groupVerbs: { plugin: string; id: string }[]): number {
	if (groupVerbs.length > 0) {
		narrate(`ensembleworks: unknown verb '${verb ?? ''}' in group '${group}' — try: ${groupVerbs.map((t) => `${t.plugin} ${t.id}`).join(', ')}`)
	} else {
		const groups = [...new Set(all.map((t) => t.plugin))].sort()
		narrate(`ensembleworks: unknown command '${group}${verb ? ` ${verb}` : ''}' — groups: ${groups.join(', ')}, auth, tools, version`)
	}
	return 2
}

function printTopHelp(): number {
	emitLine('ensembleworks <group> <verb> [args] — a generic renderer of GET /api/tools')
	emitLine('')
	emitLine('native: auth login|status|logout · codespace up|stop|rebuild|list|reconcile|boot-install · tools [refresh] · version · terminal connect · canvas pull-images · file open|refresh <path>')
	emitLine('rendered: any verb from `ensembleworks tools` (canvas/roadmap/scribe/terminal/av/kernel)')
	emitLine('global flags: --url --room --refresh --json --dry-run -h/--help')
	return 0
}
