import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWorkflowGraph } from "../../dot/graph";
import { createContext } from "../../engine/context";
import { createThreadAgentBackend } from "../../server/backend";
import type { WorkflowNode } from "../../engine/types";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function graph(dot: string) {
  return parseWorkflowGraph(dot);
}

function node(g: ReturnType<typeof graph>, id: string): WorkflowNode {
  const found = g.nodes.get(id);
  if (!found) throw new Error(`no such node ${id}`);
  return found;
}

const NEVER_ABORT = new AbortController().signal;

// The fake host dispatches thread.idle/failed synchronously to already-
// registered listeners; backend.run() reaches its own waitForCompletion()
// registration only after several real microtask hops (spawn, then an
// immediate reconcile get()). flush() lets that chain fully unwind before a
// test fires the event it is meant to observe.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
const MODEL_CATALOG = {
  models: [{ id: "sonnet", model: "claude-sonnet-5", displayName: "Sonnet", defaultReasoningEffort: "medium", isDefault: true, supportedReasoningEfforts: [] }],
  selectedOnlyModels: [],
  providers: [],
  permissionCeiling: "full",
  modelLoadError: null,
};

function makeHost() {
  const host = createFakePluginHost({
    sdk: {
      threads: {
        // Distinguishes the origin thread from a freshly spawned worker: a
        // real worker is never already "idle" the instant after spawn, so
        // the backend's "reconcile immediately" get() falls through to
        // waiting for the thread.idle/failed event, like production.
        get: async (args: { threadId: string }) =>
          args.threadId === "origin-thread"
            ? makeThreadResponse({ id: "origin-thread", providerId: "anthropic", projectId: "project-1", environmentId: "env-1" })
            : makeThreadResponse({ id: args.threadId, status: "active" }),
        defaultExecutionOptions: async () => ({ model: "claude-sonnet-5", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default", source: "client/thread/start" }),
        spawn: async () => makeThreadResponse({ id: "worker-thread" }),
        output: async () => ({ output: "the plan is done" }),
        send: async () => ({ ok: true, delivery: "sent" }),
      },
      providers: {
        models: async () => MODEL_CATALOG,
      },
    },
  });
  hosts.push(host);
  return host;
}

function baseInput(g: ReturnType<typeof graph>, nodeId: string, emit: (e: unknown) => void = () => {}) {
  return {
    node: node(g, nodeId),
    graph: g,
    context: createContext({}),
    runId: "r",
    stageId: `${nodeId}@1`,
    signal: NEVER_ABORT,
    emit,
    threadId: "origin-thread",
    projectId: "project-1",
    environmentId: "env-1",
  };
}

const PLAN_GRAPH = `digraph G {
  start [shape=Mdiamond]
  exit  [shape=Msquare]
  plan  [label="Plan", prompt="Write a plan."]
  start -> plan -> exit
}`;

describe("createThreadAgentBackend: spawning", () => {
  it("spawns a hidden worker thread reusing the origin environment, with the resolved model tuple", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(PLAN_GRAPH);
    const runPromise = backend.run(baseInput(g, "plan"));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      projectId: "project-1",
      environment: { type: "reuse", environmentId: "env-1" },
      providerId: "anthropic",
      model: "claude-sonnet-5",
      reasoningLevel: "medium",
      permissionMode: "auto",
      visibility: "hidden",
    });
  });

  it("prefers a stylesheet-resolved model/provider/reasoning_effort over the origin thread's defaults", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    host.harness.sdk.stub("providers.models", async () => ({
      ...MODEL_CATALOG,
      models: [{ id: "opus", model: "claude-opus-5", displayName: "Opus", defaultReasoningEffort: "high", isDefault: false, supportedReasoningEfforts: [] }],
    }));
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      graph [model_stylesheet="#plan { model: claude-opus-5; provider: anthropic; reasoning_effort: high; }"]
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      plan  [label="Plan", prompt="Write a plan."]
      start -> plan -> exit
    }`);
    const runPromise = backend.run(baseInput(g, "plan"));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    expect(spawnCalls[0]).toMatchObject({ model: "claude-opus-5", providerId: "anthropic", reasoningLevel: "high" });
  });

  it("prefers a node's own permission_mode over the origin thread's default", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      plan  [label="Plan", prompt="Write a plan.", permission_mode=accept-edits]
      start -> plan -> exit
    }`);
    const runPromise = backend.run(baseInput(g, "plan"));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    expect(spawnCalls[0]).toMatchObject({ permissionMode: "accept-edits" });
  });

  it("falls back to the graph's default_permission_mode when the node declares none", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      graph [default_permission_mode=full]
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      plan  [label="Plan", prompt="Write a plan."]
      start -> plan -> exit
    }`);
    const runPromise = backend.run(baseInput(g, "plan"));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    expect(spawnCalls[0]).toMatchObject({ permissionMode: "full" });
  });

  it("maps a dialect-only permission_mode (workspace-write/readonly) down to the closest BB spawn permission mode (accept-edits/auto)", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      write [label="Write", prompt="Write.", permission_mode=workspace-write]
      readonly [label="Readonly", prompt="Read only.", permission_mode=readonly]
      start -> write -> readonly -> exit
    }`);
    const writeRun = backend.run(baseInput(g, "write"));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await writeRun;
    const readonlyRun = backend.run(baseInput(g, "readonly"));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await readonlyRun;

    expect(spawnCalls[0]).toMatchObject({ permissionMode: "accept-edits" });
    expect(spawnCalls[1]).toMatchObject({ permissionMode: "auto" });
  });

  it("defaults an undeclared worker to auto even when the origin thread default is full", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    host.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({
      model: "claude-sonnet-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      source: "client/thread/start",
    }));
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(PLAN_GRAPH);
    const runPromise = backend.run(baseInput(g, "plan"));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    expect(spawnCalls[0]).toMatchObject({ permissionMode: "auto" });
  });

  it("fails the stage with a clear error rather than silently substituting an unknown model", async () => {
    const host = makeHost();
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      plan  [label="Plan", prompt="Write a plan.", model="no-such-model"]
      start -> plan -> exit
    }`);
    await expect(backend.run(baseInput(g, "plan"))).rejects.toThrow(/no-such-model/);
  });
});

describe("createThreadAgentBackend: completion", () => {
  it("resolves succeeded with the thread's output text once the worker goes idle", async () => {
    const host = makeHost();
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(PLAN_GRAPH);
    const runPromise = backend.run(baseInput(g, "plan"));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "the plan is done" });
    const outcome = await runPromise;
    expect(outcome).toEqual({ status: "succeeded", text: "the plan is done" });
  });

  it("emits agent.thread with the worker's threadId", async () => {
    const host = makeHost();
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(PLAN_GRAPH);
    const emitted: unknown[] = [];
    const runPromise = backend.run(baseInput(g, "plan", (e) => emitted.push(e)));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;
    expect(emitted).toEqual([{ type: "agent.thread", threadId: "worker-thread", provider: "anthropic", model: "claude-sonnet-5", reasoningLevel: "medium" }]);
  });

  it("throws (an engine-retryable fault) when the worker thread fails", async () => {
    const host = makeHost();
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(PLAN_GRAPH);
    const runPromise = backend.run(baseInput(g, "plan"));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "worker-thread" }), error: "provider exploded" });
    await expect(runPromise).rejects.toThrow(/provider exploded/);
  });

  it("reconciles immediately when the worker thread already finished before the event listener could matter", async () => {
    const host = makeHost();
    host.harness.sdk.stub("threads.get", async (args: { threadId: string }) =>
      args.threadId === "worker-thread"
        ? makeThreadResponse({ id: "worker-thread", status: "idle" })
        : makeThreadResponse({ id: "origin-thread", providerId: "anthropic", projectId: "project-1", environmentId: "env-1" }),
    );
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(PLAN_GRAPH);
    const outcome = await backend.run(baseInput(g, "plan"));
    expect(outcome).toEqual({ status: "succeeded", text: "the plan is done" });
  });

  it("does not lose a thread.idle delivered while the post-spawn reconcile get() is still in flight", async () => {
    const host = makeHost();
    // A signal, rather than a raw timing race, pins down exactly when the
    // reconcile get() call for "worker-thread" has actually started — which
    // is necessarily *after* reconcileOrWait has already registered its
    // waiter (that registration is synchronous, before the get() call is
    // even made). Firing the idle event only once this fires reproduces the
    // "stale snapshot, taken before idle" race deterministically: the get()
    // call's eventual (delayed) "active" response must not be allowed to
    // clobber a completion an event already delivered while it was in flight.
    let signalGetStarted: () => void = () => {};
    const getStarted = new Promise<void>((resolve) => {
      signalGetStarted = resolve;
    });
    host.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      if (args.threadId !== "worker-thread") return makeThreadResponse({ id: "origin-thread", providerId: "anthropic", projectId: "project-1", environmentId: "env-1" });
      signalGetStarted();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return makeThreadResponse({ id: "worker-thread", status: "active" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(PLAN_GRAPH);

    const runPromise = backend.run(baseInput(g, "plan"));
    await getStarted;
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });

    const outcome = await Promise.race([
      runPromise,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("HUNG: agent stage never completed")), 1500)),
    ]);
    expect(outcome).toEqual({ status: "succeeded", text: "the plan is done" });
  });
});

describe("createThreadAgentBackend: cancellation", () => {
  it("refuses to spawn a worker thread once the run has already been cancelled", async () => {
    const host = makeHost();
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(PLAN_GRAPH);
    const controller = new AbortController();
    controller.abort();
    await expect(backend.run({ ...baseInput(g, "plan"), signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("stops the live worker thread and rejects the stage when the run is aborted while awaiting its completion", async () => {
    const host = makeHost();
    const stopCalls: unknown[] = [];
    // Never completes on its own — only an explicit stop should ever settle this stage.
    host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-thread" }));
    host.harness.sdk.stub("threads.stop", async (args: unknown) => {
      stopCalls.push(args);
      return { ok: true };
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(PLAN_GRAPH);
    const controller = new AbortController();
    const runPromise = backend.run({ ...baseInput(g, "plan"), signal: controller.signal });
    await flush();

    controller.abort();
    await expect(runPromise).rejects.toThrow(/cancelled/);
    expect(stopCalls).toEqual([{ threadId: "worker-thread" }]);
  });

  it("also stops the worker thread when the abort happens mid corrective-retry wait for a structured result", async () => {
    const host = makeHost();
    const stopCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-thread" }));
    host.harness.sdk.stub("threads.stop", async (args: unknown) => {
      stopCalls.push(args);
      return { ok: true };
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      review [label="Review", prompt="Review.", output_schema="routing"]
      start -> review -> exit
    }`);
    const controller = new AbortController();
    const runPromise = backend.run({ ...baseInput(g, "review"), signal: controller.signal });
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "not json" });
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));

    controller.abort();
    await expect(runPromise).rejects.toThrow(/cancelled/);
    expect(stopCalls).toEqual([{ threadId: "worker-thread" }]);
  });
});

