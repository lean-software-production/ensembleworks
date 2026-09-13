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
    expect(slot.getByText("Latest validation (non-final)")).toBeTruthy();
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
    expect(slot.getByText("Latest validation (non-final)")).toBeTruthy();
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
    expect(slot.getByText("Diff evidence is not available yet.")).toBeTruthy();
    expect(slot.getByText("Check evidence is not available yet.")).toBeTruthy();
    fireEvent.click(slot.getByText("Raw JSON"));
    expect(await slot.findByText("{not json")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("prefers final delivery checks over stale validation and reports missing exits as unknown", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const delivered = { ...job, resultRevision: 1, engineStatus: "succeeded", observationState: "succeeded" };
    const fresh = evidence({
      workspace: {
        path: "/tmp/final",
        files: {
          "delivery.json": { text: JSON.stringify({
            after: { checks: [{ command: "final check", exitCode: 1, signal: null, error: null, stdout: "", stderr: "real failure" }] },
          }), truncated: false },
          "validation.json": { text: JSON.stringify({ checks: [{ command: "stale validation", exitCode: 0, signal: null, error: null, stdout: "old pass", stderr: "" }] }), truncated: false },
          "baseline.json": { text: JSON.stringify({ checks: [{ command: "unknown setup", signal: null, error: null, stdout: "", stderr: "" }] }), truncated: false },
          "diff.patch": { text: "", truncated: false },
        },
      },
    });
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: job.threadId, params: { jobId: job.id } }, { rpc: {
      getJob: () => ({ job: delivered, fabroUrl: null }),
      getRunGraph: () => graph,
      getRunDetails: () => ({ job: delivered, fabroUrl: null, details: JSON.stringify(fresh), artifacts: "" }),
    } });
    await slot.findByText("Final validation");
    expect(slot.queryByText("Latest validation (non-final)")).toBeNull();
    expect(slot.getByText("final check")).toBeTruthy();
    expect(slot.queryByText("stale validation")).toBeNull();
    expect(slot.getAllByText("Fail").length).toBeGreaterThan(0);
    expect(slot.getAllByText("Unknown").length).toBeGreaterThan(0);
    fireEvent.click(slot.getByText("final check"));
    expect(await slot.findByText("real failure")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("falls back to persisted evidence when fresh details are malformed while keeping malformed raw input", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const persisted = evidence({ workspace: { path: "/tmp/persisted", files: {
      "delivery.json": { text: JSON.stringify({ changedFiles: ["persisted.ts"], attempts: 1, resultSha: "c".repeat(40) }), truncated: false },
      "diff.patch": { text: "", truncated: false },
    } } });
    const persistedJob = { ...job, result: persisted, resultRevision: 1, engineStatus: "succeeded", observationState: "succeeded" };
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: job.threadId, params: { jobId: job.id } }, { rpc: {
      getJob: () => ({ job: persistedJob, fabroUrl: null }),
      getRunGraph: () => graph,
      getRunDetails: () => ({ job: persistedJob, fabroUrl: null, details: "{fresh malformed", artifacts: "" }),
    } });
    await slot.findByText(/Run details could not be parsed/);
    expect(slot.getByText("persisted.ts")).toBeTruthy();
    fireEvent.click(slot.getByText("Raw JSON"));
    expect(await slot.findByText("{fresh malformed")).toBeTruthy();
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

  it("clears and ignores stale jobs when switching panel identities", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let resolveFirst: ((value: unknown) => void) | null = null;
    const first = new Promise(resolve => { resolveFirst = resolve; });
    const job2 = { ...job, id: "job-2", runId: "run-2", workOrder: { ...job.workOrder, title: "Second job" } };
    const Panel = app.threadPanelActions[0]!.component;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: job.threadId, params: { jobId: job.id } }, { rpc: {
      getJob: (input: unknown) => (input as { jobId: string }).jobId === "job-1" ? first : { job: job2, fabroUrl: null },
      getRunGraph: () => graph,
      getRunDetails: () => ({ job: job2, fabroUrl: null, details: JSON.stringify(evidence({ workspace: { path: "/tmp/job2", files: { "diff.patch": { text: "", truncated: false } } } })), artifacts: "" }),
    } });
    slot.lifecycle.rerender(<Panel threadId={job.threadId} params={{ jobId: "job-2" }} />);
    await slot.findByText("Second job");
    resolveFirst!({ job: { ...job, workOrder: { ...job.workOrder, title: "Stale first job" } }, fabroUrl: null });
    await waitFor(() => expect(slot.queryByText("Stale first job")).toBeNull());
    expect(slot.getByText("Second job")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("keeps the newest same-job refresh when earlier getJob responses resolve late", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let calls = 0;
    let resolveSlow: ((value: unknown) => void) | null = null;
    const slow = new Promise(resolve => { resolveSlow = resolve; });
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: job.threadId, params: { jobId: job.id } }, { rpc: {
      getJob: () => {
        calls++;
        if (calls === 1) return { job: { ...job, workOrder: { ...job.workOrder, title: "Initial job" } }, fabroUrl: null };
        if (calls === 2) return slow;
        return { job: { ...job, workOrder: { ...job.workOrder, title: "Newest job" } }, fabroUrl: null };
      },
      getRunGraph: () => graph,
      getRunDetails: () => ({ job, fabroUrl: null, details: JSON.stringify(evidence({ workspace: { path: "/tmp/job", files: { "diff.patch": { text: "", truncated: false } } } })), artifacts: "" }),
    } });
    await slot.findByText("Initial job");
    await slot.behavior.emitRealtime("jobs-changed", { jobId: job.id, threadId: job.threadId });
    await slot.behavior.emitRealtime("jobs-changed", { jobId: job.id, threadId: job.threadId });
    await slot.findByText("Newest job");
    resolveSlow!({ job: { ...job, workOrder: { ...job.workOrder, title: "Older refresh job" } }, fabroUrl: null });
    await waitFor(() => expect(slot.queryByText("Older refresh job")).toBeNull());
    expect(slot.getByText("Newest job")).toBeTruthy();
    expect(calls).toBe(3);
    slot.lifecycle.unmount();
  });
});


