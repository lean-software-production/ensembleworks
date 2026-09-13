#!/usr/bin/env node
// Inspection never executes discovered commands. Creation only consumes explicit configuration.
import { readFile, writeFile, readdir, lstat, mkdir, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const home = dirname(fileURLToPath(import.meta.url));
const catalog = {
  'refactor-code-quality': { assets: '../../create-fabro-line/assets/refactor-line', name: 'Improve code quality' },
  'implement-plan': { assets: '../assets/implement-plan', name: 'Implement approved plan' },
  'review-change': { assets: '../assets/review-change', name: 'Review a change' },
  'fix-bug': { assets: '../assets/fix-bug', name: 'Fix a reproduced bug' },
};
const [mode, project, configPath] = process.argv.slice(2);
if (!['inspect','create'].includes(mode) || !project) throw new Error('Usage: setup-project.mjs inspect PROJECT | create PROJECT CONFIG.json');
const root = resolve(project);
// Check every existing ancestor, not just the last directory.
async function directories(path) {
  const parent = dirname(path);
  if (parent !== path) await directories(parent);
  try { const stat = await lstat(path); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Not a regular directory: ${path}`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
await directories(root);
if (!(await lstat(root)).isDirectory()) throw new Error('Project must exist');
const lines = join(root,'.fabro','lines');
await directories(lines);
if (mode === 'inspect') {
  const markers = [];
  for (const name of ['package.json','package-lock.json','bun.lock','bun.lockb','pnpm-lock.yaml','yarn.lock','Cargo.toml','pyproject.toml','uv.lock','go.mod','Makefile','AGENTS.md']) {
    try { if ((await lstat(join(root,name))).isFile()) markers.push(name); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  }
  let scripts = {};
  if (markers.includes('package.json')) { const p = JSON.parse(await readFile(join(root,'package.json'),'utf8')); scripts = p.scripts ?? {}; }
  let existing = []; try { existing = await readdir(lines); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  console.log(JSON.stringify({ project: root, markers, scripts, existingLines: existing, recipes: Object.keys(catalog), note: 'Suggested commands require inspection; nothing was executed.' },null,2));
} else {
  if (!configPath) throw new Error('Configuration path required');
  const config = JSON.parse(await readFile(resolve(configPath),'utf8'));
  const allowed = ['recipes','setupCommands','validationCommands','qualityCommand','scope','environment'];
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !allowed.includes(k))) throw new Error('Unknown setup configuration field');
  const strings = (value,min,max) => Array.isArray(value) && value.length >= min && value.length <= max && value.every(v => typeof v === 'string' && v.trim() && v.length <= 1000);
  if (!strings(config.recipes,1,4) || new Set(config.recipes).size !== config.recipes.length || config.recipes.some(n => !Object.hasOwn(catalog,n))) throw new Error('Choose unique known recipes');
  if (!strings(config.validationCommands,1,12) || !strings(config.setupCommands ?? [],0,8) || typeof config.qualityCommand !== 'string' || !config.qualityCommand.trim() || config.qualityCommand.length > 1000) throw new Error('Supply explicit setup, validation and quality commands');
  if (!strings(config.scope,1,30) || config.scope.some(p => p.startsWith('/') || p.includes('\\') || p.includes('\0') || p.split('/').includes('..'))) throw new Error('Supply repository-relative scope');
  if (config.environment !== undefined && (typeof config.environment !== 'string' || !config.environment.trim() || config.environment.length > 100)) throw new Error('Invalid environment');
  // Preflight the entire selection before creating anything.
  for (const name of config.recipes) {
    try { await lstat(join(lines,name)); throw new Error(`Line exists; refusing overwrite: ${name}`); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  }
  const prepared = [];
  for (const name of config.recipes) {
    const relative = `.fabro/lines/${name}`;
    const assetPath = resolve(home,catalog[name].assets);
    const files = {};
    for (const file of ['line.json','workflow.fabro','runner.mjs']) files[file] = (await readFile(join(assetPath,file),'utf8')).replaceAll('__LINE_DIR__',relative);
    const manifest = JSON.parse(files['line.json']); manifest.environment = config.environment ?? 'local';
    files['line.json'] = JSON.stringify(manifest,null,2)+'\n';
    const inputs = { setupCommands: config.setupCommands ?? [], validationCommands: config.validationCommands, qualityCommand: config.qualityCommand, qualityMode: 'gate' };
    if (name === 'implement-plan') inputs.planPath = 'docs/plans/REPLACE_WITH_APPROVED_PLAN.md';
    if (name === 'review-change') inputs.reviewBaseSha = 'REPLACE_WITH_FULL_REVIEW_BASE_SHA';
    if (name === 'fix-bug') Object.assign(inputs,{ reproductionCommand: 'REPLACE_WITH_REPRODUCTION_COMMAND', expectedFailureExitCode: 1, regressionPaths: ['REPLACE_WITH_COMMITTED_REGRESSION_TEST'] });
    files['work-order.example.json'] = JSON.stringify({ requestKey: `${name}-1`, workOrder: {
      title: catalog[name].name, displayTitle: catalog[name].name, objective: 'REPLACE_WITH_CONCRETE_OBJECTIVE', baseSha: 'REPLACE_WITH_FULL_COMMIT_SHA', line: `${relative}/line.json`, inputs, scope: config.scope,
      constraints: ['Preserve repository instructions and unrelated behavior; do not weaken checks or edit line definitions.', 'No merge, push, deployment or external comments.'],
      acceptanceCriteria: ['REPLACE_WITH_TASK_SPECIFIC_CRITERIA', 'Pass configured checks and satisfy the line delivery contract.'], maxAttempts: name === 'implement-plan' ? 3 : 2, maxMinutes: name === 'implement-plan' ? 60 : 30, maxChangedFiles: 10,
    }},null,2)+'\n';
    files['README.md'] = `# ${catalog[name].name}\n\nRecipe edition 1, maintained by the BB Fabro plugin; inspired by https://docs.fabro.sh/examples/repl-handoff and https://docs.fabro.sh/examples/definition-of-done. Project-owned copy; plugin updates never overwrite it. Review line.json, workflow.fabro and runner.mjs.\n\nValidation commands:\n${config.validationCommands.map(c => '- '+c).join('\n')}\n\nQuality: ${config.qualityCommand}\n\nComplete all REPLACE_WITH fields in work-order.example.json, freeze the task scope and criteria, and commit the line before submission. Commands are copied, not executed by setup. Run baseline and isolated failure-path checks before the first model run. Use the assembly-lines skill for an explicitly requested execution.\n\n${name === 'fix-bug' ? 'Commit a real failing regression first. Keep it outside the repair scope; the runner protects regressionPaths. Existing baseline checks must pass independently of that regression. For Node, moving a *.test.mjs file to another directory may still leave it in automatic discovery; use an explicit baseline test selection or a separately invoked reproducer outside the discovery pattern. A nonzero exit alone is not proof of a bug: inspect the failure.\n' : name === 'review-change' ? 'reviewBaseSha must be an ancestor of baseSha. Review covers that range restricted to scope. Checks must pass at baseline. Source changes are rejected; reviewed means the review completed, not that findings were approved.\n' : name === 'implement-plan' ? 'The approved plan must be a committed Markdown file at baseSha. All task criteria must be covered and reviewed before delivery.\n' : 'Require a concrete quality improvement and preserved behavior, not merely successful commands.\n'}`;
    prepared.push({name,files});
  }
  await mkdir(lines,{recursive:true});
  // Exclusive mkdir reservations prevent overwrites; rollback only our new directories.
  const installed = [];
  try {
    for (const {name,files} of prepared) {
      const target = join(lines,name); await mkdir(target); installed.push(target);
      for (const [file,content] of Object.entries(files)) await writeFile(join(target,file),content,{flag:'wx'});
    }
  } catch(e) { for (const path of installed) await rm(path,{recursive:true,force:true}); throw e; }
  console.log(JSON.stringify({created:prepared.map(p => join(lines,p.name,'line.json')), readyToRun:false, next:'Customize task placeholders, validate schemas/graphs and baseline/failure paths, then commit before explicitly submitting.'},null,2));
}