describe("createThreadAgentBackend: structured results (output_schema=routing)", () => {
  const ROUTING_GRAPH = `digraph G {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    review [label="Review", prompt="Review.", output_schema="routing"]
    start -> review -> exit
  }`;

  it("builds the outcome from a validated attractor_result report", async () => {
    const host = makeHost();
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(ROUTING_GRAPH);
    const runPromise = backend.run(baseInput(g, "review"));
    await flush();
    backend.reportResult("worker-thread", { outcome: "succeeded", preferred_next_label: "Accept", context_updates: { reviewed: true } });
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "{}" });
    const outcome = await runPromise;
    expect(outcome).toEqual({ status: "succeeded", preferredLabel: "Accept", contextUpdates: { reviewed: true }, text: "the plan is done" });
  });

  it("re-prompts the same thread up to twice on an invalid/missing report, then fails", async () => {
    const host = makeHost();
    const sendCalls: unknown[] = [];
    host.harness.sdk.stub("threads.send", async (args: unknown) => {
      sendCalls.push(args);
      return { ok: true, delivery: "sent" };
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(ROUTING_GRAPH);
    const runPromise = backend.run(baseInput(g, "review"));
    await flush();
    // Three idle rounds: no valid report on any of them. Waiting for each
    // corrective threads.send before firing the next idle event keeps this
    // deterministic — otherwise a same-tick second event could arrive before
    // the backend re-registered its waiter for it.
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "not json" });
    await vi.waitFor(() => expect(sendCalls).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "not json" });
    await vi.waitFor(() => expect(sendCalls).toHaveLength(2));
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "not json" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("failed");
    expect(sendCalls).toHaveLength(2);
  });

  it("recovers if a later corrective round reports a valid result", async () => {
    const host = makeHost();
    const sendCalls: unknown[] = [];
    host.harness.sdk.stub("threads.send", async (args: unknown) => {
      sendCalls.push(args);
      return { ok: true, delivery: "sent" };
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(ROUTING_GRAPH);
    const runPromise = backend.run(baseInput(g, "review"));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "not json" });
    await vi.waitFor(() => expect(sendCalls).toHaveLength(1));
    backend.reportResult("worker-thread", { outcome: "failed", failure_reason: "could not decide" });
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "{}" });
    const outcome = await runPromise;
    expect(outcome).toEqual({ status: "failed", failureReason: "could not decide", text: "the plan is done" });
  });
});

