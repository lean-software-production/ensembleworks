
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.cwd();
const input = resolve(root, '.fabro-input');
const output = resolve(root, '.fabro-output');
mkdirSync(output, {recursive: true});
const envelope = JSON.parse(readFileSync(resolve(input, 'work-order.json'), 'utf8'));
const order = {...envelope, ...envelope.inputs};
const phase = process.argv[2];
const statePath = resolve(output, 'execution.json');
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {startedAt: Date.now(), attempts: 0};
const save = (name, value) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2));
const git = args => execFileSync('git', args, {encoding:'utf8', maxBuffer:8 * 1024 * 1024});
function remaining() {
  const ms = order.maxMinutes * 60000 - (Date.now() - state.startedAt);
  if (ms <= 0) throw new Error('Work-order time budget exhausted');
  return ms;
}
function execute(command, label) {
  const result = spawnSync('sh', ['-lc', command], {cwd:root, encoding:'utf8', timeout:remaining(), maxBuffer:1024 * 1024, killSignal:'SIGKILL'});
  const record = {command, exitCode:result.status, signal:result.signal, error:result.error?.message ?? null,
    stdout: String(result.stdout ?? '').slice(-100000), stderr:String(result.stderr ?? '').slice(-100000)};
  save(label + '.json', record);
  return record;
}
const passed = record => record.exitCode === 0 && !record.error && !record.signal;
function checks(prefix) {
  const results = order.validationCommands.map((command,i) => execute(command,prefix+'-check-'+i));
  const quality = execute(order.qualityCommand,prefix+'-quality');
  if (quality.error || quality.signal || quality.exitCode === null || quality.exitCode >= 126) throw new Error('Quality command could not run');
  return {checks:results, quality, passed:results.every(passed) && (order.qualityMode === 'report' || passed(quality))};
}
function changedPaths() {
  // Compare against the submitted base, including staged, committed and untracked work.
  const tracked = git(['diff','--no-renames','--name-only','-z',order.baseSha,'--']).split('\0').filter(Boolean);
  const untracked = git(['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
  return [...new Set([...tracked,...untracked])].filter(p => !p.startsWith('.fabro-input/') && !p.startsWith('.fabro-output/')).sort();
}
function policy() {
  const changed = changedPaths();
  const inScope = changed.every(file => file !== order.planPath && !file.startsWith('.fabro/workflows/') && order.scope.some(raw => {
    const prefix = raw.replace(/^\.\//,'').replace(/\/$/,'');
    return prefix === '.' || file === prefix || file.startsWith(prefix + '/');
  }));
  const result = {changed, inScope, maxChangedFiles:order.maxChangedFiles, passed:inScope && changed.length <= order.maxChangedFiles};
  save('scope.json',result);
  if (!result.passed) throw new Error('Changes exceed the agreed scope or file limit');
  git(['diff','--check',order.baseSha,'--']);
  return result;
}
function capturePlan() {
  const path = order.planPath;
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(p => p === '..' || p === '.' || !p) || !path.endsWith('.md')) throw new Error('planPath must be a repository-relative Markdown file');
  const entry = git(['ls-tree',order.baseSha,'--',path]);
  if (!/^100(?:644|755) blob /.test(entry)) throw new Error('The approved plan must be a committed regular file at baseSha');
  const text = execFileSync('git',['show',order.baseSha+':'+path],{encoding:'utf8',maxBuffer:64000});
  if (!text.trim() || Buffer.byteLength(text) > 64000) throw new Error('Approved plan must contain 1–64000 bytes');
  const plan = {path, baseSha:order.baseSha, sha256:createHash('sha256').update(text).digest('hex')};
  writeFileSync(resolve(output,'approved-plan.md'),text);
  save('plan-source.json',plan);
  return plan;
}
function progress(complete = false) {
  const value = JSON.parse(readFileSync(resolve(output,'progress.json'),'utf8'));
  const tasks = value.tasks;
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 30) throw new Error('Progress must contain 1–30 tasks');
  const ids = new Set(); const covered = new Set();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id.trim() || ids.has(task.id) || typeof task.title !== 'string' || !task.title.trim() || typeof task.done !== 'boolean') throw new Error('Task IDs must be unique with title and done flag');
    ids.add(task.id);
    if (!Array.isArray(task.criteria) || !task.criteria.length || task.criteria.some(i => !Number.isInteger(i) || i < 0 || i >= order.acceptanceCriteria.length)) throw new Error('Each task must reference valid zero-based acceptance criterion indexes');
    task.criteria.forEach(i => covered.add(i));
    if (complete && !task.done) throw new Error('The approved plan still has unfinished tasks');
  }
  if (covered.size !== order.acceptanceCriteria.length) throw new Error('Tasks must cover every work-order acceptance criterion');
  const definitions = tasks.map(t => ({id:t.id,title:t.title,criteria:t.criteria}));
  if (state.taskDefinitions && JSON.stringify(definitions) !== JSON.stringify(state.taskDefinitions)) throw new Error('The approved task checklist cannot be redefined');
  return tasks;
}
function criterionReview() {
  const review = JSON.parse(readFileSync(resolve(output,'review.json'),'utf8'));
  if (review.verdict !== 'accept' || !Array.isArray(review.criteria) || review.criteria.length !== order.acceptanceCriteria.length) throw new Error('Independent acceptance review is incomplete');
  const indexes = new Set();
  for (const item of review.criteria) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= order.acceptanceCriteria.length || indexes.has(item.index) || item.passed !== true || typeof item.evidence !== 'string' || !item.evidence.trim()) throw new Error('Every criterion needs a distinct passing evidence-backed review');
    indexes.add(item.index);
  }
  return review;
}
try {
  remaining();
  if (phase === 'baseline') {
    capturePlan();
    if (state.baseline) throw new Error('Baseline already captured; create a new job rather than replacing it');
    for (const [i,command] of (order.setupCommands ?? []).entries()) {
      if (!passed(execute(command,'setup-'+i))) throw new Error('Dependency setup failed');
    }
    if (changedPaths().length) throw new Error('Setup changed tracked or untracked repository files');
    const baseline = checks('baseline');
    save('baseline.json',baseline);
    if (!baseline.passed) throw new Error('Baseline validation failed');
    state.baseline = true; save('execution.json',state);
  } else if (phase === 'check-plan') {
    if (!state.baseline) throw new Error('No passing baseline');
    state.taskDefinitions = progress().map(t => ({id:t.id,title:t.title,criteria:t.criteria}));
    save('execution.json',state);
  } else if (phase === 'begin-attempt') {
    if (!state.taskDefinitions) throw new Error('Task checklist has not been approved by check-plan');
    if (!state.baseline) throw new Error('No passing baseline');
    progress();
    state.attempts += 1;
    if (state.attempts > order.maxAttempts) throw new Error('Repair attempt budget exhausted');
    save('execution.json',state);
  } else if (phase === 'validate') {
    if (!state.baseline) throw new Error('No passing baseline');
    const validation = checks('after');
    save('validation.json',validation);
    policy();
    if (!validation.passed) throw new Error('Validation failed');
  } else if (phase === 'deliver') {
    if (!state.baseline) throw new Error('No passing baseline');
    if (!state.taskDefinitions) throw new Error('Task checklist has not been approved by check-plan');
    const tasks = progress(true);
    const reviewedCriteria = criterionReview();
    const plan = capturePlan();
    // Recheck after the reviewer: review must not make unvalidated changes.
    const finalChecks = checks('final'); save('final.json',finalChecks);
    if (!finalChecks.passed) throw new Error('Final validation failed');
    const scope = policy();
    if (!scope.changed.length) throw new Error('Feature delivery requires a source change');
    const baseline = JSON.parse(readFileSync(resolve(output,'baseline.json'),'utf8'));
    const reviewPath = resolve(output,'review.md');
    if (!existsSync(reviewPath)) throw new Error('No review evidence');
    const review = readFileSync(reviewPath,'utf8').slice(0,30000);
    if (!review.trim()) throw new Error('Empty review evidence');
    if (scope.changed.length) {
      // Explicit paths avoid accidentally committing workflow scratch files.
      execFileSync('git',['--literal-pathspecs','add','-A','--',...scope.changed],{stdio:'inherit'});
      // Also refuse pre-staged artifacts or changes outside the work order.
      const staged = git(['diff','--cached','--name-only','-z']).split('\0').filter(Boolean);
      if (staged.some(path => !scope.changed.includes(path))) throw new Error('Unexpected staged files');
      const hasStaged = spawnSync('git',['diff','--cached','--quiet']);
      if (hasStaged.status === 1) execFileSync('git',['-c','user.name=Fabro','-c','user.email=fabro@localhost','commit','-m','feat: implement approved plan'],{stdio:'inherit'});
      else if (hasStaged.status !== 0) throw new Error('Cannot inspect staged changes');
    }
    const resultSha = git(['rev-parse','HEAD']).trim();
    const delivery = {plan,tasks,criterionReview:reviewedCriteria,baseSha:order.baseSha,resultSha,objective:order.objective,changedFiles:scope.changed,
      outcome:scope.changed.length ? 'changed' : 'no_change',attempts:state.attempts,
      before:baseline,after:finalChecks,review,completedAt:new Date().toISOString()};
    save('delivery.json',delivery);
    writeFileSync(resolve(output,'diff.patch'),git(['diff','--binary',order.baseSha,resultSha,'--']));
    process.stdout.write(JSON.stringify({resultSha,changedFiles:scope.changed,outcome:delivery.outcome})+'\n');
  } else throw new Error('Unknown workflow phase');
} catch (error) {
  save('failure.json',{phase,error:error.message,at:new Date().toISOString()});
  process.stderr.write(error.message+'\n'); process.exitCode=1;
}
