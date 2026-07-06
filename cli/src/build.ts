/**
 * The CLI build version. In dev (`bun cli/src/main.ts`) it is read soft from
 * cli/package.json — mirroring the server's SERVER_VERSION '0.0.0' fallback.
 * Sub-project #7's `bun build --compile` replaces this whole function with a
 * stamped literal (a compiled binary has no sibling package.json), so the
 * compiled path never touches import.meta or the filesystem.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readCliBuild(): string {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url))
		const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version?: string }
		return pkg.version ?? '0.0.0'
	} catch {
		return '0.0.0'
	}
}

export const CLI_BUILD: string = readCliBuild()