describe("Fabro composer banner", () => {
  it("uses the composer thread, finds the latest paginated run and opens its sidebar", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const customization = app.composerCustomizations[0]!;
    expect(customization.scopes).toEqual(["thread"]);
    const latest = { ...job, id: "newest", createdAt: 10, workOrder: { ...job.workOrder, title: "Latest run", displayTitle: "Code quality" } };
    const slot = renderSlot(customization.banners![0]!, {}, {
      context: { threadId: "unrelated-route" }, composer: { scope: { kind: "thread", threadId: job.threadId } },
      rpc: { listJobs: (input: unknown) => {
        const value = input as { threadId: string; after?: string };
        expect(value.threadId).toBe(job.threadId);
        return value.after ? { jobs: [latest], nextCursor: null } : { jobs: [job], nextCursor: "page2" };
      }, getRunGraph: () => graph },
    });
    const button = await slot.findByRole("button", { name: "Open Fabro run Latest run" });
    expect(slot.queryByRole("img", { name: /Fabro workflow graph/ })).toBeNull();
    expect(slot.getByText("Code quality").getAttribute("title")).toBe("Latest run");
    await slot.findByText("· plan");
    expect(slot.getByRole("img", { name: "Execution: Running" })).toBeTruthy();
    const expand = slot.getByRole("button", { name: "Expand Fabro graph" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);
    expect(await slot.findByRole("img", { name: /Fabro workflow graph/ })).toBeTruthy();
    const collapse = slot.getByRole("button", { name: "Collapse Fabro graph" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapse);
    expect(slot.queryByRole("img", { name: /Fabro workflow graph/ })).toBeNull();
    fireEvent.click(button);
    expect(slot.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "job", params: { jobId: "newest" }, title: "Fabro" } });
    slot.lifecycle.unmount();
  });

  it("hides without jobs and updates on realtime completion", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let jobs: JobView[] = [];
    const slot = renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
      composer: { scope: { kind: "thread", threadId: job.threadId } },
      rpc: { listJobs: () => ({ jobs, nextCursor: null }), getRunGraph: () => graph },
    });
    expect(slot.queryByRole("button")).toBeNull();
    jobs = [job];
    await slot.behavior.emitRealtime("jobs-changed", { jobId: job.id });
    await slot.findByRole("button", { name: "Open Fabro run Refactor parser" });
    jobs = [{ ...job, engineStatus: "succeeded" }];
    await slot.behavior.emitRealtime("jobs-changed", { jobId: job.id });
    await slot.findByText("Ready for review");
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "empty-thread" });
    await waitFor(() => expect(slot.queryByRole("button")).toBeNull());
    slot.lifecycle.unmount();
  });

  it("collapses a previously expanded running graph to a ready-for-review notice without polling the graph", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let current: JobView = job;
    let graphCalls = 0;
    const slot = renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
      composer: { scope: { kind: "thread", threadId: job.threadId } },
      rpc: {
        listJobs: () => ({ jobs: [current], nextCursor: null }),
        getRunGraph: () => { graphCalls++; return graph; },
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Expand Fabro graph" }));
    expect(await slot.findByRole("img", { name: /Fabro workflow graph/ })).toBeTruthy();
    expect(graphCalls).toBe(1);
    current = { ...job, engineStatus: "succeeded", observationState: "succeeded", completionState: "succeeded" };
    await slot.behavior.emitRealtime("jobs-changed", { jobId: job.id, threadId: job.threadId });
    await slot.findByText("Ready for review");
    expect(slot.queryByRole("button", { name: /Expand Fabro graph|Collapse Fabro graph/ })).toBeNull();
    expect(slot.queryByRole("img", { name: /Fabro workflow graph/ })).toBeNull();
    expect(graphCalls).toBe(1);
    fireEvent.click(slot.getByRole("button", { name: "Open Fabro run Refactor parser" }));
    expect(slot.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "job", params: { jobId: job.id }, title: "Fabro" } });
    slot.lifecycle.unmount();
  });

  it("hides an accepted latest job without resurrecting older jobs", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const older = { ...job, id: "older", createdAt: 1, workOrder: { ...job.workOrder, title: "Older run" } };
    let latest = { ...job, id: "latest", createdAt: 2, engineStatus: "succeeded", observationState: "succeeded" };
    const slot = renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
      composer: { scope: { kind: "thread", threadId: job.threadId } },
      rpc: { listJobs: () => ({ jobs: [older, latest], nextCursor: null }), getRunGraph: () => graph },
    });
    await slot.findByText("Ready for review");
    latest = { ...latest, acceptanceVerdict: "accepted" };
    await slot.behavior.emitRealtime("jobs-changed", { jobId: latest.id, threadId: job.threadId });
    await waitFor(() => expect(slot.queryByText("Ready for review")).toBeNull());
    expect(slot.queryByText("Older run")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("gives assessment attention precedence over succeeded execution and locally dismisses it", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const rework = { ...job, engineStatus: "succeeded", observationState: "succeeded", acceptanceVerdict: "needs_input", resultRevision: 1 };
    const slot = renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
      composer: { scope: { kind: "thread", threadId: job.threadId } },
      rpc: { listJobs: () => ({ jobs: [rework], nextCursor: null }), getRunGraph: () => { throw new Error("graph should not be mounted"); } },
    });
    await slot.findByText("Needs input");
    expect(slot.queryByText("Ready for review")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Open details for Refactor parser" }));
    expect(slot.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "job", params: { jobId: job.id }, title: "Fabro" } });
    fireEvent.click(slot.getByRole("button", { name: "Dismiss Needs input notice for Refactor parser" }));
    await waitFor(() => expect(slot.queryByText("Needs input")).toBeNull());
    slot.lifecycle.unmount();
  });

  it("persists dismissed attention through remounts, isolates by thread, and resurfaces changed revisions", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let currentThread = job.threadId;
    let current = { ...job, engineStatus: "failed", observationState: "failed", resultRevision: 1 };
    const render = () => renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
      composer: { scope: { kind: "thread", threadId: currentThread } },
      rpc: { listJobs: () => ({ jobs: [{ ...current, threadId: currentThread }], nextCursor: null }), getRunGraph: () => graph },
    });
    let slot = render();
    await slot.findByText("Failed");
    fireEvent.click(slot.getByRole("button", { name: "Dismiss Failed notice for Refactor parser" }));
    await waitFor(() => expect(slot.queryByText("Failed")).toBeNull());
    slot.lifecycle.unmount();

    slot = render();
    await waitFor(() => expect(slot.queryByText("Failed")).toBeNull());
    slot.lifecycle.unmount();

    currentThread = "thread-2";
    slot = render();
    await slot.findByText("Failed");
    slot.lifecycle.unmount();

    currentThread = job.threadId;
    current = { ...current, resultRevision: 2 };
    slot = render();
    await slot.findByText("Failed");
    slot.lifecycle.unmount();
  });

  it("uses an in-memory dismissal fallback when session storage throws", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
    const failed = { ...job, engineStatus: "cancelled", observationState: "cancelled", resultRevision: 1 };
    const slot = renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
      composer: { scope: { kind: "thread", threadId: job.threadId } },
      rpc: { listJobs: () => ({ jobs: [failed], nextCursor: null }), getRunGraph: () => graph },
    });
    await slot.findByText("Cancelled");
    fireEvent.click(slot.getByRole("button", { name: "Dismiss Cancelled notice for Refactor parser" }));
    await waitFor(() => expect(slot.queryByText("Cancelled")).toBeNull());
    if (original) Object.defineProperty(window, "sessionStorage", original);
    slot.lifecycle.unmount();
  });

  it("keeps dismissed attention in memory when session storage writes fail", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    const failed = { ...job, id: "write-fail-job", runId: "write-fail-run", engineStatus: "failed", observationState: "failed", resultRevision: 1 };
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } },
    });
    const render = () => renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
      composer: { scope: { kind: "thread", threadId: job.threadId } },
      rpc: { listJobs: () => ({ jobs: [failed], nextCursor: null }), getRunGraph: () => graph },
    });
    let slot = render();
    await slot.findByText("Failed");
    fireEvent.click(slot.getByRole("button", { name: "Dismiss Failed notice for Refactor parser" }));
    await waitFor(() => expect(slot.queryByText("Failed")).toBeNull());
    slot.lifecycle.unmount();

    slot = render();
    await waitFor(() => expect(slot.queryByText("Failed")).toBeNull());
    if (original) Object.defineProperty(window, "sessionStorage", original);
    slot.lifecycle.unmount();
  });
});
