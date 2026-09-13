#!/usr/bin/env node
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [project, name = 'refactor-code-quality'] = process.argv.slice(2);
if (!project || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('Usage: node create-refactor-line.mjs PROJECT [line-name]');
const root = resolve(project);
// Refuse symlink directories: generation must stay in the selected project.
for (const path of [root, join(root,'.fabro'), join(root,'.fabro','lines')]) {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`Symlink directory: ${path}`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const relative = `.fabro/lines/${name}`;
const target = join(root,relative);
await mkdir(dirname(target), {recursive:true});
await mkdir(target); // EEXIST deliberately refuses to overwrite a project line.
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/refactor-line');
for (const file of ['line.json','workflow.fabro','runner.mjs']) {
  const content = (await readFile(join(assets,file),'utf8')).replaceAll('__LINE_DIR__',relative);
  await writeFile(join(target,file),content,{flag:'wx'});
}
console.log(join(target,'line.json'));
