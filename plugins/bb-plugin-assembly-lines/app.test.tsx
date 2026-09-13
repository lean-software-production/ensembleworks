// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { JobView } from "./contracts";
import { graphImage, latestStages } from './graph-image';

const graph = { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><g class="node"><title>plan</title><rect width="100" height="40"/><text x="10" y="20">Plan</text></g></svg>', stages: [{ node_id: 'plan', name: 'plan', status: 'running', visit: 1 }], stagesComplete: true };

const job: JobView = {
  id: "job-1", threadId: "thread-1", projectId: null, environmentId: null, hostId: null,
  workspacePath: null, workflowVersionId: null, engineUrl: "https://fabro.example/runs/run-1", sourcePath: null,
  requestKey: "request-1", inputHash: "hash", runId: "run-1",
  workOrder: {
    title: "Refactor parser", objective: "Make parsing safer", baseSha: "a".repeat(40), scope: ["src/parser.ts"],
    setupCommands: [], constraints: [], acceptanceCriteria: ["Tests pass"], validationCommands: ["bun test"], qualityCommand: "bun run lint",
    maxAttempts: 2, maxMinutes: 10, maxChangedFiles: 5,
  },
  createdAt: 1, updatedAt: 2, createState: "confirmed", createDetail: null,
  observationState: "running", observationDetail: null, engineStatus: "running", connectionError: null,
  resultRevision: null, result: null, completionState: "pending", completionDetail: null,
  completionMessageId: null, acceptanceVerdict: "pending", acceptanceReason: null, acceptanceResultRevision: null,
};

describe("Assembly Lines app", () => {
  it('shows a referenced run in another thread and keeps its owner in the sidebar', async () => {
    const app = await loadPluginApp(() => import('./app'));
    const slot = renderSlot(app.messageDirectives[0]!, {
      attributes: { jobId: job.id, originThreadId: job.threadId }, source: '::assembly-line',
      message: { id: 'reference', threadId: 'parent-thread', turnId: null, projectId: null }, openWorkspaceFile: null,
    }, { rpc: {
      getJob: (input: unknown) => { expect((input as {threadId: string}).threadId).toBe(job.threadId); return { job, fabroUrl: null }; },
      getRunGraph: () => graph,
    } });
    fireEvent.click(await slot.findByRole('button', { name: 'Open assembly line Refactor parser' }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: 'openThreadPanel', options: {
      actionId: 'job', params: { jobId: job.id, originThreadId: job.threadId }, title: 'Assembly line',
    } });
    slot.lifecycle.unmount();
  });
  it("registers the thread directive, job panel, and navigation", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: "assembly-lines", path: "assembly-lines" },
    ]);
    expect(app.threadPanelActions.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "job", title: "Assembly line" },
    ]);
    expect(app.messageDirectives.map(({ id }) => id)).toEqual(["assembly-line"]);
  });

  it("loads a live card and opens the thread panel with its job id", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.messageDirectives[0]!, {
      attributes: { jobId: job.id }, source: `::assembly-line{jobId="${job.id}"}`,
      message: { id: "message-1", threadId: job.threadId, turnId: "turn-1", projectId: null },
      openWorkspaceFile: null,
    }, { rpc: {
      getJob: () => ({ job, fabroUrl: job.engineUrl }),
      getRunGraph: () => graph,
    } });
    await slot.findByText("Refactor parser");
    const image = await slot.findByRole('img', { name: /Fabro workflow graph.*plan: running/ });
    expect(image.getAttribute('src')).toContain('data:image/svg+xml');
    expect(decodeURIComponent(image.getAttribute('src')!)).toContain('#2563eb');
    fireEvent.click(slot.getByRole("button", { name: "Open assembly line Refactor parser" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel", options: { actionId: "job", params: { jobId: "job-1" }, title: "Assembly line" },
    });
  });

  it('uses the latest visit and strips executable or external SVG content', () => {
    const data = { ...graph, svg: graph.svg.replace('</svg>', '<script>alert(1)</script><foreignObject><p>unsafe</p></foreignObject><image href="https://external.test/pixel"/><style>text {fill:url(https://external.test)}</style></svg>').replace('<rect ', '<rect onclick="alert(1)" style="fill:red" '),
      stages: [...graph.stages, { node_id: 'plan', name: 'plan', status: 'failed', visit: 2 }, graph.stages[0]!] };
    expect(latestStages(data).get('plan')?.status).toBe('failed');
    const svg = decodeURIComponent(graphImage(data));
    expect(svg).toContain('#b91c1c');
    expect(svg).not.toMatch(/script|foreignObject|external.test|onclick|style=/);
  });

  it("renders an RPC failure in the directive card", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.messageDirectives[0]!, {
      attributes: { jobId: job.id }, source: "::assembly-line", message: {
        id: "message-1", threadId: job.threadId, turnId: null, projectId: null,
      }, openWorkspaceFile: null,
    }, { rpc: { getJob: () => { throw new Error("job unavailable"); } } });
    await waitFor(() => expect(slot.getByText("Could not load assembly line: job unavailable")).toBeTruthy());
  });

  it("refreshes the card when the jobs-changed signal names the job", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let calls = 0;
    const slot = renderSlot(app.messageDirectives[0]!, {
      attributes: { jobId: job.id }, source: "::assembly-line", message: {
        id: "message-1", threadId: job.threadId, turnId: null, projectId: null,
      }, openWorkspaceFile: null,
    }, { rpc: {
      getJob: () => ({ job: { ...job, engineStatus: calls++ ? "succeeded" : "running" }, fabroUrl: null }),
      getRunGraph: () => ({ ...graph, stages: [{ ...graph.stages[0]!, status: calls > 1 ? 'succeeded' : 'running' }] }),
    } });
    await slot.findByText("Running");
    await slot.findByRole('img', { name: /plan: running/ });
    await slot.behavior.emitRealtime("jobs-changed", { jobId: job.id, threadId: job.threadId });
    await slot.findByText("Succeeded");
    await slot.findByRole('img', { name: /plan: succeeded/ });
    expect(calls).toBe(2);
    slot.lifecycle.unmount();
  });
});
