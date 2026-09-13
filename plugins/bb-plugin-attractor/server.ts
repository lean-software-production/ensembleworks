import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Attractor server entry point.
 *
 * This is a scaffold (task T1): it only proves the plugin loads under the
 * bb host and logs a startup message. The DOT front-end, execution engine,
 * BB-thread backend, storage, tools, CLI and RPC surface land in later
 * tasks per docs/plans/2026-09-13-attractor-runner-plan.md.
 */
export default async function plugin(bb: BbPluginApi): Promise<void> {
  bb.log.info("Attractor plugin loaded");
}
