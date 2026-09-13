/**
 * zod schemas + the plugin's `bb.rpc` contract, per
 * docs/plans/2026-09-13-attractor-runner-plan.md "Plugin layout"
 * (`server/contracts.ts`, "shared by server and app") and T4's RPC list:
 * `getRun`, `listRuns`, `getGraph`, `getEvents`.
 */

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { RunStatus, StageActor, StageStatus } from "./store";

const id = z.string().min(1).max(200);
const json = z.json();

export const runStatusSchema: z.ZodType<RunStatus> = z.enum(["running", "blocked", "succeeded", "failed", "cancelled"]);
export const stageStatusSchema: z.ZodType<StageStatus> = z.enum(["running", "blocked", "succeeded", "failed", "skipped", "cancelled"]);
export const outcomeStatusSchema = z.enum(["succeeded", "failed", "partially_succeeded", "skipped"]);
export const stageActorSchema: z.ZodType<StageActor> = z.enum(["ui", "cli", "default"]);

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

// The stage/event summary of a human gate's routing context (gate-context
// follow-up) — shared by `humanGatePayloadSchema.context`, the
// `human.requested` event, and `StageView.gateContext` (persisted as the
// `attractor_stages.gate_context_json` column). Text lengths differ by call
// site (handlers/human.ts caps the event/stage summary far harder than the
// live gate payload it sends to `bb.ui.requestInput`), but the shape is one.
export const humanGateContextSchema = z.object({
  nodeId: z.string(),
  label: z.string().nullable(),
  text: z.string().nullable(),
  threadId: z.string().nullable(),
});

/** The `review_target` node attribute's summary, as attached to a stage/event — path plus its (possibly-error) text, capped short. */
export const gateReviewTargetSummarySchema = z.object({
  path: z.string(),
  text: z.string().nullable(),
});

export const stageGateContextSchema = z
  .object({
    context: humanGateContextSchema.nullable(),
    reviewTarget: gateReviewTargetSummarySchema.nullable(),
  })
  .nullable();

export const stageSchema = z.object({
  runId: id,
  stageId: z.string(),
  nodeId: z.string(),
  visit: z.number(),
  attempt: z.number(),
  status: stageStatusSchema,
  outcomeStatus: outcomeStatusSchema.nullable(),
  threadId: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  actor: stageActorSchema.nullable(),
  waitingReason: z.string().nullable(),
  /** The gate this stage opened (blocked human stage only) — null once nothing was ever a gate, or before this follow-up shipped. */
  gateContext: stageGateContextSchema.optional(),
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
  /** The latest stage's waiting reason (kind), when this node is currently "blocked" — null otherwise (dogfood-2 fix's `agent.waiting`). */
  waitingReason: z.string().nullable(),
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

// -----------------------------------------------------------------------
// Human gate (T6) — the JSON shape passed as `bb.ui.requestInput`'s payload
// and read back by the `pendingInteraction` renderer (ui/human-gate.tsx),
// plus the JSON `value` shape that renderer's `submit()` sends back and
// server/human.ts validates. Shared here (rather than only living inside
// handlers/human.ts / server/human.ts) so the renderer never has to import
// past server/contracts.ts, matching every other ui/*.tsx module.
// -----------------------------------------------------------------------

export const HUMAN_GATE_RENDERER_ID = "attractor-human-gate";

export const humanGateOptionSchema = z.object({
  raw: z.string(),
  key: z.string().nullable(),
  text: z.string(),
  to: z.string(),
});

/** The `review_target` node attribute's file, as sent in full to the gate's renderer — see `humanGateContextSchema` for why this is a separate (larger) shape from the stage/event summary. */
export const humanGateReviewTargetSchema = z.object({
  path: z.string(),
  content: z.string().nullable(),
  error: z.string().nullable(),
});

export const humanGatePayloadSchema = z.object({
  runId: id,
  nodeId: z.string(),
  question: z.string(),
  options: z.array(humanGateOptionSchema),
  freeform: z.boolean(),
  questionType: z.string().nullable(),
  // Both optional (not just nullable) so a payload recorded/replayed from
  // before this follow-up shipped still parses (missing key, not `null`).
  context: humanGateContextSchema.nullable().optional(),
  reviewTarget: humanGateReviewTargetSchema.nullable().optional(),
});

// `via` names who submitted this value — the pendingInteraction renderer
// (ui/human-gate.tsx) always sends "ui"; `bb attractor answer` (server/
// service.ts's answerHumanGate) always sends "cli". Optional (rather than
// required) so a stored/replayed value from before this field existed still
// parses; server/human.ts's ask() treats a missing `via` as an unknown actor
// and omits it from the resulting human.answered event (see engine/types.ts's
// StageScopedEvent "human.answered": actor is "omit when unknown").
export const humanGateValueSchema = z.union([
  z.object({ kind: z.literal("choice"), raw: z.string(), via: z.enum(["ui", "cli"]).optional() }).strict(),
  z.object({ kind: z.literal("text"), text: z.string(), via: z.enum(["ui", "cli"]).optional() }).strict(),
]);

export type HumanGateOption = z.infer<typeof humanGateOptionSchema>;
export type HumanGatePayload = z.infer<typeof humanGatePayloadSchema>;
export type HumanGateValue = z.infer<typeof humanGateValueSchema>;
export type HumanGateContextView = z.infer<typeof humanGateContextSchema>;
export type HumanGateReviewTargetView = z.infer<typeof humanGateReviewTargetSchema>;
export type StageGateContextView = z.infer<typeof stageGateContextSchema>;
