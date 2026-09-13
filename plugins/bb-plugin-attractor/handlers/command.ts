/**
 * `command` (parallelogram) handler: runs a node's `script` via the injected
 * `exec` dependency (server/service.ts wires this to the `host.ts` `exec`
 * RPC, so the script actually runs in the environment's path on its host,
 * not in this plugin's own server process) and maps its exit code to an
 * Outcome, per "Context keys written by handlers": `command.output`,
 * `command.exit_code`.
 */

import type { Handler } from "../engine/types";

export interface CommandExecInput {
  script: string;
  stdin?: string;
  env: Record<string, string>;
  timeoutMs?: number;
  runId: string;
  nodeId: string;
}

export interface CommandExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandHandlerDeps {
  exec(input: CommandExecInput, options: { signal: AbortSignal }): Promise<CommandExecResult>;
}

const STDERR_TAIL_LIMIT = 500;

export function createCommandHandler(deps: CommandHandlerDeps): Handler {
  return {
    async run(input) {
      const { node, context, runId, signal } = input;
      if (!node.script) {
        return { status: "failed", failureReason: `command node "${node.id}" has no script` };
      }
      const stdin = node.stdinSource !== undefined ? String(context.get(node.stdinSource) ?? "") : undefined;
      const result = await deps.exec(
        { script: node.script, stdin, env: { ATTRACTOR_RUN_ID: runId, ATTRACTOR_NODE_ID: node.id }, timeoutMs: node.timeoutMs, runId, nodeId: node.id },
        { signal },
      );
      const contextUpdates = { "command.output": result.stdout, "command.exit_code": result.exitCode };
      if (result.timedOut) {
        return { status: "failed", failureReason: `command node "${node.id}" timed out`, text: result.stdout, contextUpdates };
      }
      if (result.exitCode !== 0) {
        return {
          status: "failed",
          failureReason: `exit code ${result.exitCode}: ${result.stderr.slice(0, STDERR_TAIL_LIMIT)}`,
          text: result.stdout,
          contextUpdates,
        };
      }
      return { status: "succeeded", text: result.stdout, contextUpdates };
    },
  };
}
