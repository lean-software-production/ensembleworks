/** The `codespace` group (coexistence spec §6.2): native verb dispatch,
 *  mirroring the auth group. up and rebuild share one engine — rebuild is up
 *  with --remove-existing-container (decision #7). */
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { codespaceBootInstall } from './boot-install.ts'
import { codespaceList } from './list.ts'
import { codespaceReconcile } from './reconcile.ts'
import { codespaceStop } from './stop.ts'
import { codespaceUp } from './up.ts'

export async function codespaceGroup(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	const verb = args[0]
	switch (verb) {
		case 'up':
			return codespaceUp(args.slice(1), globals, env, { removeExisting: false })
		case 'rebuild':
			return codespaceUp(args.slice(1), globals, env, { removeExisting: true })
		case 'stop':
			return codespaceStop(args.slice(1), globals, env)
		case 'list':
			return codespaceList(args.slice(1), globals, env)
		case 'reconcile':
			return codespaceReconcile(args.slice(1), globals, env)
		case 'boot-install':
			return codespaceBootInstall(args.slice(1), globals, env)
		default:
			throw new CliError(`unknown codespace command: ${verb ?? '(none)'} (expected up | stop | rebuild | list | reconcile | boot-install)`, 2)
	}
}