describe("createThreadAgentBackend: prompt assembly", () => {
  it("omits prior stages and parallel results for a fidelity=truncate node, keeping only the goal and its own prompt", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      graph [goal="Ship it"]
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      build  [label="Build", prompt="Build it."]
      critic [label="Critic", prompt="Judge the artifact.", fidelity="truncate"]
      start -> build -> critic -> exit
    }`);
    const context = createContext({
      response: { build: "I chose approach X because it is clearly the best" },
      stage_status: { build: "succeeded" },
      parallel: { branch_count: 1, results: [{ id: "lens", index: 0, status: "succeeded", text: "branch said things" }] },
    });
    const runPromise = backend.run({ ...baseInput(g, "critic"), context });
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    const prompt = (spawnCalls[0] as { prompt: string }).prompt;
    expect(prompt).toBe("Goal: Ship it\n\nJudge the artifact.");
  });

  it("includes each prior stage's node id, label, and status alongside its response preview", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      plan  [label="Plan", prompt="Write a plan."]
      build [label="Build", prompt="Build it."]
      start -> plan -> build -> exit
    }`);
    // As if the engine had already run "plan" (engine.ts's writeOutcomeToContext
    // writes exactly these two keys per completed stage).
    const context = createContext({ response: { plan: "the plan is done" }, stage_status: { plan: "succeeded" } });
    const runPromise = backend.run({ ...baseInput(g, "build"), context });
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    const prompt = (spawnCalls[0] as { prompt: string }).prompt;
    expect(prompt).toContain("plan | Plan | succeeded: the plan is done");
  });

  it("raises the prior-stage preview to 400 chars and marks a cut response with a trailing truncation marker", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      plan  [label="Plan", prompt="Write a plan."]
      build [label="Build", prompt="Build it."]
      start -> plan -> build -> exit
    }`);
    const longResponse = "x".repeat(350) + "y".repeat(100); // 450 chars, past the old 200-char cut
    const context = createContext({ response: { plan: longResponse }, stage_status: { plan: "succeeded" } });
    const runPromise = backend.run({ ...baseInput(g, "build"), context });
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    const prompt = (spawnCalls[0] as { prompt: string }).prompt;
    expect(prompt).toContain(`${"x".repeat(350)}${"y".repeat(50)} …[truncated]`);
    expect(prompt).not.toContain("y".repeat(100));
  });

  it("does not append a truncation marker when the prior stage's response fits within 400 chars", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      plan  [label="Plan", prompt="Write a plan."]
      build [label="Build", prompt="Build it."]
      start -> plan -> build -> exit
    }`);
    const context = createContext({ response: { plan: "short response" }, stage_status: { plan: "succeeded" } });
    const runPromise = backend.run({ ...baseInput(g, "build"), context });
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    const prompt = (spawnCalls[0] as { prompt: string }).prompt;
    expect(prompt).toContain("plan | Plan | succeeded: short response");
    expect(prompt).not.toContain("[truncated]");
  });

  it("renders a 'Parallel results (N):' section after 'Prior stages:' when context.parallel.results is non-empty", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      digest [label="Digest", prompt="Summarise the branches."]
      start -> digest -> exit
    }`);
    const context = createContext({
      response: { fork: "fanned out" },
      stage_status: { fork: "succeeded" },
      parallel: {
        branch_count: 2,
        results: [
          { id: "security", index: 0, status: "succeeded", text: "no issues found" },
          { id: "quality", index: 1, status: "failed", text: "lint errors remain" },
        ],
      },
    });
    const runPromise = backend.run({ ...baseInput(g, "digest"), context });
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    const prompt = (spawnCalls[0] as { prompt: string }).prompt;
    expect(prompt).toContain("Parallel results (2):");
    expect(prompt).toContain("- security | succeeded: no issues found");
    expect(prompt).toContain("- quality | failed: lint errors remain");
    // The section must come after "Prior stages:" per the plan.
    expect(prompt.indexOf("Prior stages:")).toBeLessThan(prompt.indexOf("Parallel results (2):"));
  });

  it("truncates a parallel branch's text preview the same way as a prior stage's response", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      digest [label="Digest", prompt="Summarise the branches."]
      start -> digest -> exit
    }`);
    const longText = "x".repeat(450);
    const context = createContext({ parallel: { branch_count: 1, results: [{ id: "security", index: 0, status: "succeeded", text: longText }] } });
    const runPromise = backend.run({ ...baseInput(g, "digest"), context });
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    const prompt = (spawnCalls[0] as { prompt: string }).prompt;
    expect(prompt).toContain(`${"x".repeat(400)} …[truncated]`);
    expect(prompt).not.toContain("x".repeat(450));
  });

  it("omits the 'Parallel results' section when context.parallel.results is absent or empty", async () => {
    const host = makeHost();
    const spawnCalls: unknown[] = [];
    host.harness.sdk.stub("threads.spawn", async (args: unknown) => {
      spawnCalls.push(args);
      return makeThreadResponse({ id: "worker-thread" });
    });
    const backend = createThreadAgentBackend(host.bb);
    const g = graph(PLAN_GRAPH);
    const runPromise = backend.run(baseInput(g, "plan"));
    await flush();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await runPromise;

    const prompt = (spawnCalls[0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("Parallel results");
  });
});

