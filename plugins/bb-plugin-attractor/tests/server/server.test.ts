import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../../server";
import { HUMAN_GATE_RENDERER_ID } from "../../server/contracts";

// `bb.ui.requestInput`'s pending interactions (harness.pendingInteractions /
// submitInteraction) and `bb.sdk.threads.interactions.*` are two independent,
// unstubbed-by-default mechanisms in createFakePluginHost — unlike the real
// host, the fake doesn't wire one to the other. This bridges them for a test
// host so `bb attractor answer` (which only ever talks to
// `threads.interactions.list`/`respond`, per server/service.ts's
// `answerHumanGate`) can resolve a gate that a real `attractor_run` opened
// via `bb.ui.requestInput`, exercising the whole path end to end.
function bridgeHumanGateInteractions(host: ReturnType<typeof createFakePluginHost>) {
  host.harness.sdk.stub("threads.interactions.list", async ({ threadId }: { threadId: string }) =>
    host.harness.pendingInteractions
      .filter((p) => p.threadId === threadId && p.rendererId === HUMAN_GATE_RENDERER_ID)
      .map((p) => ({
        id: p.id,
        threadId: p.threadId,
        createdAt: Date.now(),
        expiresAt: null,
        resolvedAt: null,
        status: "pending" as const,
        statusReason: null,
        turnId: null,
        resolution: null,
        origin: { kind: "plugin" as const, pluginId: "attractor", rendererId: p.rendererId },
        payload: { kind: "plugin" as const, title: p.title, data: p.payload },
      })),
  );
  host.harness.sdk.stub("threads.interactions.respond", async ({ interactionId, value }: { interactionId: string; value: unknown }) => {
    host.harness.submitInteraction(interactionId, value as never);
    return {};
  });
}

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function toolJson(value: unknown): any {
  if (typeof value === "string") return JSON.parse(value);
  const text = (value as { content?: Array<{ type: string; text?: string }> }).content?.find((p) => p.type === "text")?.text;
  return JSON.parse(text ?? "{}");
}

const ENVIRONMENT = {
  id: "env-1", projectId: "project-1", hostId: "host-1", path: "/repo", isGitRepo: true, isWorktree: false,
  status: "ready", createdAt: 1, updatedAt: 1, baseBranch: null, branchName: null, defaultBranch: null,
  environmentProviderId: null, environmentProviderInstanceKey: null, environmentProviderSelection: null,
  lifecycle: { phase: "active", retireAt: null, teardown: null }, managed: false, mergeBaseBranch: null,
  name: null, workspaceProvisionType: null,
};

const MODEL_CATALOG = {
  models: [{ id: "sonnet", model: "claude-sonnet-5", displayName: "Sonnet", defaultReasoningEffort: "medium", isDefault: true, supportedReasoningEfforts: [] }],
  selectedOnlyModels: [], providers: [], permissionCeiling: "full", modelLoadError: null,
};

function baseFileRead({ path }: { path: string }) {
  return { content: `digraph G {\n  start [shape=Mdiamond]\n  exit [shape=Msquare]\n  plan [prompt="do it"]\n  start -> plan -> exit\n}\n// from ${path}`, contentEncoding: "utf8" as const, sha256: "x", sizeBytes: 1 };
}

/** Applies every sdk stub a plugin() instance needs, via harness.sdk.stub — usable both at
 * initial creation and again on a `reload()`-returned host, whose sdk stubs start empty. */
function applyBaseSdkStubs(host: ReturnType<typeof createFakePluginHost>) {
  host.harness.sdk.stub("threads.get", async (args: { threadId: string }) =>
    args.threadId === "worker-thread" ? makeThreadResponse({ id: "worker-thread", status: "active" }) : makeThreadResponse({ id: args.threadId, projectId: "project-1", environmentId: "env-1" }),
  );
  host.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "claude-sonnet-5", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default", source: "client/thread/start" }));
  host.harness.sdk.stub("threads.output", async () => ({ output: "the worker is done" }));
  // A self-completing fake: schedules its own thread.idle on a macrotask so
  // server/backend.ts's real event-driven wait resolves without every test
  // having to drive the event loop by hand.
  host.harness.sdk.stub("threads.spawn", async () => {
    setTimeout(() => {
      void host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    }, 0);
    return makeThreadResponse({ id: "worker-thread" });
  });
  host.harness.sdk.stub("environments.get", async () => ENVIRONMENT);
  host.harness.sdk.stub("providers.models", async () => MODEL_CATALOG);
  host.harness.sdk.stub("files.read", async (args: { path: string }) => baseFileRead(args));
}

