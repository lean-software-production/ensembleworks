import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath, lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { FabroClient, type CreateRunIntent, type FabroClientOptions } from './fabro';
import { hostContract, type FabroHost, type PreparedAssemblyLine } from './host-contract';
import { readProjectLine, lineManifestSchema, validateLineValue } from './project-line';
import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from '@get-bb/plugin-sdk';

const execFileAsync = promisify(execFile);
const SAFE_JOB = /^[a-zA-Z0-9_-]{1,100}$/;
export interface FabroHostOptions extends FabroClientOptions { workspaceRoot?: string }
export async function git(sourcePath: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await execFileAsync('git', ['-C', sourcePath, ...args], {maxBuffer: 1024 * 1024, signal});
  return result.stdout.trim();
}
async function authToken(endpoint: string, explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  const origin = endpoint.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
  try {
    const parsed = JSON.parse(await readFile(join(homedir(), '.fabro', 'auth.json'), 'utf8')) as {servers?: Record<string, {kind?: string; token?: string}>};
    const record = parsed.servers?.[origin];
    return record?.kind === 'dev-token' && typeof record.token === 'string' ? record.token : undefined;
  } catch { return undefined; }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }

export function createFabroHost(options: FabroHostOptions = {}): FabroHost {
  const client = new FabroClient(options);
  const workspaceRoot = resolve(options.workspaceRoot ?? join(homedir(), '.local/share/bb-assembly-lines'));
  return {
    async prepare(input): Promise<PreparedAssemblyLine> {
      if (!SAFE_JOB.test(input.jobId)) throw new Error('Invalid assembly-line job ID');
      const sourcePath = await realpath(input.sourcePath);
      const base = await git(sourcePath, ['rev-parse', '--verify', `${input.baseSha}^{commit}`], options.signal);
      if (base.toLowerCase() !== input.baseSha.toLowerCase()) throw new Error('The submitted commit could not be resolved exactly');
      const reserved = await git(sourcePath, ['ls-tree', '-r', '--name-only', base, '--', '.fabro-input', '.fabro-output'], options.signal);
      if (reserved) throw new Error('The repository already tracks reserved .fabro-input or .fabro-output paths');
      const jobRoot = join(workspaceRoot, input.jobId);
      const workspacePath = join(jobRoot, 'checkout');
      const identityPath = join(jobRoot, 'identity.json');
      const identity = JSON.stringify({sourcePath,baseSha:base,workOrderHash:hash(JSON.stringify(input.workOrder))});
      await mkdir(jobRoot, {recursive:true});
      try { await writeFile(identityPath, identity, {flag:'wx',mode:0o600}); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await readFile(identityPath,'utf8') !== identity) throw new Error('Existing job workspace belongs to different input');
      }
      if (!(await exists(workspacePath))) {
        await git(sourcePath, ['worktree','add','--detach',workspacePath,base], options.signal);
      } else {
        if ((await lstat(workspacePath)).isSymbolicLink()) throw new Error('Job checkout cannot be a symlink');
        if (await git(workspacePath,['rev-parse','HEAD'],options.signal) !== base) throw new Error('Existing job checkout has moved from the submitted revision');
        const sourceCommon = await git(sourcePath,['rev-parse','--path-format=absolute','--git-common-dir'],options.signal);
        const targetCommon = await git(workspacePath,['rev-parse','--path-format=absolute','--git-common-dir'],options.signal);
        if (sourceCommon !== targetCommon) throw new Error('Existing checkout belongs to a different repository');
      }
      await mkdir(join(workspacePath,'.fabro-input'),{recursive:true});
      await writeFile(join(workspacePath,'.fabro-input','work-order.json'),JSON.stringify({...input.workOrder,baseSha:base},null,2));
      const packagePath=join(jobRoot,'workflow.json');
      if (!(await exists(packagePath))) {
        if (!input.workOrder.line) throw new Error('This legacy job has no frozen workflow. Submit a new project line.');
        const line = await readProjectLine(sourcePath, base, input.workOrder.line, input.workOrder.inputs ?? {}, options.signal);
        await writeFile(join(jobRoot,'line.json'), JSON.stringify(line.manifest));
        await writeFile(packagePath,JSON.stringify(line.workflow),{flag:'wx'});
      }
      const frozenPackage=JSON.parse(await readFile(packagePath,'utf8'));
      const version = await client.registerWorkflow(frozenPackage);
      return {workspacePath,workflowVersionId:version,baseSha:base};
    },
    async create(input) {
      const packagePath=join(workspaceRoot,input.jobId,'workflow.json');
      const frozenPackage=JSON.parse(await readFile(packagePath,'utf8'));
      // Each host RPC gets a fresh client. Re-register the frozen package to
      // select the server's supported submission format, including legacy Fabro.
      const registered=await client.registerWorkflow(frozenPackage);
      if (registered!==input.workflowVersionId) throw new Error('Prepared workflow identity changed');
      const manifest = input.workOrder.line ? lineManifestSchema.parse(JSON.parse(await readFile(join(workspaceRoot,input.jobId,'line.json'),'utf8'))) : null;
      const intent: CreateRunIntent = {
        workflow_version_id:input.workflowVersionId, target:{kind:'folder',path:input.workspacePath},
        environment_id:manifest?.environment ?? 'local', title:input.workOrder.title.slice(0,100), goal:input.workOrder.objective,
        args:{labels:{bb_job_id:input.jobId,...(input.threadId ? {bb_thread_id:input.threadId} : {})}, auto_approve:manifest?.autoApprove ?? true,preserve_sandbox:true},
      };
      return client.createRun(intent);
    },
    start: id => client.startRun(id), inspect: id => client.inspectRun(id), cancel: id => client.cancelRun(id),
    async evidence(runId,sinceSeq=1) {
      const run = await client.inspectRun(runId);
      const [events,artifacts,diff] = await Promise.allSettled([client.listEvents(runId,sinceSeq),client.listArtifacts(runId),client.getDiff(runId)]);
      return {run,events:events.status==='fulfilled'?events.value.data.slice(-30):[],
        artifacts:artifacts.status==='fulfilled'?artifacts.value.slice(0,100):[],
        diff:diff.status==='fulfilled'?diff.value:{unavailable:true},
        errors:[events,artifacts,diff].flatMap((value,i)=>value.status==='rejected'?[{surface:['events','artifacts','diff'][i],error:value.reason instanceof Error?value.reason.message:'Unavailable'}]:[])};
    },
  };
}

