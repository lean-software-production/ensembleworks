import Database from "better-sqlite3";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createService, resolveWorkflowPath } from "../../server/service";
import { RunStore } from "../../server/store";
import type { AgentBackend, AgentRunInput } from "../../server/backend";
import type { HumanAskResult, HumanInterviewer } from "../../handlers/human";

describe("resolveWorkflowPath", () => {
  it("joins a relative path onto the environment root", () => {
    expect(resolveWorkflowPath("workflows/plan.dot", "/repo")).toBe("/repo/workflows/plan.dot");
    expect(resolveWorkflowPath("./plan.dot", "/repo")).toBe("/repo/plan.dot");
  });

  it("rejects a path that escapes the environment root", () => {
    expect(() => resolveWorkflowPath("../secrets.dot", "/repo")).toThrow(/escapes/);
    expect(() => resolveWorkflowPath("../../etc/passwd", "/repo")).toThrow(/escapes/);
    expect(() => resolveWorkflowPath("workflows/../../secrets.dot", "/repo")).toThrow(/escapes/);
  });

  it("rejects an absolute path", () => {
    expect(() => resolveWorkflowPath("/etc/passwd", "/repo")).toThrow(/escapes|absolute/);
  });

  it("tolerates a trailing slash on the environment root instead of rejecting every relative path", () => {
    expect(resolveWorkflowPath("plan.dot", "/repo/")).toBe("/repo/plan.dot");
    expect(resolveWorkflowPath("workflows/plan.dot", "/repo/")).toBe("/repo/workflows/plan.dot");
    expect(() => resolveWorkflowPath("../secrets.dot", "/repo/")).toThrow(/escapes/);
  });

  it("still handles the environment root being exactly '/'", () => {
    expect(resolveWorkflowPath("plan.dot", "/")).toBe("/plan.dot");
  });
});

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function makeHost() {
  const host = createFakePluginHost({
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "origin-thread" }),
      },
      environments: {
        get: async () => ({
          id: "env-1", projectId: "project-1", hostId: "host-1", path: "/repo", isGitRepo: true, isWorktree: false,
          status: "ready", createdAt: 1, updatedAt: 1, baseBranch: null, branchName: null, defaultBranch: null,
          environmentProviderId: null, environmentProviderInstanceKey: null, environmentProviderSelection: null,
          lifecycle: { phase: "active", retireAt: null, teardown: null }, managed: false, mergeBaseBranch: null,
          name: null, workspaceProvisionType: null,
        }),
      },
    },
  });
  hosts.push(host);
  return host;
}

function fakeBackend(run: AgentBackend["run"]): AgentBackend {
  return { run, reportResult: vi.fn(), isAwaitingResult: () => false, isWorkerThread: () => false };
}

function noopExecClient() {
  return { call: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) };
}

const SIMPLE_GRAPH = `digraph G {
  start [shape=Mdiamond]
  exit  [shape=Msquare]
  plan  [label="Plan", prompt="do it"]
  start -> plan -> exit
}`;

