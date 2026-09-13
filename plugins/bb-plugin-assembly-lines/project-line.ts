import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { posix } from 'node:path';
import { z } from 'zod';
import Ajv from 'ajv';
import type { WorkflowPackage } from './fabro';

const exec = promisify(execFile);
export const linePathSchema = z.string().max(500).regex(/^\.fabro\/lines\/[a-z0-9][a-z0-9-]*\/line\.json$/);
const file = z.string().min(1).max(300).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && p.split('/').every(s => s !== '..' && s !== '.' && s !== ''));
const schema = z.record(z.string(), z.json());
export const lineManifestSchema = z.object({
  version: z.literal(1), name: z.string().min(1).max(160),
  workflow: file, files: z.array(file).min(1).max(30),
  inputSchema: schema, outputSchema: schema,
  acceptanceInstructions: z.string().min(1).max(8000),
  environment: z.string().min(1).max(100).default('local'),
  autoApprove: z.boolean().default(false),
}).strict();
export type LineManifest = z.infer<typeof lineManifestSchema>;
export function validateLineValue(schema: Record<string, unknown>, value: unknown, label: string) {
  // Local JSON Schema only; no network resolution, coercion, or default mutation.
  const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`${label}: ${ajv.errorsText(validate.errors)}`);
}
export interface ProjectLine { manifest: LineManifest; workflow: WorkflowPackage }
export async function readProjectLine(sourcePath: string, baseSha: string, linePath: string, inputs: unknown, signal?: AbortSignal): Promise<ProjectLine> {
  linePathSchema.parse(linePath);
  if (!/^[a-f0-9]{40}$/i.test(baseSha)) throw new Error('Use a full commit SHA for the line');
  let total = 0;
  const read = async (path: string) => {
    const { stdout: entry } = await exec('git', ['-C', sourcePath, 'ls-tree', baseSha, '--', path], { signal });
    if (!/^100(?:644|755) blob /.test(entry)) throw new Error(`Line file must be a committed regular file: ${path}`);
    const { stdout } = await exec('git', ['-C', sourcePath, 'show', `${baseSha}:${path}`], { maxBuffer: 256_000, signal });
    total += Buffer.byteLength(stdout);
    if (total > 512_000) throw new Error('Line package exceeds 512 KB');
    return stdout;
  };
  const manifest = lineManifestSchema.parse(JSON.parse(await read(linePath)));
  validateLineValue(manifest.inputSchema, inputs, 'Line inputs do not match inputSchema');
  // Compile output schema before execution, even though no output exists yet.
  new Ajv({ strict: true, validateFormats: false }).compile(manifest.outputSchema);
  if (!manifest.files.includes(manifest.workflow)) throw new Error('Line files must include its workflow');
  const directory = posix.dirname(linePath);
  const files: Record<string, string> = {};
  for (const path of [...new Set(manifest.files)]) files[posix.join(directory, path)] = await read(posix.join(directory, path));
  return { manifest, workflow: { entrypoint: posix.join(directory, manifest.workflow), files, workflow_dependencies: {} } };
}
