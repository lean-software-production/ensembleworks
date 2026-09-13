/**
 * zod schemas + the plugin's `bb.rpc` contract, per
 * docs/plans/2026-09-13-attractor-runner-plan.md "Plugin layout"
 * (`server/contracts.ts`, "shared by server and app") and T4's RPC list:
 * `getRun`, `listRuns`, `getGraph`, `getEvents`.
 */

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { RunStatus, StageStatus } from "./store";

const id = z.string().min(1).max(200);
const json = z.json();

export const runStatusSchema: z.ZodType<RunStatus> = z.enum(["running", "succeeded", "failed", "cancelled"]);
export const stageStatusSchema: z.ZodType<StageStatus> = z.enum(["running", "succeeded", "failed", "skipped"]);
export const outcomeStatusSchema = z.enum(["succeeded", "failed", "partially_succeeded", "skipped"]);

export const runSchema = z.object({
  id,
  threadId: id,
  projectId: id.nullable(),
  environmentId: id.nullable(),
  title: z.string().nullable(),
  source: z.string(),
  status: runStatusSchema,
  currentNodeId: z.string().nullable(),
  context: z.record(z.string(), json),
  goalGateFailures: z.array(z.string()),
  finalOutcome: json.nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
});

export const stageSchema = z.object({
  runId: id,
  stageId: z.string(),
  nodeId: z.string(),
  visit: z.number(),
  attempt: z.number(),
  status: stageStatusSchema,
  outcomeStatus: outcomeStatusSchema.nullable(),
  threadId: z.string().nullable(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
});

export const eventSchema = z.object({ seq: z.number() }).and(json);

export const rankdirSchema = z.enum(["TB", "LR", "BT", "RL"]);

export const graphNodeSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  shape: z.string(),
  handlerKind: z.string(),
  goalGate: z.boolean(),
  status: stageStatusSchema.nullable(),
  visit: z.number(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
});

export const graphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().nullable(),
  condition: z.string().nullable(),
});

export const graphViewSchema = z.object({ rankdir: rankdirSchema, nodes: z.array(graphNodeSchema), edges: z.array(graphEdgeSchema) });

// TS types inferred from the schemas above, for the app side (ui/*, app.tsx)
// to consume without ever importing server/service.ts or server/store.ts —
// those pull in better-sqlite3 (a native module), which must never end up in
// the app's esbuild bundle.
export type RunView = z.infer<typeof runSchema>;
export type StageView = z.infer<typeof stageSchema>;
export type GraphNodeView = z.infer<typeof graphNodeSchema>;
export type GraphEdgeView = z.infer<typeof graphEdgeSchema>;
export type GraphView = z.infer<typeof graphViewSchema>;

const selection = z.object({ runId: id, threadId: id }).strict();

export const rpcContract = defineRpcContract({
  getRun: { input: selection, output: z.object({ run: runSchema.nullable(), stages: z.array(stageSchema) }) },
  listRuns: { input: z.object({ threadId: id, after: z.string().max(500).optional() }).strict(), output: z.object({ runs: z.array(runSchema).max(200), nextCursor: z.string().nullable() }) },
  getGraph: { input: selection, output: graphViewSchema.nullable() },
  getEvents: { input: selection.extend({ sinceSeq: z.number().int().min(0).optional() }), output: z.object({ events: z.array(eventSchema) }) },
  // Backs the Panel's Stop button (T5). `stopped: false` distinguishes "not
  // your run" / "no such run" from an actual abort, without leaking whether a
  // runId exists to a caller that doesn't own it.
  stopRun: { input: selection, output: z.object({ stopped: z.boolean() }) },
});