describe("createThreadAgentBackend: waiting out a retryable provider failure", () => {
  const RESET = Date.now() + 60 * 60_000;

  function turnFailed(overrides: Record<string, unknown> = {}): PluginTurnFailedEvent {
    return {
      threadId: "worker-thread",
      requestId: "req-1",
      turnId: null,
      errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null },
      inputAccepted: false,
      rateLimits: {
        kind: "subscription-window",
        overageReason: null,
        overageStatus: null,
        providerId: "anthropic",
        reachedReason: null,
        status: "blocked",
        windows: [{ label: "5-hour", providerKey: null, resetsAtMs: RESET, status: "blocked" }],
      },
      attemptNumber: 1,
      ...overrides,
    } as PluginTurnFailedEvent;
  }

  function start(retry: (args: unknown) => Promise<unknown> = async () => ({ ok: true })) {
    const host = makeHost();
    const retryCalls: Array<{ threadId: string; turnRequestId: string; sendAt: number; reason: string }> = [];
    host.harness.sdk.stub("threads.retry", async (args: unknown) => {
      retryCalls.push(args as (typeof retryCalls)[number]);
      return retry(args);
    });
    const backend = createThreadAgentBackend(host.bb, { failureGraceMs: 20 });
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const runPromise = backend.run(baseInput(graph(PLAN_GRAPH), "plan", (e) => emitted.push(e as (typeof emitted)[number])));
    const settled = { done: false };
    runPromise.then(() => { settled.done = true; }, () => { settled.done = true; });
    const fire = host.harness.behavior.emitThreadEvent;
    const worker = () => makeThreadResponse({ id: "worker-thread" });
    return { host, retryCalls, emitted, runPromise, settled, fire, worker };
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("queues a retry for after the usage window reopens and keeps the stage waiting on the same worker", async () => {
    const t = start();
    await flush();
    await t.fire("thread.failed", { thread: t.worker(), error: "You've hit your 5-hour limit" });
    await t.fire("turn.failed", turnFailed());
    await wait(60); // well past the failure grace: the stage must not have failed

    expect(t.settled.done).toBe(false);
    expect(t.retryCalls).toHaveLength(1);
    expect(t.retryCalls[0]).toMatchObject({ threadId: "worker-thread", turnRequestId: "req-1", reason: "Rate limited" });
    expect(t.retryCalls[0]!.sendAt).toBeGreaterThanOrEqual(RESET + 15_000);
    const waiting = t.emitted.find((e) => e.type === "agent.waiting");
    expect(waiting).toMatchObject({ threadId: "worker-thread", interactionId: "req-1" });
    expect(String(waiting?.kind)).toMatch(/^Rate limited, retrying at \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);

    // The window reopens: bb re-runs the turn on the same thread, and the stage completes normally.
    await t.fire("thread.active", { thread: t.worker() });
    expect(t.emitted.at(-1)).toEqual({ type: "agent.resumed", threadId: "worker-thread" });
    await t.fire("thread.idle", { thread: t.worker(), lastAssistantText: "done" });
    await expect(t.runPromise).resolves.toMatchObject({ status: "succeeded" });
  });

  it("handles turn.failed arriving before thread.failed", async () => {
    const t = start();
    await flush();
    await t.fire("turn.failed", turnFailed());
    await t.fire("thread.failed", { thread: t.worker(), error: "limit" });
    await wait(60);
    expect(t.settled.done).toBe(false);
    expect(t.retryCalls).toHaveLength(1);
    await t.fire("thread.idle", { thread: t.worker(), lastAssistantText: "done" });
    await expect(t.runPromise).resolves.toMatchObject({ status: "succeeded" });
  });

  it("waits again when the retried turn fails on the limit a second time", async () => {
    const t = start();
    await flush();
    await t.fire("thread.failed", { thread: t.worker(), error: "limit" });
    await t.fire("turn.failed", turnFailed());
    await t.fire("thread.active", { thread: t.worker() });
    await t.fire("thread.failed", { thread: t.worker(), error: "limit" });
    await t.fire("turn.failed", turnFailed({ requestId: "req-2", attemptNumber: 2 }));
    await wait(60);
    expect(t.settled.done).toBe(false);
    expect(t.retryCalls.map((call) => call.turnRequestId)).toEqual(["req-1", "req-2"]);
  });

  it("fails the stage when the failure is not one that passes by itself", async () => {
    const t = start();
    await flush();
    await t.fire("thread.failed", { thread: t.worker(), error: "context window exceeded" });
    await t.fire("turn.failed", turnFailed({ errorInfo: { category: "context-window-exceeded", httpStatusCode: null, providerCode: null } }));
    await expect(t.runPromise).rejects.toThrow(/context window exceeded/);
    expect(t.retryCalls).toEqual([]);
  });

  it("fails the stage when the retries are exhausted", async () => {
    const t = start();
    await flush();
    await t.fire("thread.failed", { thread: t.worker(), error: "limit" });
    await t.fire("turn.failed", turnFailed({ attemptNumber: 5 }));
    await expect(t.runPromise).rejects.toThrow(/limit/);
  });

  it("keeps waiting when another policy already queued the retry", async () => {
    const t = start(async () => {
      throw new Error("a retry is already queued for this turn");
    });
    t.host.harness.sdk.stub("threads.queuedMessages.list", async () => [{ id: "queued-retry", threadId: "worker-thread" }]);
    await flush();
    await t.fire("thread.failed", { thread: t.worker(), error: "limit" });
    await t.fire("turn.failed", turnFailed());
    await wait(60);
    expect(t.settled.done).toBe(false);
    expect(t.emitted.some((e) => e.type === "agent.waiting")).toBe(true);
    await t.fire("thread.idle", { thread: t.worker(), lastAssistantText: "done" });
    await expect(t.runPromise).resolves.toMatchObject({ status: "succeeded" });
  });

  it("fails the stage when the retry cannot be queued", async () => {
    const t = start(async () => {
      throw new Error("thread has moved on");
    });
    t.host.harness.sdk.stub("threads.queuedMessages.list", async () => []);
    await flush();
    await t.fire("thread.failed", { thread: t.worker(), error: "limit" });
    await t.fire("turn.failed", turnFailed());
    await expect(t.runPromise).rejects.toThrow(/limit/);
  });

  it("fails the stage when someone cancels the queued retry", async () => {
    const t = start();
    await flush();
    await t.fire("thread.failed", { thread: t.worker(), error: "limit" });
    await t.fire("turn.failed", turnFailed());
    await wait(40);
    await t.fire("message.cancelled", { entry: { threadId: "worker-thread" } } as never);
    await expect(t.runPromise).rejects.toThrow(/retry was cancelled/);
  });

  it("ignores a failed turn on a thread it is not waiting on", async () => {
    const t = start();
    await flush();
    await t.fire("turn.failed", turnFailed({ threadId: "someone-elses-thread" }));
    expect(t.retryCalls).toEqual([]);
    await t.fire("thread.idle", { thread: t.worker(), lastAssistantText: "done" });
    await t.runPromise;
  });
});
