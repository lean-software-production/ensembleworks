/** The pinned upstream @devcontainers/cli (decision log #1). This CLI's
 *  behaviour IS the compatibility promise (design §2.2), so bumping the pin is
 *  a deliberate act: edit this constant, run
 *  `bun cli/scripts/vendor-devcontainers-cli.ts`, commit the refreshed
 *  cli/vendor/devcontainers-cli/, and re-run the gate —
 *  `bun scripts/codespace-conformance.ts` — before landing. */
export const DEVCONTAINERS_CLI_VERSION = '0.87.0'
