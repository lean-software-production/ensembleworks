import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { posix } from 'node:path';
import { z } from 'zod';
import Ajv from 'ajv';
import type { WorkflowPackage } from './fabro';

const exec = promisify(execFile);
export const workflowPathSchema = z.string().max(500).regex(/^\.fabro\/workflows\/[a-z0-9][a-z0-9-]*\/workflow\.json$/);
const file = z.string().min(1).max(300).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && p.split('/').every(s => s !== '..' && s !== '.' && s !== ''));
const schema = z.record(z.string(), z.json());
export const workflowManifestSchema = z.object({
  version: z.literal(1), name: z.string().min(1).max(160),
  workflow: file, files: z.array(file).min(1).max(30),
  inputSchema: schema, outputSchema: schema,
  acceptanceInstructions: z.string().min(1).max(8000),
  environment: z.string().min(1).max(100).default('local'),
  autoApprove: z.boolean().default(false),
}).strict();
export type WorkflowManifest = z.infer<typeof workflowManifestSchema>;
export function validateWorkflowValue(schema: Record<string, unknown>, value: unknown, label: string) {
  // Local JSON Schema only; no network resolution, coercion, or default mutation.
  const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`${label}: ${ajv.errorsText(validate.errors)}`);
}
export interface ProjectWorkflow { manifest: WorkflowManifest; workflow: WorkflowPackage }
export async function readProjectWorkflow(sourcePath: string, baseSha: string, workflowPath: string, inputs: unknown, signal?: AbortSignal): Promise<ProjectWorkflow> {
  workflowPathSchema.parse(workflowPath);
  if (!/^[a-f0-9]{40}$/i.test(baseSha)) throw new Error('Use a full commit SHA for the workflow');
  let total = 0;
  const read = async (path: string) => {
    const { stdout: entry } = await exec('git', ['-C', sourcePath, 'ls-tree', baseSha, '--', path], { signal });
    if (!/^100(?:644|755) blob /.test(entry)) throw new Error(`Workflow file must be a committed regular file: ${path}`);
    const { stdout } = await exec('git', ['-C', sourcePath, 'show', `${baseSha}:${path}`], { maxBuffer: 256_000, signal });
    total += Buffer.byteLength(stdout);
    if (total > 512_000) throw new Error('Workflow package exceeds 512 KB');
    return stdout;
  };
  const manifest = workflowManifestSchema.parse(JSON.parse(await read(workflowPath)));
  validateWorkflowValue(manifest.inputSchema, inputs, 'Workflow inputs do not match inputSchema');
  // Compile output schema before execution, even though no output exists yet.
  new Ajv({ strict: true, validateFormats: false }).compile(manifest.outputSchema);
  if (!manifest.files.includes(manifest.workflow)) throw new Error('Workflow files must include its workflow');
  const directory = posix.dirname(workflowPath);
  const files: Record<string, string> = {};
  for (const path of [...new Set(manifest.files)]) files[posix.join(directory, path)] = await read(posix.join(directory, path));
  return { manifest, workflow: { entrypoint: posix.join(directory, manifest.workflow), files, workflow_dependencies: {} } };
}
