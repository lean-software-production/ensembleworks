/**
 * SERVER_VERSION — the root package.json version, read at source-run. Feeds the
 * informational `server` field of the /api/tools manifest envelope (slice 3b).
 * Soft by design: on any read failure it is '0.0.0' (the CLI treats it as
 * non-fatal). Compiled-binary version-stamping is a separate Phase-3 line item.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function readVersion(): string {
	try {
		const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
		return pkg.version ?? '0.0.0'
	} catch {
		return '0.0.0'
	}
}

export const SERVER_VERSION: string = readVersion()