describe("createService: run lifecycle", () => {
  it("creates a persisted run and returns the directive text", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async () => ({ status: "succeeded", text: "done" }));
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient() });

    const { run, directive } = await service.createAndStartRun({
      source: SIMPLE_GRAPH,
      threadId: "origin-thread",
      projectId: "project-1",
      environmentId: "env-1",
    });

    expect(directive).toBe(`::attractor-run{run="${run.id}"}`);
    expect(store.getRun(run.id).id).toBe(run.id);
    // Let the fire-and-forget background execution finish before the host is
    // disposed in afterEach — otherwise its trailing bb.realtime.publish call
    // races the fake host's teardown and surfaces as an unhandled rejection.
    await vi.waitFor(() => expect(store.getRun(run.id).status).not.toBe("running"));
  });

  it("rejects an invalid workflow before persisting a run", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async () => ({ status: "succeeded" }));
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient() });

    await expect(
      service.createAndStartRun({ source: "digraph G { a [label=\"no start or exit\"] }", threadId: "origin-thread", projectId: "project-1", environmentId: "env-1" }),
    ).rejects.toThrow(/start/);
    expect(store.listRuns({ threadId: "origin-thread" }).runs).toHaveLength(0);
  });

  it("runs the graph to completion in the background, persisting stages and events, and publishing realtime updates", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async (input: AgentRunInput) => {
      input.emit({ type: "agent.thread", threadId: "worker-thread" });
      return { status: "succeeded", text: "the plan" };
    });
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient() });

    const { run } = await service.createAndStartRun({ source: SIMPLE_GRAPH, threadId: "origin-thread", projectId: "project-1", environmentId: "env-1" });
    await vi.waitFor(() => expect(store.getRun(run.id).status).toBe("succeeded"));

    const stages = store.listStages(run.id);
    expect(stages.map((s) => s.nodeId)).toEqual(["start", "plan", "exit"]);
    expect(stages.find((s) => s.nodeId === "plan")).toMatchObject({ status: "succeeded", threadId: "worker-thread" });
    expect(store.listEvents(run.id).some((e) => e.type === "run.completed")).toBe(true);
    expect(host.harness.inspection.realtimeSignals.some((s) => s.channel === "attractor-runs")).toBe(true);
  });

  it("retries a stage whose backend call throws (an engine-retryable fault), succeeding on the second attempt", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    let calls = 0;
    const backend = fakeBackend(async () => {
      calls += 1;
      if (calls === 1) throw new Error("worker thread failed: provider exploded");
      return { status: "succeeded", text: "done" };
    });
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient(), clock: { now: () => Date.now(), sleep: async () => {} } });

    const RETRY_GRAPH = `digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      plan  [label="Plan", prompt="do it", max_retries=1]
      start -> plan -> exit
    }`;
    const { run } = await service.createAndStartRun({ source: RETRY_GRAPH, threadId: "origin-thread", projectId: "project-1", environmentId: "env-1" });
    await vi.waitFor(() => expect(store.getRun(run.id).status).toBe("succeeded"));

    expect(calls).toBe(2);
    const events = store.listEvents(run.id);
    const failedEvent = events.find((e) => e.type === "stage.failed");
    expect(failedEvent).toMatchObject({ willRetry: true });
  });

  it("getGraph reflects live per-node stage status", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async () => ({ status: "succeeded" }));
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient() });
    const { run } = await service.createAndStartRun({ source: SIMPLE_GRAPH, threadId: "origin-thread", projectId: "project-1", environmentId: "env-1" });
    await vi.waitFor(() => expect(store.getRun(run.id).status).toBe("succeeded"));

    const view = service.getGraph(run.id);
    expect(view?.nodes.find((n) => n.id === "plan")).toMatchObject({ status: "succeeded", visit: 1 });
    expect(view?.edges).toContainEqual({ from: "start", to: "plan", label: null, condition: null });
  });

  it("getGraph reports the graph's rankdir and each node's declared model/provider, for the DAG UI (T5)", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async () => ({ status: "succeeded" }));
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient() });
    const STYLED_GRAPH = `digraph G {
      graph [rankdir=LR]
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      plan  [label="Plan", prompt="do it", model="claude-sonnet-5", provider="anthropic"]
      start -> plan -> exit
    }`;
    const { run } = await service.createAndStartRun({ source: STYLED_GRAPH, threadId: "origin-thread", projectId: "project-1", environmentId: "env-1" });
    await vi.waitFor(() => expect(store.getRun(run.id).status).toBe("succeeded"));

    const view = service.getGraph(run.id);
    expect(view?.rankdir).toBe("LR");
    expect(view?.nodes.find((n) => n.id === "plan")).toMatchObject({ model: "claude-sonnet-5", provider: "anthropic" });
    expect(view?.nodes.find((n) => n.id === "start")).toMatchObject({ model: null, provider: null });
  });

  it("stopRun aborts the run's controller, letting a backend that observes the signal unwedge the stage", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    // A stand-in for server/backend.ts's real behaviour post-fix: it never
    // resolves on its own, only on the signal it was handed.
    const backend = fakeBackend(
      (input: AgentRunInput) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(new Error("worker thread stopped: run was cancelled")), { once: true });
        }),
    );
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient() });

    const { run } = await service.createAndStartRun({ source: SIMPLE_GRAPH, threadId: "origin-thread", projectId: "project-1", environmentId: "env-1" });
    await vi.waitFor(() => expect(store.getRun(run.id).status).toBe("running"));

    service.stopRun(run.id);
    await vi.waitFor(() => expect(store.getRun(run.id).status).toBe("cancelled"));
  });
});

const HUMAN_GATE_GRAPH = `digraph G {
  start [shape=Mdiamond]
  exit  [shape=Msquare]
  revise [label="Revise", prompt="Revise the plan."]
  gate  [shape=hexagon, label="Approve plan?"]
  start -> gate
  gate -> exit   [label="[A] Approve"]
  gate -> revise [label="R) Revise"]
  revise -> exit
}`;