async function readBoundedFile(path:string,limit:number) {
  const handle = await open(path,'r');
  try { const stat=await handle.stat(); const buffer=Buffer.alloc(Math.min(stat.size,limit)); const {bytesRead}=await handle.read(buffer,0,buffer.length,0); return {text:buffer.subarray(0,bytesRead).toString('utf8'),truncated:stat.size>limit}; }
  finally { await handle.close(); }
}
function compact(value:unknown,limit:number): unknown {
  const text=JSON.stringify(value); return text.length<=limit?value:{truncated:true,preview:text.slice(0,limit)};
}
async function clientFor(input:{connection:{endpoint:string;token?:string}},context:ExperimentalHostRpcContext) {
  return createFabroHost({baseUrl:input.connection.endpoint,token:await authToken(input.connection.endpoint,input.connection.token),
    workspaceRoot:join(context.experimental_paths.dataDir,'jobs'),signal:context.signal});
}
export default experimental_defineHostEntry({
  contract:hostContract,
  handlers:{
    validateLine: async (input, ctx) => ({ name: (await readProjectLine(input.sourcePath, input.baseSha, input.line, input.inputs, ctx.signal)).manifest.name }),
    graph: async (input, ctx) => new FabroClient({baseUrl: input.connection.endpoint, token: await authToken(input.connection.endpoint, input.connection.token), signal: ctx.signal}).graph(input.runId),
    prepare:async(input,ctx)=>(await clientFor(input,ctx)).prepare(input),
    create:async(input,ctx)=>hostContract.create.output.parse(await (await clientFor(input,ctx)).create(input)),
    start:async(input,ctx)=>hostContract.start.output.parse(await (await clientFor(input,ctx)).start(input.runId)),
    inspect:async(input,ctx)=>hostContract.inspect.output.parse(await (await clientFor(input,ctx)).inspect(input.runId)),
    cancel:async(input,ctx)=>hostContract.cancel.output.parse(await (await clientFor(input,ctx)).cancel(input.runId)),
    reconcile:async(input,ctx)=>{
      const token=await authToken(input.connection.endpoint,input.connection.token);
      const client=new FabroClient({baseUrl:input.connection.endpoint,token,signal:ctx.signal});
      const runs=[]; let complete=false;
      for(let offset=0;offset<1000;offset+=100){const page=await client.listRunsPage({bb_job_id:input.jobId},offset);runs.push(...page.runs);if(page.complete){complete=true;break;}}
      return hostContract.reconcile.output.parse({runs,complete});
    },
    evidence:async(input,ctx)=>{
      const evidence=await (await clientFor(input,ctx)).evidence(input.runId,input.sinceSeq);
      const workspacePath=join(ctx.experimental_paths.dataDir,'jobs',input.jobId,'checkout');
      const files:Record<string,unknown>={};
      for(const name of ['delivery.json','baseline.json','validation.json','scope.json','review.md','failure.json','diff.patch']) {
        try { files[name]=await readBoundedFile(join(workspacePath,'.fabro-output',name),name==='diff.patch'?50000:12000); }
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') files[name]={unavailable:true};}
      }
      // Folder targets do not have Fabro checkpoints; always gather the actual checkout diff.
      let workingDiff:unknown;
      try {workingDiff=compact(await git(workspacePath,['diff','--binary',input.baseSha,'--'],ctx.signal),50000);}
      catch {workingDiff={unavailable:true};}
      let lineContract: unknown;
      const manifestPath = join(ctx.experimental_paths.dataDir,'jobs',input.jobId,'line.json');
      if (await exists(manifestPath)) {
        try {
          const manifest = lineManifestSchema.parse(JSON.parse(await readFile(manifestPath,'utf8')));
          const delivery = await readBoundedFile(join(workspacePath,'.fabro-output','delivery.json'),100_000);
          if (delivery.truncated) throw new Error('Delivery exceeds 100 KB');
          validateLineValue(manifest.outputSchema, JSON.parse(delivery.text), 'Delivery does not match outputSchema');
          lineContract = { valid: true, name: manifest.name, acceptanceInstructions: manifest.acceptanceInstructions };
        } catch (error) { lineContract = { valid: false, error: error instanceof Error ? error.message : 'Invalid delivery' }; }
      }
      return hostContract.evidence.output.parse({...evidence,run:compact(evidence.run,18000),events:compact(evidence.events,12000),artifacts:compact(evidence.artifacts,8000),
        diff:workingDiff,workspace:{path:workspacePath,files}, ...(lineContract ? {lineContract} : {})});
    },
  },
});