function makeHost() {
  const host = createFakePluginHost({
    // Matches skills/attractor/SKILL.md's frontmatter `name: attractor` — an
    // undeclared skill id in bb.agents.configure()'s return fails the whole
    // selection closed (empty tools/skills), per the SDK's own rule.
    agentSkillIds: ["attractor"],
  });
  applyBaseSdkStubs(host);
  hosts.push(host);
  return host;
}

async function waitForTerminalStatus(host: ReturnType<typeof createFakePluginHost>, runId: string): Promise<void> {
  await vi.waitFor(async () => {
    const status = JSON.parse((await host.harness.behavior.runCli(["status", runId], { threadId: "thread-1" })).stdout).status;
    expect(status).not.toBe("running");
  });
}

const INLINE_SOURCE = `digraph G {
  start [shape=Mdiamond]
  exit  [shape=Msquare]
  plan  [prompt="do it"]
  start -> plan -> exit
}`;

describe("attractor server plugin", () => {
  it("loads and registers rpc, cli, tools, and the background service", async () => {
    const host = makeHost();
    await plugin(host.bb);
    expect(host.harness.inspection.registrations.rpcMethods.sort()).toEqual(["getEvents", "getGraph", "getRun", "listRuns", "stopRun"]);
    expect(host.harness.inspection.registrations.cli?.name).toBe("attractor");
    expect(host.harness.inspection.registrations.agentTools.map((t) => t.name).sort()).toEqual(["attractor_inspect", "attractor_result", "attractor_run"]);
    expect(host.harness.inspection.registrations.services.map((s) => s.name)).toContain("attractor-runs");
  });

  it("attractor_run with inline source persists a run and returns the directive", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const result = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: INLINE_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    expect(result.previewDirective).toBe(`::attractor-run{run="${result.runId}"}`);
    const inspected = toolJson(await host.harness.behavior.callAgentTool("attractor_inspect", { runId: result.runId }, { threadId: "thread-1", projectId: "project-1" }));
    expect(inspected.run.id).toBe(result.runId);
    await waitForTerminalStatus(host, result.runId);
  });

  it("attractor_run resolves a relative path against the thread's environment and reads it via bb.sdk.files", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const result = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { path: "workflows/plan.dot" }, { threadId: "thread-1", projectId: "project-1" }));
    expect(result.runId).toBeTruthy();
    await waitForTerminalStatus(host, result.runId);
  });

  it("rejects a path that escapes the environment root, before ever reading a file", async () => {
    const host = makeHost();
    await plugin(host.bb);
    await expect(host.harness.behavior.callAgentTool("attractor_run", { path: "../../etc/passwd" }, { threadId: "thread-1", projectId: "project-1" })).rejects.toThrow(/escapes/);
  });

  it("rejects a tool call giving both source and path, or neither", async () => {
    const host = makeHost();
    await plugin(host.bb);
    await expect(host.harness.behavior.callAgentTool("attractor_run", { source: INLINE_SOURCE, path: "a.dot" }, { threadId: "thread-1" })).rejects.toThrow();
    await expect(host.harness.behavior.callAgentTool("attractor_run", {}, { threadId: "thread-1" })).rejects.toThrow();
  });

  function agentConfigContext(threadId: string) {
    return {
      thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "project-1", kind: "standard" as const, name: "P", gitRemoteUrl: null },
      environment: { id: "env-1", name: null, path: "/repo", branchName: null, workspaceProvisionType: null },
      host: { id: "host-1", name: "H" },
      provider: { id: "anthropic", model: "claude-sonnet-5", capabilities: { supportsNativeUserQuestion: false } },
      origin: { kind: null, pluginId: null },
    };
  }

  it("gates the origin thread to the run/inspect tools + skill", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const origin = await host.harness.behavior.resolveAgentConfiguration(agentConfigContext("thread-1"));
    expect(origin.tools.map((t) => t.name)).toEqual(["attractor_run", "attractor_inspect"]);
    expect(origin.skills).toEqual(["attractor"]);
  });

  it("gates a spawned worker thread to no tools while it holds no output_schema, and to attractor_result while it does", async () => {
    const host = makeHost();
    // Don't auto-complete the spawn for this test: it needs to observe
    // configuration while the worker is still live and awaiting its outcome.
    host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-thread" }));
    await plugin(host.bb);

    const freeText = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: INLINE_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.spawn").length).toBeGreaterThan(0));
    const worker = await host.harness.behavior.resolveAgentConfiguration(agentConfigContext("worker-thread"));
    expect(worker.tools.map((t) => t.name)).toEqual([]);
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await waitForTerminalStatus(host, freeText.runId);

    const ROUTING_SOURCE = `digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      review [prompt="review", output_schema="routing"]
      start -> review -> exit
    }`;
    const routing = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: ROUTING_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.spawn").length).toBeGreaterThan(1));
    const routingWorker = await host.harness.behavior.resolveAgentConfiguration(agentConfigContext("worker-thread"));
    expect(routingWorker.tools.map((t) => t.name)).toEqual(["attractor_result"]);
    await host.harness.behavior.callAgentTool("attractor_result", { outcome: "succeeded" }, { threadId: "worker-thread", projectId: "project-1" });
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "{}" });
    await waitForTerminalStatus(host, routing.runId);
  });

  // Regression for the whole-branch review's blocking finding: bb.agents.configure's
  // callback "runs at thread.start / turn.submit" — and a spawned worker's thread.start
  // fires *inside* bb.sdk.threads.spawn(...), before that call's promise resolves with
  // the worker's own id. The two tests above only ever resolve configuration *after*
  // spawn has already returned, so they can't see this: they'd pass even if gating were
  // wired entirely on the worker's own id (populated too late). Reproduce the real
  // ordering by resolving configuration from inside the `threads.spawn` stub itself.
  it("gates a spawned worker thread correctly at the instant thread.start actually fires, mid-spawn — not just after spawn resolves", async () => {
    const host = makeHost();
    const capturedByRunId: Record<string, { tools: string[]; skills: string[] }> = {};
    let nextRunLabel: "freeText" | "routing" = "freeText";
    host.harness.sdk.stub("threads.spawn", async () => {
      const workerId = "worker-thread";
      // BB stamps the spawning plugin on the new thread's configuration
      // context; that is the only worker signal available this early.
      const config = await host.harness.behavior.resolveAgentConfiguration({
        ...agentConfigContext(workerId),
        origin: { kind: null, pluginId: host.bb.pluginId },
      });
      capturedByRunId[nextRunLabel] = { tools: config.tools.map((t) => t.name), skills: config.skills };
      return makeThreadResponse({ id: workerId });
    });
    await plugin(host.bb);

    const freeText = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: INLINE_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    await vi.waitFor(() => expect(capturedByRunId.freeText).toBeDefined());
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await waitForTerminalStatus(host, freeText.runId);

    // A worker must never hold attractor_run/attractor_inspect or the attractor
    // skill at the moment its session starts — that combination is exactly what
    // lets a spawned worker call attractor_run itself and fan out recursively.
    // Before spawn resolves the backend cannot yet tell a free-text worker from
    // a routing one, so it conservatively gets attractor_result (which rejects
    // reports from stages that do not expect one — see the test below).
    expect(capturedByRunId.freeText.tools).toEqual(["attractor_result"]);
    expect(capturedByRunId.freeText.skills).toEqual([]);

    nextRunLabel = "routing";
    const ROUTING_SOURCE = `digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      review [prompt="review", output_schema="routing"]
      start -> review -> exit
    }`;
    const routing = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: ROUTING_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    await vi.waitFor(() => expect(capturedByRunId.routing).toBeDefined());
    await host.harness.behavior.callAgentTool("attractor_result", { outcome: "succeeded" }, { threadId: "worker-thread", projectId: "project-1" });
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "{}" });
    await waitForTerminalStatus(host, routing.runId);

    // A routing (output_schema) worker must already hold attractor_result at that
    // same instant — otherwise resolveStructured never sees a report and burns every
    // corrective retry on "no attractor_result report was received".
    expect(capturedByRunId.routing.tools).toEqual(["attractor_result"]);
    expect(capturedByRunId.routing.skills).toEqual([]);
  });

  it("attractor_result rejects a report from a thread that is not a worker awaiting a structured result", async () => {
    const host = makeHost();
    host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-thread" }));
    await plugin(host.bb);

    // From the origin thread (never a worker).
    const fromOrigin = toolJson(await host.harness.behavior.callAgentTool("attractor_result", { outcome: "succeeded" }, { threadId: "thread-1", projectId: "project-1" }));
    expect(fromOrigin.recorded).toBe(false);

    // From a live free-text worker (no output_schema on its node).
    const freeText = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: INLINE_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.spawn").length).toBeGreaterThan(0));
    const fromFreeTextWorker = toolJson(await host.harness.behavior.callAgentTool("attractor_result", { outcome: "failed" }, { threadId: "worker-thread", projectId: "project-1" }));
    expect(fromFreeTextWorker.recorded).toBe(false);
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
    await waitForTerminalStatus(host, freeText.runId);
    // The rejected "failed" report must not have influenced the free-text stage.
    const status = JSON.parse((await host.harness.behavior.runCli(["status", freeText.runId], { threadId: "thread-1" })).stdout).status;
    expect(status).toBe("succeeded");
  });

  it("CLI: validate reports diagnostics, run starts a run, status reads it back", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const validated = JSON.parse((await host.harness.behavior.runCli(["validate", "workflows/plan.dot"], { threadId: "thread-1", projectId: "project-1" })).stdout);
    expect(validated.diagnostics.filter((d: { severity: string }) => d.severity === "error")).toHaveLength(0);

    const ran = JSON.parse((await host.harness.behavior.runCli(["run", "workflows/plan.dot"], { threadId: "thread-1", projectId: "project-1" })).stdout);
    expect(ran.previewDirective).toContain("attractor-run");

    const status = JSON.parse((await host.harness.behavior.runCli(["status", ran.runId], { threadId: "thread-1", projectId: "project-1" })).stdout);
    expect(status.id).toBe(ran.runId);
    await waitForTerminalStatus(host, ran.runId);
  });

  it("CLI: unknown command returns a non-zero exit code with usage on stderr", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const result = await host.harness.behavior.runCli(["bogus"], { threadId: "thread-1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bb attractor");
  });

  it("CLI: events --since only returns events after the given seq", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const ran = JSON.parse((await host.harness.behavior.runCli(["run", "workflows/plan.dot"], { threadId: "thread-1", projectId: "project-1" })).stdout);
    await waitForTerminalStatus(host, ran.runId);

    const all = JSON.parse((await host.harness.behavior.runCli(["events", ran.runId], { threadId: "thread-1" })).stdout) as Array<{ seq: number }>;
    expect(all.length).toBeGreaterThan(1);
    const midSeq = all[0].seq;

    const since = JSON.parse((await host.harness.behavior.runCli(["events", ran.runId, "--since", String(midSeq)], { threadId: "thread-1" })).stdout) as Array<{ seq: number }>;
    expect(since.every((e) => e.seq > midSeq)).toBe(true);
    expect(since.length).toBe(all.length - 1);
  });

  it("bb attractor stop unwedges a run parked on an agent stage awaiting a worker thread that never completes on its own", async () => {
    const host = makeHost();
    // Never auto-completes: only the CLI stop below should ever settle it.
    host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-thread" }));
    const stopCalls: unknown[] = [];
    host.harness.sdk.stub("threads.stop", async (args: unknown) => {
      stopCalls.push(args);
      return { ok: true };
    });
    await plugin(host.bb);

    const ran = JSON.parse((await host.harness.behavior.runCli(["run", "workflows/plan.dot"], { threadId: "thread-1", projectId: "project-1" })).stdout);
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.spawn").length).toBeGreaterThan(0));

    const stopResult = await host.harness.behavior.runCli(["stop", ran.runId], { threadId: "thread-1" });
    expect(stopResult.exitCode).toBe(0);

    await vi.waitFor(async () => {
      const status = JSON.parse((await host.harness.behavior.runCli(["status", ran.runId], { threadId: "thread-1" })).stdout).status;
      expect(status).not.toBe("running");
    }, { timeout: 2000 });

    const finalStatus = JSON.parse((await host.harness.behavior.runCli(["status", ran.runId], { threadId: "thread-1" })).stdout).status;
    expect(finalStatus).toBe("cancelled");
    expect(stopCalls).toEqual([{ threadId: "worker-thread" }]);
  });

  it("attractor_inspect and every CLI runId subcommand are scoped to the owning thread", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const { runId } = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: INLINE_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    await waitForTerminalStatus(host, runId);

    await expect(
      host.harness.behavior.callAgentTool("attractor_inspect", { runId }, { threadId: "another-thread", projectId: "project-1" }),
    ).rejects.toThrow(/no such run/);

    const foreignStatus = await host.harness.behavior.runCli(["status", runId], { threadId: "another-thread" });
    expect(JSON.parse(foreignStatus.stdout)).toBeNull();

    const foreignStages = await host.harness.behavior.runCli(["stages", runId], { threadId: "another-thread" });
    expect(JSON.parse(foreignStages.stdout)).toEqual([]);

    const foreignEvents = await host.harness.behavior.runCli(["events", runId], { threadId: "another-thread" });
    expect(JSON.parse(foreignEvents.stdout)).toEqual([]);

    const foreignStop = await host.harness.behavior.runCli(["stop", runId], { threadId: "another-thread" });
    expect(foreignStop.exitCode).toBe(1);

    // The owning thread can still do all of the above.
    const ownStatus = await host.harness.behavior.runCli(["status", runId], { threadId: "thread-1" });
    expect(JSON.parse(ownStatus.stdout).id).toBe(runId);
  });

  it("RPC: getRun/listRuns/getGraph/getEvents read back a run, scoped to its owning thread", async () => {
    const host = makeHost();
    await plugin(host.bb);
    const { runId } = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: INLINE_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    await waitForTerminalStatus(host, runId);

    const got = (await host.harness.behavior.callRpc("getRun", { runId, threadId: "thread-1" })) as { run: { id: string } | null };
    expect(got.run?.id).toBe(runId);

    const listed = (await host.harness.behavior.callRpc("listRuns", { threadId: "thread-1" })) as { runs: Array<{ id: string }> };
    expect(listed.runs.map((r) => r.id)).toContain(runId);

    const graph = (await host.harness.behavior.callRpc("getGraph", { runId, threadId: "thread-1" })) as { nodes: Array<{ id: string; status: string | null }> };
    expect(graph.nodes.find((n) => n.id === "plan")?.status).toBe("succeeded");

    const events = (await host.harness.behavior.callRpc("getEvents", { runId, threadId: "thread-1" })) as { events: Array<{ type: string }> };
    expect(events.events.some((e) => e.type === "run.completed")).toBe(true);

    // A different thread can't read this run's details.
    const stolen = (await host.harness.behavior.callRpc("getRun", { runId, threadId: "another-thread" })) as { run: null };
    expect(stolen.run).toBeNull();
    const stolenGraph = await host.harness.behavior.callRpc("getGraph", { runId, threadId: "another-thread" });
    expect(stolenGraph).toBeNull();
  });

  it("RPC: stopRun aborts a running run, scoped to its owning thread (the Panel's Stop button, T5)", async () => {
    const host = makeHost();
    // Never auto-completes: only stopRun below should ever settle it.
    host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-thread" }));
    host.harness.sdk.stub("threads.stop", async () => ({ ok: true }));
    await plugin(host.bb);

    const { runId } = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: INLINE_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.spawn").length).toBeGreaterThan(0));

    // A different thread can't stop this run.
    const foreignStop = (await host.harness.behavior.callRpc("stopRun", { runId, threadId: "another-thread" })) as { stopped: boolean };
    expect(foreignStop.stopped).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await host.harness.behavior.callRpc("getRun", { runId, threadId: "thread-1" }) as { run: { status: string } }).run.status).toBe("running");

    const stopped = (await host.harness.behavior.callRpc("stopRun", { runId, threadId: "thread-1" })) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    await vi.waitFor(async () => {
      const got = (await host.harness.behavior.callRpc("getRun", { runId, threadId: "thread-1" })) as { run: { status: string } };
      expect(got.run.status).toBe("cancelled");
    }, { timeout: 2000 });
  });

  it("resumes a run stuck at 'running' from its last checkpoint when the background service starts after a reload", async () => {
    const host = makeHost();
    // Never completes the first worker thread it spawns — the run gets stuck
    // "running" at the "plan" stage, exactly like an unclean plugin restart.
    host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-thread" }));
    await plugin(host.bb);
    const { runId } = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: INLINE_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.spawn").length).toBeGreaterThan(0));
    const beforeStages = JSON.parse((await host.harness.behavior.runCli(["stages", runId], { threadId: "thread-1" })).stdout);
    expect(beforeStages.map((s: { nodeId: string }) => s.nodeId)).toEqual(["start", "plan"]);

    // Simulate a plugin restart against the same persisted storage, then let
    // the new instance's spawn actually complete this time.
    let resumedSpawnCount = 0;
    const reloaded = await host.harness.lifecycle.reload(async (bb) => {
      const { default: freshPlugin } = await import("../../server");
      await freshPlugin(bb);
    });
    hosts.push(reloaded);
    applyBaseSdkStubs(reloaded);
    reloaded.harness.sdk.stub("threads.spawn", async () => {
      resumedSpawnCount += 1;
      setTimeout(() => {
        void reloaded.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker-thread" }), lastAssistantText: "done" });
      }, 0);
      return makeThreadResponse({ id: "worker-thread" });
    });

    const service = reloaded.harness.behavior.runService("attractor-runs");
    await service.done;
    await vi.waitFor(async () => {
      const status = JSON.parse((await reloaded.harness.behavior.runCli(["status", runId], { threadId: "thread-1" })).stdout).status;
      expect(status).toBe("succeeded");
    });
    expect(resumedSpawnCount).toBe(1);
    // The resumed run continues from the checkpointed "plan" node — it never
    // re-executes "start".
    const stages = JSON.parse((await reloaded.harness.behavior.runCli(["stages", runId], { threadId: "thread-1" })).stdout);
    expect(stages.filter((s: { nodeId: string }) => s.nodeId === "start")).toHaveLength(1);
  });

  const HUMAN_GATE_SOURCE = `digraph G {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    revise [label="Revise", prompt="Revise the plan."]
    gate  [shape=hexagon, label="Approve plan?"]
    start -> gate
    gate -> exit   [label="[A] Approve"]
    gate -> revise [label="R) Revise"]
    revise -> exit
  }`;

  it("bb attractor answer resolves a run's blocked human gate end to end, routing by the chosen label", async () => {
    const host = makeHost();
    bridgeHumanGateInteractions(host);
    await plugin(host.bb);

    const { runId } = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: HUMAN_GATE_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    await vi.waitFor(async () => {
      const status = JSON.parse((await host.harness.behavior.runCli(["status", runId], { threadId: "thread-1" })).stdout).status;
      expect(status).toBe("blocked");
    });

    const answered = await host.harness.behavior.runCli(["answer", runId, "approve"], { threadId: "thread-1" });
    expect(answered.exitCode).toBe(0);
    expect(JSON.parse(answered.stdout)).toEqual({ answered: true });

    await waitForTerminalStatus(host, runId);
    const finalStatus = JSON.parse((await host.harness.behavior.runCli(["status", runId], { threadId: "thread-1" })).stdout).status;
    expect(finalStatus).toBe("succeeded");
    const stages = JSON.parse((await host.harness.behavior.runCli(["stages", runId], { threadId: "thread-1" })).stdout);
    expect(stages.map((s: { nodeId: string }) => s.nodeId)).toEqual(["start", "gate", "exit"]);
  });

  it("bb attractor answer is scoped to the owning thread and rejects an unrecognized label", async () => {
    const host = makeHost();
    bridgeHumanGateInteractions(host);
    await plugin(host.bb);

    const { runId } = toolJson(await host.harness.behavior.callAgentTool("attractor_run", { source: HUMAN_GATE_SOURCE }, { threadId: "thread-1", projectId: "project-1" }));
    await vi.waitFor(async () => {
      const status = JSON.parse((await host.harness.behavior.runCli(["status", runId], { threadId: "thread-1" })).stdout).status;
      expect(status).toBe("blocked");
    });

    const foreignAnswer = await host.harness.behavior.runCli(["answer", runId, "approve"], { threadId: "another-thread" });
    expect(foreignAnswer.exitCode).toBe(1);

    const badAnswer = await host.harness.behavior.runCli(["answer", runId, "yolo"], { threadId: "thread-1" });
    expect(JSON.parse(badAnswer.stdout)).toMatchObject({ answered: false });

    // Still blocked — neither the foreign nor the unrecognized answer unwedged it.
    const status = JSON.parse((await host.harness.behavior.runCli(["status", runId], { threadId: "thread-1" })).stdout).status;
    expect(status).toBe("blocked");

    // Clean up so the pending bb.ui.requestInput doesn't outlive the test.
    const answered = await host.harness.behavior.runCli(["answer", runId, "approve"], { threadId: "thread-1" });
    expect(JSON.parse(answered.stdout)).toEqual({ answered: true });
    await waitForTerminalStatus(host, runId);
  });
});
