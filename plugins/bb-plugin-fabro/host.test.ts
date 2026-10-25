import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFabroHost } from "./host";
import { readProjectWorkflow, validateWorkflowValue } from './project-workflow';

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const order = {
  workflow: ".fabro/workflows/refactor-code-quality/workflow.json", inputs: {validationCommands:["true"], qualityCommand:"true"},
  title: "Refactor", objective: "Refactor safely", baseSha: "a".repeat(40), scope: ["src"], constraints: [],
  acceptanceCriteria: ["Tests pass"], validationCommands: ["true"], qualityCommand: "true", setupCommands: [],
  maxAttempts: 2, maxMinutes: 10, maxChangedFiles: 5,
};
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "fabro-host-")); roots.push(root);
  await execFile("git", ["-C", root, "init", "-q"]); await execFile("git", ["-C", root, "config", "user.email", "test@example.com"]); await execFile("git", ["-C", root, "config", "user.name", "Test"]);
  await mkdir(join(root, "src")); await writeFile(join(root, "src", "input.txt"), "base\n");
  await execFile(process.execPath, [new URL("./skills/create-fabro-workflow/scripts/create-refactor-workflow.mjs", import.meta.url).pathname, root]);
  await execFile("git", ["-C", root, "add", "."]); await execFile("git", ["-C", root, "commit", "-qm", "base"]);
  const { stdout } = await execFile("git", ["-C", root, "rev-parse", "HEAD"]);
  return { root, sha: stdout.trim() };
}
function host(workspaceRoot: string, fetchCalls: string[]) {
  return createFabroHost({ workspaceRoot, fetch: async (url, init) => {
    fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify({ workflow_version_id: "b".repeat(64) }), { status: 200, headers: { "content-type": "application/json" } });
  } });
}

