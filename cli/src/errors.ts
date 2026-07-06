/**
 * A CLI error carrying the process exit code. Thrown anywhere; main.ts catches
 * it, prints `ensembleworks: <message>` to stderr, and exits with `exitCode`.
 * exitCode 2 = a local/structural refusal (bad args, unknown flag, no instance,
 * a poisoned manifest path); 1 = a runtime/transport failure or a non-2xx that
 * matters. Any non-CliError bubbles up as exit 1.
 */
export class CliError extends Error {
	readonly exitCode: number
	constructor(message: string, exitCode = 1) {
		super(message)
		this.name = 'CliError'
		this.exitCode = exitCode
	}
}
