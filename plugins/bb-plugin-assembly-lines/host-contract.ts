import type { FabroArtifact, FabroEvent, FabroRun } from "./fabro";
import type { WorkOrder } from "./work-order";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { workOrderSchema } from "./work-order";
import { graphSchema } from "./graph-contract";
import { linePathSchema } from './project-line';

export type AssemblyLineWorkOrder = WorkOrder;
export interface PrepareInput { jobId: string; sourcePath: string; baseSha: string; workOrder: AssemblyLineWorkOrder }
export interface PreparedAssemblyLine { workspacePath: string; workflowVersionId: string; baseSha: string }
export interface CreateInput { jobId: string; threadId?: string; workOrder: AssemblyLineWorkOrder; workspacePath: string; workflowVersionId: string }
export interface AssemblyLineEvidence { run: FabroRun; events: FabroEvent[]; artifacts: FabroArtifact[]; diff: unknown }
export interface FabroHost {
  prepare(input: PrepareInput): Promise<PreparedAssemblyLine>;
  create(input: CreateInput): Promise<FabroRun>;
  start(runId: string): Promise<FabroRun>;
  inspect(runId: string): Promise<FabroRun>;
  evidence(runId: string, sinceSeq?: number): Promise<AssemblyLineEvidence>;
  cancel(runId: string): Promise<FabroRun>;
}

const connection = z.object({ endpoint: z.string().url().max(500), token: z.string().min(1).max(1000).optional() });
const runOutput = z.object({ id: z.string().min(1), lifecycle: z.object({ status: z.object({ kind: z.string().min(1) }).passthrough() }).passthrough() }).passthrough();
const runId = z.object({ connection, runId: z.string().min(1).max(200) });
export const hostContract = defineRpcContract({
  validateLine: { input: z.object({ sourcePath: z.string().min(1).max(2000), baseSha: z.string().regex(/^[a-f0-9]{40}$/i), line: linePathSchema, inputs: z.record(z.string(), z.json()) }), output: z.object({ name: z.string() }) },
  graph: { input: runId, output: graphSchema },
  prepare: { input: z.object({ connection, jobId: z.string().min(1).max(100), sourcePath: z.string().min(1).max(2000), baseSha: z.string().regex(/^[a-f0-9]{40}$/i), workOrder: workOrderSchema }), output: z.object({ workspacePath: z.string(), workflowVersionId: z.string().regex(/^[a-f0-9]{64}$/i), baseSha: z.string() }) },
  create: { input: z.object({ connection, jobId: z.string().min(1).max(100), threadId: z.string().min(1).max(200).optional(), workOrder: workOrderSchema, workspacePath: z.string().min(1).max(2000), workflowVersionId: z.string().regex(/^[a-f0-9]{64}$/i) }), output: runOutput },
  reconcile: { input: z.object({ connection, jobId: z.string().min(1).max(100) }), output: z.object({ runs: z.array(runOutput), complete: z.boolean() }) },
  start: { input: runId, output: runOutput },
  inspect: { input: runId, output: runOutput },
  evidence: { input: runId.extend({ jobId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), baseSha: z.string().regex(/^[a-f0-9]{40}$/i), sinceSeq: z.number().int().min(1).optional() }), output: z.object({ run: z.json(), events: z.json(), artifacts: z.json(), diff: z.json(), workspace: z.json(), errors: z.json(), lineContract: z.json().optional() }) },
  cancel: { input: runId, output: runOutput },
});
