/** `terminal connect` — the native SLOT. Task 6 fills resolveConnectConfig and
 *  the --dry-run/notice behaviour; #5 fills the connector engine behind it. */
import { CliError } from '../errors.ts'
import type { Globals } from '../dispatch.ts'

export async function connectSlot(_args: string[], _globals: Globals, _env: NodeJS.ProcessEnv): Promise<number> {
	throw new CliError('terminal connect: not yet wired (filled in Task 6)', 1)
}
