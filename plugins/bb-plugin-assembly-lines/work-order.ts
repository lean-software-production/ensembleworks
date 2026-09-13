import { z } from "zod";
import { linePathSchema } from './project-line';
import type { JsonValue } from './jobs';

// Provider tool schemas cannot contain recursive $refs. Accept bounded JSON
// nesting, while project schemas define the actual fields and constraints.
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
let inputValue: z.ZodType<JsonValue> = scalar;
for (let depth = 0; depth < 4; depth++) inputValue = z.union([scalar, z.array(inputValue), z.record(z.string(), inputValue)]);
export const lineInputsSchema = z.record(z.string(), inputValue).refine(v => JSON.stringify(v).length <= 64_000, 'Line inputs exceed 64 KB');

const text = z.string().trim().min(1).max(4000);
const relativePath = z.string().trim().min(1).max(500).refine(
  (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..") && !value.includes("\0"),
  "Scope paths must stay inside the repository",
);

/** Frozen task-specific input. Workflow defaults are versioned with the package. */
export const workOrderSchema = z.object({
  title: z.string().trim().min(1).max(160),
  objective: text,
  baseSha: z.string().regex(/^[a-f0-9]{40}$/i, "Use the full starting commit SHA"),
  line: linePathSchema.optional(),
  inputs: lineInputsSchema.optional(),
  scope: z.array(relativePath).min(1).max(30),
  constraints: z.array(text).max(30),
  acceptanceCriteria: z.array(text).min(1).max(30),
  setupCommands: z.array(z.string().trim().min(1).max(1000)).max(8).default([]),
  validationCommands: z.array(z.string().trim().min(1).max(1000)).min(1).max(12).optional(),
  qualityCommand: z.string().trim().min(1).max(1000).optional(),
  maxAttempts: z.number().int().min(1).max(3).default(2),
  maxMinutes: z.number().int().min(1).max(120).default(30),
  maxChangedFiles: z.number().int().min(1).max(100).default(10),
}).strict();
export type WorkOrder = Omit<z.infer<typeof workOrderSchema>, "setupCommands"> & { setupCommands?: string[] };

export const submissionSchema = z.object({
  requestKey: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  workOrder: workOrderSchema.omit({ setupCommands: true, validationCommands: true, qualityCommand: true }).extend({ line: linePathSchema, inputs: lineInputsSchema.default({}) }),
}).strict();

export const acceptanceSchema = z.object({
  jobId: z.string().min(1).max(100),
  resultRevision: z.number().int().nonnegative(),
  verdict: z.enum(["accepted", "rework", "needs_input"]),
  reason: text,
}).strict();
