import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { workOrderSchema } from "./work-order";
import { graphSchema } from "./graph-contract";

const id = z.string().min(1).max(128);
const json: z.ZodType<unknown> = z.json();
export const jobSchema = z.object({
  id, threadId: id, projectId: id.nullable(), environmentId: id.nullable(), hostId: id.nullable(),
  workspacePath: z.string().nullable(), workflowVersionId: z.string().nullable(),
  engineUrl: z.string().nullable(), sourcePath: z.string().nullable(), requestKey: z.string(),
  inputHash: z.string(), workOrder: workOrderSchema, runId: z.string().nullable(),
  createdAt: z.number(), updatedAt: z.number(), createState: z.string(), createDetail: z.string().nullable(),
  observationState: z.string(), observationDetail: z.string().nullable(),
  engineStatus: z.string().nullable(), connectionError: z.string().nullable(),
  resultRevision: z.number().nullable(), result: json.nullable(),
  completionState: z.string(), completionDetail: z.string().nullable(), completionMessageId: z.string().nullable(),
  acceptanceVerdict: z.string(), acceptanceReason: z.string().nullable(), acceptanceResultRevision: z.number().nullable(),
});
export type JobView = z.infer<typeof jobSchema>;
const selection = z.object({ jobId: id, threadId: id }).strict();
export const rpcContract = defineRpcContract({
  getRunGraph: { input: selection, output: graphSchema.nullable() },
  getJob: { input: selection, output: z.object({ job: jobSchema.nullable(), fabroUrl: z.string().nullable() }) },
  listJobs: { input: z.object({ threadId: id, after: z.string().max(500).optional() }).strict(), output: z.object({ jobs: z.array(jobSchema).max(50), nextCursor: z.string().nullable() }) },
  getRunDetails: { input: selection, output: z.object({ job: jobSchema, fabroUrl: z.string().nullable(), details: z.string(), artifacts: z.string() }) },
});
