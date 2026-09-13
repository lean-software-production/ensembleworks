import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { JobStore } from './jobs';

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
const workOrder = {
  line: ".fabro/lines/refactor-code-quality/line.json", inputs: {validationCommands:["true"], qualityCommand:"true"},
  title: "Refactor", objective: "Refactor safely", baseSha: "a".repeat(40), scope: ["src"], constraints: [],
  acceptanceCriteria: ["Tests pass"],
  maxAttempts: 2, maxMinutes: 10, maxChangedFiles: 5,
};
function makeHost() {
  const host = createFakePluginHost({
    experimental_callHostRpc: async ({method}) => { if (method === 'validateLine') return {name:'Refactor'}; throw new Error(method); },
    settings: { fabroEndpoint: "http://fabro.test/api/v1" },
    sdk: {
      threads: { get: async () => makeThreadResponse({ id: "thread-1", projectId: "project-1", environmentId: "env-1" }) },
      environments: { get: async () => ({
        id: "env-1", projectId: "project-1", hostId: "host-1", path: "src", isGitRepo: true, isWorktree: false,
        status: "ready", createdAt: 1, updatedAt: 1, baseBranch: null, branchName: null, defaultBranch: null,
        environmentProviderId: null, environmentProviderInstanceKey: null, environmentProviderSelection: null,
        lifecycle: { phase: "active", retireAt: null, teardown: null }, managed: false, mergeBaseBranch: null,
        name: null, workspaceProvisionType: null,
      }) },
    },
  });
  hosts.push(host); return host;
}
function toolJson(value: unknown): any {
  if (typeof value === "string") return JSON.parse(value);
  const text = (value as { content?: Array<{ type: string; text?: string }> }).content?.find(part => part.type === "text")?.text;
  return JSON.parse(text ?? "{}");
}

describe("assembly-line submission server", () => {
  it('requires a project line and refuses acceptance without a valid delivery contract', async () => {
    const host = makeHost(); await plugin(host.bb);
    const {line: _line, ...missingLine} = workOrder;
    await expect(host.harness.behavior.callAgentTool('assembly_line_submit', {requestKey:'missing',workOrder:missingLine}, {threadId:'thread-1',projectId:'project-1'})).rejects.toThrow();
    const submitted = toolJson(await host.harness.behavior.callAgentTool('assembly_line_submit', {requestKey:'contract',workOrder}, {threadId:'thread-1',projectId:'project-1'}));
    const store = new JobStore(host.bb.storage.database());
    store.recordObservation(submitted.job.id,'succeeded',{lineContract:{valid:false}},null,1,Date.now(),'succeeded');
    await expect(host.harness.behavior.callAgentTool('assembly_line_accept', {jobId:submitted.job.id,resultRevision:1,verdict:'accepted',reason:'looks fine'}, {threadId:'thread-1',projectId:'project-1'})).rejects.toThrow('delivery contract');
    store.recordObservation(submitted.job.id,'succeeded',{lineContract:{valid:true}},null,1,Date.now(),'succeeded');
    const accepted = toolJson(await host.harness.behavior.callAgentTool('assembly_line_accept', {jobId:submitted.job.id,resultRevision:1,verdict:'accepted',reason:'inspected evidence'}, {threadId:'thread-1',projectId:'project-1'}));
    expect(accepted.job.acceptanceVerdict).toBe('accepted');
  });
  it("freezes duplicate submissions to one durable job", async () => {
    const host = makeHost(); await plugin(host.bb);
    const first = toolJson(await host.harness.behavior.callAgentTool("assembly_line_submit", { requestKey: "same", workOrder }, { threadId: "thread-1", projectId: "project-1" }));
    const second = toolJson(await host.harness.behavior.callAgentTool("assembly_line_submit", { requestKey: "same", workOrder }, { threadId: "thread-1", projectId: "project-1" }));
    expect(second.job.id).toBe(first.job.id);
    expect(await host.harness.behavior.callRpc('getRunGraph', { jobId: first.job.id, threadId: 'thread-1' })).toBeNull();
    await expect(host.harness.behavior.callRpc('getRunGraph', { jobId: first.job.id, threadId: 'another-thread' })).rejects.toThrow('another thread');
    expect(host.harness.inspection.realtimeSignals.filter(signal => signal.channel === "jobs-changed")).toHaveLength(2);
  });

  it("rejects a duplicate request key when the frozen work order differs", async () => {
    const host = makeHost(); await plugin(host.bb);
    await host.harness.behavior.callAgentTool("assembly_line_submit", { requestKey: "same", workOrder }, { threadId: "thread-1", projectId: "project-1" });
    await expect(host.harness.behavior.callAgentTool("assembly_line_submit", { requestKey: "same", workOrder: { ...workOrder, objective: "changed" } }, { threadId: "thread-1", projectId: "project-1" })).rejects.toThrow(/different input/);
  });

  it("runs the durable host lifecycle through evidence and queues a completion", async () => {
    const calls: string[] = []; let inspectCount = 0;
    const host = createFakePluginHost({
      settings: { fabroEndpoint: "http://fabro.test/api/v1" },
      sdk: {
        threads: {
          get: async () => makeThreadResponse({ id: "thread-1", projectId: "project-1", environmentId: "env-1" }),
          send: async () => { calls.push("send"); return { ok: true, delivery: "sent" as const }; },
        },
        environments: { get: async () => ({
          id: "env-1", projectId: "project-1", hostId: "host-1", path: "src", isGitRepo: true, isWorktree: false,
          status: "ready", createdAt: 1, updatedAt: 1, baseBranch: null, branchName: null, defaultBranch: null,
          environmentProviderId: null, environmentProviderInstanceKey: null, environmentProviderSelection: null,
          lifecycle: { phase: "active", retireAt: null, teardown: null }, managed: false, mergeBaseBranch: null,
          name: null, workspaceProvisionType: null,
        }) },
      },
      experimental_callHostRpc: async ({ method }) => {
        calls.push(method);
        if (method === "validateLine") return { name: "Refactor" };
        if (method === "prepare") return { workspacePath: "/tmp/assembly-line", workflowVersionId: "a".repeat(64), baseSha: "a".repeat(40) };
        if (method === "create") return { id: "fabro-1", lifecycle: { status: { kind: "submitted" } } };
        if (method === "start") return { id: "fabro-1", lifecycle: { status: { kind: "running" } } };
        if (method === "inspect") return { id: "fabro-1", lifecycle: { status: { kind: inspectCount++ === 0 ? "submitted" : "succeeded" } } };
        if (method === "evidence") return { run: { id: "fabro-1" }, events: [], artifacts: [], diff: { files: [] }, workspace: { path: "/tmp/assembly-line", files: {} }, errors: [] };
        throw new Error(`unexpected host method ${method}`);
      },
    });
    hosts.push(host); await plugin(host.bb);
    await host.harness.behavior.callAgentTool("assembly_line_submit", { requestKey: "lifecycle", workOrder }, { threadId: "thread-1", projectId: "project-1" });
    const service = host.harness.behavior.runService("fabro-jobs");
    await vi.waitFor(() => expect(calls).toContain("send"));
    service.controller.abort(); await service.done;
    expect(calls).toEqual(expect.arrayContaining(["prepare", "create", "start", "inspect", "evidence", "send"]));
  });
});
