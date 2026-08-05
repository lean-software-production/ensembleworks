/** `auth token [--url <u>]` (design §1.4): print a FRESH app token for the
 *  resolved access-browser instance to stdout — the scripting escape hatch
 *  (`curl -H "cf-access-token: $(ew auth token)" …`). */
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitLine } from '../output.ts'
import { type AccessDeps, realAccessDeps } from './access.ts'
import { ensureFreshAppToken } from './fresh.ts'

export async function tokenCmd(
	flags: { url?: string },
	env: NodeJS.ProcessEnv,
	deps: Pick<AccessDeps, 'fetch' | 'now'> = realAccessDeps(),
): Promise<number> {
	const file = hostsPath(env)
	const hosts = loadHosts(file)
	const url = flags.url ?? hosts.default_instance
	if (!url) throw new CliError('auth token requires --url or a default instance (run `ew auth login`)', 2)
	const rec = hosts.instances[url]
	if (rec?.method !== 'access-browser') {
		throw new CliError(`auth token: ${url} is not an access-browser instance (service-token/none creds are already env-shaped)`, 2)
	}
	emitLine(await ensureFreshAppToken(file, url, deps))
	return 0
}
