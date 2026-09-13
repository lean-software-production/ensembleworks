/**
 * The `bb.host` RPC contract, per docs/plans/2026-09-13-attractor-runner-plan.md
 * "BB plugin SDK notes": "runs `script` with `/bin/sh -c` via `execFile`, `cwd`
 * = environment path, env with `ATTRACTOR_RUN_ID`, `ATTRACTOR_NODE_ID`,
 * optional stdin from `stdin_source`, timeout → kill, returns `{ exitCode,
 * stdout (bounded 64 KiB, tail kept), stderr (bounded), timedOut }`."
 *
 * Kept in its own module (like the sibling `bb-plugin-assembly-lines`'s
 * `host-contract.ts`) so `server/service.ts` can import the contract's types
 * without pulling in `node:child_process`.
 */

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;

export const execInputSchema = z.object({
  script: z.string().min(1).max(1_000_000),
  cwd: z.string().min(1),
  stdin: z.string().max(1_000_000).optional(),
  env: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
});

export const execOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
});

export const hostContract = defineRpcContract({
  exec: { input: execInputSchema, output: execOutputSchema },
});

export type ExecInput = z.infer<typeof execInputSchema>;
export type ExecOutput = z.infer<typeof execOutputSchema>;
