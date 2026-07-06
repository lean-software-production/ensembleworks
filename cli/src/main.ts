/** Entry: strip global flags, dispatch, map CliError → stderr + its exit code
 *  (any other error → exit 1). All narration/errors on stderr; stdout stays
 *  clean (spec §7.1). */
import { dispatch, extractGlobals } from './dispatch.ts'
import { CliError } from './errors.ts'

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const { globals, rest } = extractGlobals(argv)
	try {
		return await dispatch(rest, globals, env)
	} catch (err) {
		if (err instanceof CliError) {
			process.stderr.write(`ensembleworks: ${err.message}\n`)
			return err.exitCode
		}
		process.stderr.write(`ensembleworks: ${(err as Error).message}\n`)
		return 1
	}
}

if (import.meta.main) {
	main(process.argv.slice(2), process.env).then((code) => process.exit(code))
}
