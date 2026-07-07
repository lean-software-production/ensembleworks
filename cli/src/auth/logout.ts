/** `auth logout --url <u>`: remove the [instances."<u>"] record; if it was
 *  default_instance, reassign to the first survivor or clear. Never touches
 *  other records. */
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts, removeInstance, saveHosts } from '../hosts.ts'
import { narrate } from '../output.ts'

export async function logout(flags: { url?: string }, env: NodeJS.ProcessEnv): Promise<number> {
	const url = flags.url
	if (!url) throw new CliError('auth logout requires --url <instance>', 2)
	const file = hostsPath(env)
	const hosts = loadHosts(file)
	if (!hosts.instances[url]) {
		narrate(`no such instance: ${url}`)
		return 1
	}
	const next = removeInstance(hosts, url)
	saveHosts(file, next)
	narrate(`removed ${url}${next.default_instance ? ` (default is now ${next.default_instance})` : ' (no default remains)'}`)
	return 0
}
