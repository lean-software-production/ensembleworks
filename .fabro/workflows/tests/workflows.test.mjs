import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const lines = fileURLToPath(new URL('../', import.meta.url));
const git = (cwd,...args) => execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
function fixture(t, name, {inputs={},scope=['src'],attempts=2}={}) {
  const cwd = mkdtempSync(join(tmpdir(),'fabro-line-test-')); t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  mkdirSync(join(cwd,'.fabro/workflows'),{recursive:true}); cpSync(join(lines,name),join(cwd,'.fabro/workflows',name),{recursive:true});
  mkdirSync(join(cwd,'src')); writeFileSync(join(cwd,'src/feature.js'),'export const value = 1;\n');
  writeFileSync(join(cwd,'feature-plan.md'),'# Approved feature\nAdd the planned behavior and cover it with tests.\n');
  writeFileSync(join(cwd,'.gitignore'),'node_modules/\n.fabro-input/\n.fabro-output/\n');
  git(cwd,'init','-q');git(cwd,'config','user.name','Test');git(cwd,'config','user.email','test@example.com');git(cwd,'add','.');git(cwd,'commit','-qm','fixture');
  const baseSha = git(cwd,'rev-parse','HEAD');
  mkdirSync(join(cwd,'.fabro-input'));mkdirSync(join(cwd,'.fabro-output'));
  const order = {title:'Feature',objective:'Implement the approved feature',baseSha,workflow:`.fabro/workflows/${name}/workflow.json`,inputs:{planPath:'feature-plan.md',validationCommands:['node --check src/feature.js'],qualityCommand:'git diff --check',...inputs},scope,constraints:[],acceptanceCriteria:['Behavior implemented','Regression covered'],maxAttempts:attempts,maxMinutes:5,maxChangedFiles:5};
  writeFileSync(join(cwd,'.fabro-input/work-order.json'),JSON.stringify(order));
  const write = (name,value) => writeFileSync(join(cwd,'.fabro-output',name),typeof value==='string'?value:JSON.stringify(value));
  const run = phase => spawnSync(process.execPath,[`.fabro/workflows/${name}/runner.mjs`,phase],{cwd,encoding:'utf8'});
  return {cwd,baseSha,order,write,run};
}
const tasks = [{id:'one',title:'Implement behavior',done:false,criteria:[0]},{id:'two',title:'Cover regression',done:false,criteria:[1]}];
const reviewed = {verdict:'accept',criteria:[{index:0,passed:true,evidence:'Inspected behavior and test output'},{index:1,passed:true,evidence:'Regression test passed'}]};
function plan(f) { f.write('progress.json',{tasks:structuredClone(tasks)});assert.equal(f.run('check-plan').status,0); }

test('Ralph retains task progress across iterations and delivers only a complete reviewed plan',t=>{
  const f=fixture(t,'implement-plan');assert.equal(f.run('baseline').status,0);plan(f);assert.equal(f.run('begin-attempt').status,0);
  writeFileSync(join(f.cwd,'src/feature.js'),'export const value = 2;\n');
  f.write('progress.json',{tasks:tasks.map((x,i)=>({...x,done:i===0}))});f.write('review.md','Independent review of actual change');f.write('review.json',reviewed);
  assert.equal(f.run('validate').status,0);assert.match(f.run('deliver').stderr,/unfinished tasks/);
  assert.equal(f.run('begin-attempt').status,0);f.write('progress.json',{tasks:tasks.map(x=>({...x,done:true}))});
  f.write('review.json',{verdict:'accept',criteria:[reviewed.criteria[0]]});assert.match(f.run('deliver').stderr,/review is incomplete/);
  f.write('review.json',reviewed);assert.equal(f.run('deliver').status,0);
  const result=JSON.parse(readFileSync(join(f.cwd,'.fabro-output/delivery.json'),'utf8'));
  assert.equal(result.attempts,2);assert.equal(result.plan.baseSha,f.baseSha);assert.equal(result.plan.sha256.length,64);assert.equal(result.tasks.length,2);
  assert.deepEqual(result.changedFiles,['src/feature.js']);assert.equal(result.resultSha,git(f.cwd,'rev-parse','HEAD'));
  assert.match(f.run('begin-attempt').stderr,/budget exhausted/);
});

