import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), Ajv=require('ajv');
const script=fileURLToPath(new URL('./setup-project.mjs',import.meta.url));
const names=['refactor-code-quality','implement-plan','review-change','fix-bug'];
function fixture(t,recipes=names){
 const root=mkdtempSync(join(tmpdir(),'fabro-setup-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const run=(cmd,args)=>spawnSync(cmd,args,{cwd:root,encoding:'utf8'});
 const ok=(cmd,args)=>{const r=run(cmd,args);assert.equal(r.status,0,r.stderr);return r.stdout;};
 const write=(p,s)=>writeFileSync(join(root,p),s);
 write('package.json',JSON.stringify({scripts:{test:'node --check math.cjs'}}));
 write('plan.md','# Approved plan\nChange math implementation.\n');
 write('math.cjs','module.exports = x => x + 1;\n');
 write('regression.cjs',"require('node:assert/strict').equal(require('./math.cjs')(2),4);\n");
 write('config.json',JSON.stringify({recipes,validationCommands:['node --check math.cjs'],qualityCommand:'git diff --check',scope:['math.cjs']}));
 const create=()=>run(process.execPath,[script,'create',root,join(root,'config.json')]);
 assert.equal(create().status,0);
 ok('git',['init','-q']);ok('git',['config','user.name','Fixture']);ok('git',['config','user.email','fixture@localhost']);
 ok('git',['add','.']);ok('git',['commit','-qm','base']);const sha=ok('git',['rev-parse','HEAD']).trim();
 mkdirSync(join(root,'.fabro-input'));
 const order=name=>{const o=JSON.parse(readFileSync(join(root,'.fabro/lines',name,'work-order.example.json'))).workOrder;o.baseSha=sha;o.objective='Verify recipe';return o;};
 const input=o=>write('.fabro-input/work-order.json',JSON.stringify(o));
 const phase=(name,p)=>run(process.execPath,[join(root,'.fabro/lines',name,'runner.mjs'),p]);
 const delivery=name=>{const d=JSON.parse(readFileSync(join(root,'.fabro-output/delivery.json')));const m=JSON.parse(readFileSync(join(root,'.fabro/lines',name,'line.json')));const v=new Ajv().compile(m.outputSchema);assert.ok(v(d),JSON.stringify(v.errors));return d;};
 return {root,run,ok,write,create,sha,order,input,phase,delivery};
}
test('all recipes compile, graphs validate, inspection does not execute scripts, overwrite refused',t=>{
 const f=fixture(t);f.write('package.json',JSON.stringify({scripts:{test:'touch EXECUTED'}}));
 const r=f.run(process.execPath,[script,'inspect',f.root]);assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).scripts.test,'touch EXECUTED');assert.ok(!existsSync(join(f.root,'EXECUTED')));
 for(const name of names){const dir=join(f.root,'.fabro/lines',name);const m=JSON.parse(readFileSync(join(dir,'line.json')));const inputs=f.order(name).inputs;if(name==='implement-plan')inputs.planPath='plan.md';if(name==='review-change')inputs.reviewBaseSha=f.sha;if(name==='fix-bug')Object.assign(inputs,{reproductionCommand:'node regression.cjs',expectedFailureExitCode:1,regressionPaths:['regression.cjs']});const validate=new Ajv().compile(m.inputSchema);assert.ok(validate(inputs),JSON.stringify(validate.errors));new Ajv().compile(m.outputSchema);assert.ok(!readFileSync(join(dir,'workflow.fabro'),'utf8').includes('__LINE_DIR__'));const cli=process.env.FABRO_BIN; if(cli)f.ok(cli,['validate',join(dir,'workflow.fabro')]);}
 assert.notEqual(f.create().status,0);
});
test('reject traversal and symlink destinations',t=>{
 const f=fixture(t,['refactor-code-quality']);
 f.write('config.json',JSON.stringify({recipes:['review-change','refactor-code-quality'],validationCommands:['node --check math.cjs'],qualityCommand:'git diff --check',scope:['math.cjs']}));assert.notEqual(f.create().status,0);assert.ok(!existsSync(join(f.root,'.fabro/lines/review-change')));
 f.write('config.json',JSON.stringify({recipes:['fix-bug'],validationCommands:['node --check math.cjs'],qualityCommand:'git diff --check',scope:['../outside']}));assert.notEqual(f.create().status,0);assert.ok(!existsSync(join(f.root,'.fabro/lines/fix-bug')));
 rmSync(join(f.root,'.fabro'),{recursive:true});symlinkSync(tmpdir(),join(f.root,'.fabro'));assert.notEqual(f.create().status,0);
});
test('review produces evidence without source changes and rejects edits',t=>{
 const f=fixture(t,['review-change']);const o=f.order('review-change');o.inputs.reviewBaseSha=f.sha;f.write('math.cjs','module.exports = x => x * 2;\n');f.ok('git',['add','math.cjs']);f.ok('git',['commit','-qm','change']);o.baseSha=f.ok('git',['rev-parse','HEAD']).trim();f.input(o);
 assert.equal(f.phase('review-change','baseline').status,0);
 assert.match(readFileSync(join(f.root,'.fabro-output/target.patch'),'utf8'),/x \* 2/);
 f.write('.fabro-output/review.md','Reviewed multiplication change.');assert.equal(f.phase('review-change','deliver').status,0);assert.equal(f.delivery('review-change').outcome,'reviewed');
 f.write('math.cjs','module.exports = x => x * 3;\n');assert.notEqual(f.phase('review-change','deliver').status,0);
});
test('bug recipe requires red, preserves regression, and delivers green',t=>{
 const f=fixture(t,['fix-bug']);const o=f.order('fix-bug');Object.assign(o.inputs,{reproductionCommand:'node regression.cjs',expectedFailureExitCode:1,regressionPaths:['regression.cjs']});f.input(o);
 assert.equal(f.phase('fix-bug','baseline').status,0);assert.equal(f.phase('fix-bug','begin-attempt').status,0);assert.notEqual(f.phase('fix-bug','validate').status,0);
 f.write('math.cjs','module.exports = x => x * 2;\n');assert.equal(f.phase('fix-bug','validate').status,0);
 f.write('regression.cjs','// weakened\n');assert.notEqual(f.phase('fix-bug','validate').status,0);f.ok('git',['checkout','--','regression.cjs']);
 f.write('.fabro-output/review.md','Confirmed unchanged regression fails before and passes after.');assert.equal(f.phase('fix-bug','deliver').status,0);const d=f.delivery('fix-bug');assert.equal(d.reproductionBefore.exitCode,1);assert.equal(d.reproductionAfter.exitCode,0);
});
test('unreproduced bugs stop before implementation',t=>{
 const f=fixture(t,['fix-bug']);const o=f.order('fix-bug');Object.assign(o.inputs,{reproductionCommand:'node --check regression.cjs',expectedFailureExitCode:1,regressionPaths:['regression.cjs']});f.input(o);assert.notEqual(f.phase('fix-bug','baseline').status,0);assert.notEqual(f.phase('fix-bug','begin-attempt').status,0);
});
test('quality failures block baseline and attempt exhaustion blocks retry',t=>{
 const f=fixture(t,['refactor-code-quality']);const o=f.order('refactor-code-quality');o.inputs.qualityCommand='node -e "process.exit(9)"';f.input(o);assert.notEqual(f.phase('refactor-code-quality','baseline').status,0);
 o.inputs.qualityCommand='git diff --check';o.maxAttempts=1;f.input(o);assert.equal(f.phase('refactor-code-quality','baseline').status,0);assert.equal(f.phase('refactor-code-quality','begin-attempt').status,0);assert.notEqual(f.phase('refactor-code-quality','begin-attempt').status,0);
});

