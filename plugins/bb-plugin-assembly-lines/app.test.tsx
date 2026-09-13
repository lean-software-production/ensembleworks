// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { JobView } from "./contracts";
import { graphImage, latestStages } from './graph-image';

const graph = { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><g class="node"><title>plan</title><rect width="100" height="40"/><text x="10" y="20">Plan</text></g></svg>', stages: [{ node_id: 'plan', name: 'plan', status: 'running', visit: 1 }], stagesComplete: true };

afterEach(() => cleanup());

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

const diffPatch = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1 @@
+second
`;

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    workspace: {
      path: "/tmp/fabro/job-1/checkout",
      files: {
        "delivery.json": { text: JSON.stringify({ changedFiles: ["src/a.ts", "src/b.ts"], attempts: 2, resultSha: "b".repeat(40), review: "# Review\n\n- Looks good" }), truncated: false },
        "baseline.json": { text: JSON.stringify({ checks: [{ command: "npm test -- --run baseline", exitCode: 0, signal: null, error: null, stdout: "baseline ok", stderr: "" }] }), truncated: false },
        "validation.json": { text: JSON.stringify({ checks: [{ command: "npm test", exitCode: 1, signal: null, error: null, stdout: "ran", stderr: "failed" }], quality: { command: "git diff --check", exitCode: 0, signal: null, error: null, stdout: "", stderr: "" } }), truncated: false },
        "review.md": { text: "# Review\n\n- Looks good", truncated: false },
        "diff.patch": { text: diffPatch, truncated: false },
      },
    },
    ...overrides,
  };
}

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

  it("renders readable sidebar results with summary, multi-file changes, checks, review, and collapsed raw JSON", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const delivered = { ...job, engineStatus: "succeeded", observationState: "succeeded", acceptanceVerdict: "rejected", acceptanceReason: "needs one more test", workspacePath: "/tmp/fabro/job-1/checkout", resultRevision: 1 };
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: job.threadId, params: { jobId: job.id } }, { rpc: {
      getJob: () => ({ job: delivered, fabroUrl: "https://fabro.example/runs/run-1" }),
      getRunGraph: () => graph,
      getRunDetails: () => ({ job: delivered, fabroUrl: "https://fabro.example/runs/run-1", details: JSON.stringify(evidence()), artifacts: "Preserved checkout: /tmp/fabro/job-1/checkout" }),
    } });
    await slot.findByRole("heading", { name: "Summary" });
    expect(slot.getAllByText("Rejected — needs one more test").length).toBeGreaterThan(0);
    expect(await slot.findByText("src/a.ts, src/b.ts")).toBeTruthy();
    expect(slot.getByText("src/a.ts")).toBeTruthy();
    expect(slot.getByText("src/b.ts")).toBeTruthy();
    expect(slot.getByText("Final validation")).toBeTruthy();
    expect(slot.getAllByText("Fail").length).toBeGreaterThan(0);
    fireEvent.click(slot.getByText(/npm test$/));
    expect(await slot.findByText("failed")).toBeTruthy();
    expect(slot.getByRole("heading", { name: "Review" })).toBeTruthy();
    expect(slot.getAllByText(/Looks good/).length).toBeGreaterThan(0);
    expect(slot.getByText("Raw JSON").closest("details")?.hasAttribute("open")).toBe(false);
    fireEvent.click(slot.getByText("Raw JSON"));
    expect(await slot.findByText(/delivery\.json/)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("uses persisted results when detail refresh fails and does not mark errored checks as passing", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const persisted = evidence({ workspace: { path: "/tmp/fallback", files: {
      "validation.json": { text: JSON.stringify({ checks: [{ command: "maybe", exitCode: null, signal: null, error: "spawn failed", stdout: "", stderr: "" }] }), truncated: false },
      "diff.patch": { text: "", truncated: true },
    } } });
    const persistedJob = { ...job, result: persisted, resultRevision: 1, engineStatus: "failed", observationState: "failed" };
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: job.threadId, params: { jobId: job.id } }, { rpc: {
      getJob: () => ({ job: persistedJob, fabroUrl: null }),
      getRunGraph: () => graph,
      getRunDetails: () => { throw new Error("host offline"); },
    } });
    await slot.findByText(/Run details refresh failed/);
    expect(slot.getByText("Diff evidence was truncated.")).toBeTruthy();
    expect(slot.getByText("Final validation")).toBeTruthy();
    expect(slot.getAllByText("Fail").length).toBeGreaterThan(0);
    fireEvent.click(slot.getByText("maybe"));
    expect(await slot.findByText("spawn failed")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("renders running and malformed partial evidence safely", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: job.threadId, params: { jobId: job.id } }, { rpc: {
      getJob: () => ({ job, fabroUrl: null }),
      getRunGraph: () => graph,
      getRunDetails: () => ({ job, fabroUrl: null, details: "{not json", artifacts: "" }),
    } });
    await slot.findByText(/Run details could not be parsed/);
    expect(slot.getByText("No changes were reported.")).toBeTruthy();
    expect(slot.getByText("Check evidence is not available yet.")).toBeTruthy();
    fireEvent.click(slot.getByText("Raw JSON"));
    expect(await slot.findByText("{not json")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("clears and ignores stale run details when switching jobs", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let resolveFirst: ((value: unknown) => void) | null = null;
    const first = new Promise(resolve => { resolveFirst = resolve; });
    const job2 = { ...job, id: "job-2", runId: "run-2", workOrder: { ...job.workOrder, title: "Second job" } };
    const Panel = app.threadPanelActions[0]!.component;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: job.threadId, params: { jobId: job.id } }, { rpc: {
      getJob: (input: unknown) => ({ job: (input as { jobId: string }).jobId === "job-2" ? job2 : job, fabroUrl: null }),
      getRunGraph: () => graph,
      getRunDetails: (input: unknown) => (input as { jobId: string }).jobId === "job-1" ? first : { job: job2, fabroUrl: null, details: JSON.stringify(evidence({ workspace: { path: "/tmp/job2", files: { "diff.patch": { text: "", truncated: false } } } })), artifacts: "" },
    } });
    await slot.findByText("Refactor parser");
    slot.lifecycle.rerender(<Panel threadId={job.threadId} params={{ jobId: "job-2" }} />);
    await slot.findByText("Second job");
    resolveFirst!({ job, fabroUrl: null, details: JSON.stringify(evidence({ workspace: { path: "/tmp/stale", files: { "delivery.json": { text: JSON.stringify({ changedFiles: ["stale.ts"] }), truncated: false } } } })), artifacts: "" });
    await waitFor(() => expect(slot.queryByText("stale.ts")).toBeNull());
    expect(slot.getByText("No changes were reported.")).toBeTruthy();
    slot.lifecycle.unmount();
  });
});