describe("Fabro host preparation", () => {
  it.skipIf(!process.env.FABRO_GRAPH_TEST)('executes a committed project workflow through real Fabro without model calls', async () => {
    const {root} = await repo();
    const path = '.fabro/workflows/refactor-code-quality/workflow.json';
    const directory = join(root,'.fabro/workflows/refactor-code-quality');
    const manifest = {version:1,name:'Project smoke',workflow:'workflow.fabro',files:['workflow.fabro'],inputSchema:{type:'object'},outputSchema:{type:'object',required:['message'],properties:{message:{const:'ok'}}},acceptanceInstructions:'Verify message equals ok.',environment:'local',autoApprove:true};
    const script = `mkdir -p .fabro-output && printf '{"message":"ok"}' > .fabro-output/delivery.json`;
    await writeFile(join(directory,'workflow.json'),JSON.stringify(manifest));
    await writeFile(join(directory,'workflow.fabro'),`digraph ProjectSmoke { start [shape=Mdiamond]; check [shape=parallelogram, goal_gate=true, script=${JSON.stringify(script)}]; exit [shape=Msquare]; start -> check -> exit; }`);
    await execFile('git',['-C',root,'add','.']); await execFile('git',['-C',root,'commit','-qm','smoke workflow']);
    const sha = (await execFile('git',['-C',root,'rev-parse','HEAD'])).stdout.trim();
    const auth = JSON.parse(await readFile(join(homedir(),'.fabro/auth.json'),'utf8'));
    const workspaceRoot = await mkdtemp(join(tmpdir(),'fabro-project-smoke-')); roots.push(workspaceRoot);
    const fabro = createFabroHost({workspaceRoot,token:auth.servers['http://127.0.0.1:3000'].token});
    const workOrder = {...order,workflow:path,inputs:{},baseSha:sha};
    const prepared = await fabro.prepare({jobId:'project-smoke',sourcePath:root,baseSha:sha,workOrder});
    const run = await fabro.create({jobId:'project-smoke',workOrder,...prepared});
    console.log('Project-owned workflow smoke run',run.id);
    await fabro.start(run.id);
    let status;
    const deadline = Date.now()+60_000;
    do {
      status = (await fabro.inspect(run.id)).lifecycle?.status?.kind;
      if (['succeeded','failed','dead'].includes(status ?? '')) break;
      await new Promise(resolve => setTimeout(resolve,500));
    } while (Date.now()<deadline);
    expect(status).toBe('succeeded');
    const delivery = JSON.parse(await readFile(join(prepared.workspacePath,'.fabro-output/delivery.json'),'utf8'));
    expect(delivery).toEqual({message:'ok'});
    validateWorkflowValue(manifest.outputSchema,delivery,'delivery');
  },75_000);
  it('reads the workflow from the submitted commit and rejects invalid inputs and paths', async () => {
    const {root,sha} = await repo();
    const path = '.fabro/workflows/refactor-code-quality/workflow.json';
    const first = await readProjectWorkflow(root,sha,path,order.inputs);
    await writeFile(join(root,'.fabro/workflows/refactor-code-quality/workflow.fabro'),'dirty workflow');
    const second = await readProjectWorkflow(root,sha,path,order.inputs);
    expect(second).toEqual(first);
    expect(second.workflow.files[second.workflow.entrypoint]).toContain('digraph RefactorCodeQuality');
    await expect(readProjectWorkflow(root,sha,path,{})).rejects.toThrow('inputSchema');
    await expect(readProjectWorkflow(root,sha,'../workflow.json',order.inputs)).rejects.toThrow();
    expect(() => validateWorkflowValue(first.manifest.outputSchema, {}, 'delivery')).toThrow('delivery');
  });

  it('runs a different project graph without refactoring-specific inputs', async () => {
    const {root} = await repo();
    const dir = join(root,'.fabro/workflows/check'); await mkdir(dir);
    await writeFile(join(dir,'workflow.fabro'),'digraph ProjectCheck { start [shape=Mdiamond]; exit [shape=Msquare]; start -> exit; }');
    await writeFile(join(dir,'workflow.json'),JSON.stringify({version:1,name:'Check',workflow:'workflow.fabro',files:['workflow.fabro'],inputSchema:{type:'object'},outputSchema:{type:'object'},acceptanceInstructions:'Inspect the report.'}));
    await execFile('git',['-C',root,'add','.']); await execFile('git',['-C',root,'commit','-qm','project check']);
    const {stdout} = await execFile('git',['-C',root,'rev-parse','HEAD']);
    const line = await readProjectWorkflow(root,stdout.trim(),'.fabro/workflows/check/workflow.json',{});
    expect(line.workflow.files[line.workflow.entrypoint]).toContain('ProjectCheck');
    expect(line.manifest.autoApprove).toBe(false);
  });
  it("submits the frozen legacy package across separate host RPC instances", async () => {
    const { root, sha } = await repo();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "fabro-workspaces-")); roots.push(workspaceRoot);
    const bodies: Record<string, any>[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/workflow-versions')) return new Response('', {status:404});
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({id:'run-legacy',lifecycle:{status:{kind:'submitted'}}}),{status:201});
    };
    const workOrder = {...order,baseSha:sha};
    const prepared = await createFabroHost({workspaceRoot,fetch}).prepare({jobId:'legacy-job',sourcePath:root,baseSha:sha,workOrder});
    const run = await createFabroHost({workspaceRoot,fetch}).create({jobId:'legacy-job',threadId:'thread-1',workOrder,...prepared});
    expect(run.id).toBe('run-legacy');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({version:1,identifier:'.fabro/workflows/refactor-code-quality/workflow.fabro',cwd:prepared.workspacePath,args:{environment:'local'}});
    expect(bodies[0].workflows['.fabro/workflows/refactor-code-quality/workflow.fabro'].source).toContain('runner.mjs validate');
  });
  it("prepares the same job twice without modifying the source and reuses the detached checkout", async () => {
    const { root, sha } = await repo(); const workspaceRoot = await mkdtemp(join(tmpdir(), "fabro-workspaces-")); roots.push(workspaceRoot); const calls: string[] = [];
    const before = await execFile("git", ["-C", root, "status", "--porcelain"]);
    const fabro = host(workspaceRoot, calls);
    const input = { jobId: "job-1", sourcePath: root, baseSha: sha, workOrder: { ...order, baseSha: sha } };
    const first = await fabro.prepare(input); const second = await fabro.prepare(input);
    expect(second.workspacePath).toBe(first.workspacePath); expect(second.workflowVersionId).toBe(first.workflowVersionId);
    expect(await readFile(join(first.workspacePath, ".fabro-input", "work-order.json"), "utf8")).toContain("Refactor");
    expect((await execFile("git", ["-C", root, "status", "--porcelain"])).stdout).toBe(before.stdout);
    expect(calls.filter(call => call.startsWith("POST")).length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a different base, source, or frozen work order for a reused job", async () => {
    const { root, sha } = await repo(); const workspaceRoot = await mkdtemp(join(tmpdir(), "fabro-workspaces-")); roots.push(workspaceRoot); const calls: string[] = []; const fabro = host(workspaceRoot, calls);
    const input = { jobId: "job-2", sourcePath: root, baseSha: sha, workOrder: { ...order, baseSha: sha } };
    await fabro.prepare(input);
    await expect(fabro.prepare({ ...input, baseSha: "c".repeat(40), workOrder: { ...input.workOrder, baseSha: "c".repeat(40) } })).rejects.toThrow();
    await expect(fabro.prepare({ ...input, sourcePath: join(root, "missing") })).rejects.toThrow();
    await expect(fabro.prepare({ ...input, workOrder: { ...input.workOrder, objective: "different" } })).rejects.toThrow(/order|immutable|different/i);
  });

  it("rejects a source repository that already tracks reserved Fabro input files", async () => {
    const { root } = await repo(); await mkdir(join(root, ".fabro-input")); await writeFile(join(root, ".fabro-input", "owned.txt"), "source-owned\n");
    await execFile("git", ["-C", root, "add", ".fabro-input/owned.txt"]); await execFile("git", ["-C", root, "commit", "-qm", "reserved"]);
    const { stdout: reservedHead } = await execFile("git", ["-C", root, "rev-parse", "HEAD"]);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "fabro-workspaces-")); roots.push(workspaceRoot); const fabro = host(workspaceRoot, []);
    await expect(fabro.prepare({ jobId: "job-3", sourcePath: root, baseSha: reservedHead.trim(), workOrder: { ...order, baseSha: reservedHead.trim() } })).rejects.toThrow(/fabro-input|reserved/i);
  });
});