test('Ralph rejects incomplete coverage, rewritten task definitions, and changes to the approved plan',t=>{
  const f=fixture(t,'implement-plan');assert.equal(f.run('baseline').status,0);
  f.write('progress.json',{tasks:[tasks[0]]});assert.match(f.run('check-plan').stderr,/every work-order acceptance/);
  plan(f);f.write('progress.json',{tasks:tasks.map(x=>({...x,title:'different'}))});assert.match(f.run('begin-attempt').stderr,/cannot be redefined/);
  f.write('progress.json',{tasks});assert.equal(f.run('begin-attempt').status,0);
  writeFileSync(join(f.cwd,'feature-plan.md'),'Changed plan\n');assert.match(f.run('validate').stderr,/scope/);
  assert.match(readFileSync(join(f.cwd,'.fabro-output/approved-plan.md'),'utf8'),/# Approved feature/);
});

test('Ralph requires a committed plan and refuses failed validation',t=>{
  const missing=fixture(t,'implement-plan',{inputs:{planPath:'missing.md'}});assert.match(missing.run('baseline').stderr,/committed regular file/);
  const f=fixture(t,'implement-plan');assert.equal(f.run('baseline').status,0);plan(f);assert.equal(f.run('begin-attempt').status,0);
  writeFileSync(join(f.cwd,'src/feature.js'),'syntax is broken {{{');assert.match(f.run('validate').stderr,/Validation failed/);
  assert.equal(existsSync(join(f.cwd,'.fabro-output/delivery.json')),false);
});

test('live Ralph graph repairs a failed iteration and returns a complete delivery', {skip: !process.env.FABRO_GRAPH_TEST, timeout:75000}, async t=>{
  const f=fixture(t,'implement-plan');
  const fake = `import {readFileSync,writeFileSync} from 'node:fs';
const phase=process.argv[2];const tasks=${JSON.stringify(tasks)};
if(phase==='plan')writeFileSync('.fabro-output/progress.json',JSON.stringify({tasks}));
if(phase==='implement'){
 const attempt=JSON.parse(readFileSync('.fabro-output/execution.json')).attempts;
 writeFileSync('src/feature.js',attempt===1?'broken {{{':'export const value = 2;\\n');
 writeFileSync('.fabro-output/progress.json',JSON.stringify({tasks:tasks.map(t=>({...t,done:attempt>1}))}));
}
if(phase==='review'){
 writeFileSync('.fabro-output/review.md','Independent fixture review');
 writeFileSync('.fabro-output/review.json',JSON.stringify(${JSON.stringify(reviewed)}));
}`;
  writeFileSync(join(f.cwd,'.fabro-input/fake-agent.mjs'),fake);
  let source=readFileSync(join(f.cwd,'.fabro/workflows/implement-plan/workflow.fabro'),'utf8');
  for(const id of ['plan','implement','review'])source=source.replace(new RegExp('^  '+id+' \\[.*\\]$','m'),`  ${id} [shape=parallelogram, goal_gate=true, script="node .fabro-input/fake-agent.mjs ${id}"]`);
  source=source.replace('condition="preferred_label=Accept"','condition="outcome=succeeded"');
  const base='http://127.0.0.1:3000';
  const {homedir}=await import('node:os');
  const token=JSON.parse(readFileSync(join(homedir(),'.fabro/auth.json'),'utf8')).servers[base].token;
  const call=async(path,body)=>{
    const response=await fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Fabro API '+response.status);
    return response.json();
  };
  const run=await call('/runs',{version:1,identifier:'workflow.fabro',cwd:f.cwd,title:'Ralph line shell regression',goal:{type:'value',text:'Verify project Ralph loop'},args:{environment:'local',auto_approve:true,label:['bb_test=ralph-project-workflow']},target:{identifier:'workflow.fabro',path:'workflow.fabro'},workflows:{'workflow.fabro':{identifier:'workflow.fabro',source}}});
  console.log('Ralph regression run',run.id);await call('/runs/'+run.id+'/start',{});
  let status;const deadline=Date.now()+60000;
  do {status=(await call('/runs/'+run.id)).lifecycle.status.kind;if(['succeeded','failed','dead'].includes(status))break;await new Promise(resolve=>setTimeout(resolve,500));}while(Date.now()<deadline);
  assert.equal(status,'succeeded');
  const delivery=JSON.parse(readFileSync(join(f.cwd,'.fabro-output/delivery.json'),'utf8'));
  assert.equal(delivery.attempts,2);assert.equal(delivery.tasks.every(t=>t.done),true);assert.equal(delivery.plan.baseSha,f.baseSha);
});
