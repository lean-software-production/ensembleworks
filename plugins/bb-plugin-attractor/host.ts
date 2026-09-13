/**
 * Attractor host entry point (task T4).
 *
 * Runs a `command` node's `script` with `/bin/sh -c` in the environment's
 * path — the daemon host, not this plugin's own server process — per
 * docs/plans/2026-09-13-attractor-runner-plan.md "BB plugin SDK notes":
 * `execFile`-style spawn, `cwd` = environment path, `ATTRACTOR_RUN_ID`/
 * `ATTRACTOR_NODE_ID` env vars, optional stdin, a timeout that kills the
 * process, and stdout/stderr bounded to the last `MAX_OUTPUT_BYTES` (tail
 * kept, not the head — a long build log's *last* lines are the useful ones).
 */

import { spawn } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { execOutputSchema, hostContract, MAX_OUTPUT_BYTES, type ExecInput, type ExecOutput } from "./host-contract";

export { hostContract } from "./host-contract";

/** Keeps only the last `limit` UTF-8 bytes seen, per chunk, cheaply. */
function boundedTail(limit: number) {
  let text = "";
  return {
    push(chunk: Buffer): void {
      text += chunk.toString("utf8");
      if (text.length > limit * 2) {
        // Trim well before every chunk to avoid the string growing unbounded
        // on a chatty process; the final slice below is the exact bound.
        text = text.slice(-limit);
      }
    },
    value(): string {
      return text.length > limit ? text.slice(-limit) : text;
    },
  };
}

export async function runExec(input: ExecInput, options: { signal?: AbortSignal }): Promise<ExecOutput> {
  return new Promise((resolve) => {
    // `detached: true` puts the child in its own process group so a timeout or
    // abort can kill the whole tree (`kill(-pid)`) — a bare `child.kill()` only
    // signals the immediate `/bin/sh`, leaving whatever it spawned (the actual
    // `sleep`/build tool) running and holding stdout open, which would delay
    // "close" until that grandchild exits on its own.
    const child = spawn("/bin/sh", ["-c", input.script], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      detached: true,
    });

    const stdout = boundedTail(MAX_OUTPUT_BYTES);
    const stderr = boundedTail(MAX_OUTPUT_BYTES);
    let timedOut = false;
    let settled = false;

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, input.timeoutMs);

    const onAbort = () => killTree();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    if (input.stdin !== undefined) {
      child.stdin.write(input.stdin);
    }
    child.stdin.end();

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode, stdout: stdout.value(), stderr: stderr.value(), timedOut });
    };

    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    exec: async (input, ctx) => execOutputSchema.parse(await runExec(input, { signal: ctx.signal })),
  },
});