describe("createService: human gates (T6)", () => {
  it("blocks the run (and its stage) while the human interviewer is waiting, then resumes and routes by preferred_label once answered", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async () => ({ status: "succeeded" }));
    let resolveAsk: ((result: HumanAskResult) => void) | null = null;
    const humanInterviewer: HumanInterviewer = { ask: () => new Promise((resolve) => { resolveAsk = resolve; }) };
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient(), humanInterviewer });

    const { run } = await service.createAndStartRun({ source: HUMAN_GATE_GRAPH, threadId: "origin-thread", projectId: "project-1", environmentId: "env-1" });

    await vi.waitFor(() => expect(store.getRun(run.id).status).toBe("blocked"));
    expect(store.listStages(run.id).find((s) => s.nodeId === "gate")).toMatchObject({ status: "blocked" });

    resolveAsk!({ kind: "choice", option: { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" } });
    await vi.waitFor(() => expect(store.getRun(run.id).status).toBe("succeeded"));

    const events = store.listEvents(run.id);
    expect(events).toContainEqual(expect.objectContaining({ type: "edge.selected", from: "gate", to: "exit", reason: "preferred_label" }));
    expect(events.some((e) => e.type === "human.requested")).toBe(true);
    expect(events.some((e) => e.type === "human.answered")).toBe(true);
    expect(store.listStages(run.id).find((s) => s.nodeId === "gate")).toMatchObject({ status: "succeeded" });
  });

  it("routes to a different node when the human picks the other option", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async () => ({ status: "succeeded" }));
    const humanInterviewer: HumanInterviewer = {
      ask: async () => ({ kind: "choice", option: { raw: "R) Revise", key: "R", text: "Revise", to: "revise" } }),
    };
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient(), humanInterviewer });

    const { run } = await service.createAndStartRun({ source: HUMAN_GATE_GRAPH, threadId: "origin-thread", projectId: "project-1", environmentId: "env-1" });
    await vi.waitFor(() => expect(store.getRun(run.id).status).toBe("succeeded"));

    expect(store.listStages(run.id).map((s) => s.nodeId)).toEqual(["start", "gate", "revise", "exit"]);
  });

  it("fails a human gate stage clearly (rather than hanging) when no humanInterviewer was configured", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async () => ({ status: "succeeded" }));
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient() });

    const { run } = await service.createAndStartRun({ source: HUMAN_GATE_GRAPH, threadId: "origin-thread", projectId: "project-1", environmentId: "env-1" });
    // Both of `gate`'s outgoing edges carry only a `label`, no `condition` —
    // "unconditional" per the routing cascade — so a failed gate stage still
    // routes onward to one of them (here, "exit") rather than ending the run;
    // what T6 actually guarantees is that the stage itself is recorded
    // failed, never left "running"/"blocked" forever.
    await vi.waitFor(() => expect(store.listStages(run.id).find((s) => s.nodeId === "gate")).toMatchObject({ status: "failed" }));
  });
});

describe("createService: answerHumanGate (T6, bb attractor answer)", () => {
  function pluginInteraction(overrides: Partial<{ id: string; threadId: string; rendererId: string; data: unknown }> = {}) {
    return {
      id: overrides.id ?? "interaction-1",
      threadId: overrides.threadId ?? "origin-thread",
      createdAt: 1,
      expiresAt: null,
      resolvedAt: null,
      status: "pending" as const,
      statusReason: null,
      turnId: null,
      resolution: null,
      origin: { kind: "plugin" as const, pluginId: "attractor", rendererId: overrides.rendererId ?? "attractor-human-gate" },
      payload: { kind: "plugin" as const, title: "Approve plan?", data: overrides.data },
    };
  }

  it("resolves a pending human-gate interaction by matching the answer against an option's label", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async () => ({ status: "succeeded" }));
    const respondCalls: unknown[] = [];
    host.harness.sdk.stub("threads.interactions.list", async () => [
      pluginInteraction({
        data: {
          runId: "run-x",
          nodeId: "gate",
          question: "Approve plan?",
          options: [{ raw: "[A] Approve", key: "A", text: "Approve", to: "exit" }],
          freeform: false,
          questionType: null,
        },
      }),
    ]);
    host.harness.sdk.stub("threads.interactions.respond", async (args: unknown) => {
      respondCalls.push(args);
      return {};
    });
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient() });
    store.createRun({ id: "run-x", threadId: "origin-thread", projectId: null, environmentId: null, title: null, source: HUMAN_GATE_GRAPH, graph: {}, initialContext: {} });

    const result = await service.answerHumanGate("run-x", "approve");

    expect(result).toEqual({ answered: true });
    expect(respondCalls).toEqual([{ interactionId: "interaction-1", threadId: "origin-thread", value: { kind: "choice", raw: "[A] Approve" } }]);
  });

  it("reports no match rather than guessing when the answer names no option and the gate isn't freeform", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async () => ({ status: "succeeded" }));
    host.harness.sdk.stub("threads.interactions.list", async () => [
      pluginInteraction({
        data: {
          runId: "run-x",
          nodeId: "gate",
          question: "Approve plan?",
          options: [{ raw: "[A] Approve", key: "A", text: "Approve", to: "exit" }],
          freeform: false,
          questionType: null,
        },
      }),
    ]);
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient() });
    store.createRun({ id: "run-x", threadId: "origin-thread", projectId: null, environmentId: null, title: null, source: HUMAN_GATE_GRAPH, graph: {}, initialContext: {} });

    const result = await service.answerHumanGate("run-x", "yolo");

    expect(result.answered).toBe(false);
  });

  it("reports no pending gate when there is no matching interaction for this run", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async () => ({ status: "succeeded" }));
    host.harness.sdk.stub("threads.interactions.list", async () => []);
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient() });
    store.createRun({ id: "run-x", threadId: "origin-thread", projectId: null, environmentId: null, title: null, source: HUMAN_GATE_GRAPH, graph: {}, initialContext: {} });

    const result = await service.answerHumanGate("run-x", "approve");

    expect(result).toEqual({ answered: false, reason: "no pending human gate for this run" });
  });

  it("reports no such run for an unknown runId", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const backend = fakeBackend(async () => ({ status: "succeeded" }));
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: noopExecClient() });

    const result = await service.answerHumanGate("missing", "approve");

    expect(result).toEqual({ answered: false, reason: "no such run" });
  });
});