test('approved-plan recipe requires finished tasks and criterion review',t=>{
 const f=fixture(t,['implement-plan']);const o=f.order('implement-plan');o.inputs.planPath='plan.md';o.acceptanceCriteria=['Implement approved behavior'];f.input(o);
 assert.equal(f.phase('implement-plan','baseline').status,0);
 const tasks=[{id:'math',title:'Change math',criteria:[0],done:false}];f.write('.fabro-output/progress.json',JSON.stringify({tasks}));
 assert.equal(f.phase('implement-plan','check-plan').status,0);assert.equal(f.phase('implement-plan','begin-attempt').status,0);
 f.write('math.cjs','module.exports = x => x * 2;\n');assert.equal(f.phase('implement-plan','validate').status,0);
 f.write('.fabro-output/review.md','Verified behavior.');assert.notEqual(f.phase('implement-plan','deliver').status,0);
 tasks[0].done=true;f.write('.fabro-output/progress.json',JSON.stringify({tasks}));assert.notEqual(f.phase('implement-plan','deliver').status,0);
 f.write('.fabro-output/review.json',JSON.stringify({verdict:'accept',criteria:[{index:0,passed:true,evidence:'Inspected math implementation and passing checks.'}]}));
 assert.equal(f.phase('implement-plan','deliver').status,0);assert.equal(f.delivery('implement-plan').tasks[0].done,true);
});
