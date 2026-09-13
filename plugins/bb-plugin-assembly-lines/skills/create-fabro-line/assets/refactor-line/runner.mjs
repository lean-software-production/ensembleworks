
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
  const inScope = changed.every(file => order.scope.some(raw => {
    const prefix = raw.replace(/^\.\//,'').replace(/\/$/,'');
    return prefix === '.' || file === prefix || file.startsWith(prefix + '/');
  }));
  const result = {changed, inScope, maxChangedFiles:order.maxChangedFiles, passed:inScope && changed.length <= order.maxChangedFiles};
  save('scope.json',result);
  if (!result.passed) throw new Error('Changes exceed the agreed scope or file limit');
  git(['diff','--check',order.baseSha,'--']);
  return result;
}
try {
  remaining();
  if (phase === 'baseline') {
    if (state.baseline) throw new Error('Baseline already captured; create a new job rather than replacing it');
    for (const [i,command] of (order.setupCommands ?? []).entries()) {
      if (!passed(execute(command,'setup-'+i))) throw new Error('Dependency setup failed');
    }
    if (changedPaths().length) throw new Error('Setup changed tracked or untracked repository files');
    const baseline = checks('baseline');
    save('baseline.json',baseline);
    if (!baseline.passed) throw new Error('Baseline validation failed');
    state.baseline = true; save('execution.json',state);
  } else if (phase === 'begin-attempt') {
    if (!state.baseline) throw new Error('No passing baseline');
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
    // Recheck after the reviewer: review must not make unvalidated changes.
    const finalChecks = checks('final'); save('final.json',finalChecks);
    if (!finalChecks.passed) throw new Error('Final validation failed');
    const scope = policy();
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
      if (hasStaged.status === 1) execFileSync('git',['-c','user.name=Assembly Lines','-c','user.email=assembly-lines@localhost','commit','-m','refactor: improve code quality'],{stdio:'inherit'});
      else if (hasStaged.status !== 0) throw new Error('Cannot inspect staged changes');
    }
    const resultSha = git(['rev-parse','HEAD']).trim();
    const delivery = {baseSha:order.baseSha,resultSha,objective:order.objective,changedFiles:scope.changed,
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
