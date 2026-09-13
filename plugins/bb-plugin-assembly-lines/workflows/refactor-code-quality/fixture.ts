// Test fixture only: production loads project files from the submitted commit.
import { readFileSync } from 'node:fs';
const assets = new URL('../../skills/create-fabro-line/assets/refactor-line/', import.meta.url);
export const runtimeSource = readFileSync(new URL('runner.mjs', assets), 'utf8');
export async function workflowPackage(_policy: {maxAttempts?:number;maxMinutes?:number} = {}) {
  return {entrypoint:'workflow.fabro', files:{'workflow.fabro':readFileSync(new URL('workflow.fabro',assets),'utf8').replaceAll('__LINE_DIR__/runner.mjs','.fabro-input/runner.mjs')}, workflow_dependencies:{}};
}
