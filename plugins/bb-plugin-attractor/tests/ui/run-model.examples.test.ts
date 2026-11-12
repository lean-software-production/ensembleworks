/**
 * The run UI's read model checked against every shipped graph — each of
 * `examples/*.dot` and `skills/gauntlet/gauntlet-loop.dot` — not only the
 * Gauntlet Loop. Each graph runs through the real service (real engine, real
 * handler adapters, real RunStore, so stage rows carry exactly what the panel
 * will see) with scripted workers, commands and gate answers; the model is
 * then derived from `getRun`/`getGraph`/`getEvents` the way the UI does.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createService } from "../../server/service";
import { RunStore } from "../../server/store";
import type { AgentBackend } from "../../server/backend";
import type { HumanAskInput, HumanAskResult, HumanInterviewer } from "../../handlers/human";
import type { GraphView, RunView, StageView } from "../../server/contracts";
import { layoutGraph } from "../../ui/dag";
import { deriveAttention, gateChoices, graphHasLoop, groupPasses, isStructural, progressOf, routesFrom, storyItems, type EventView } from "../../ui/run-model";

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function makeHost() {
  const host = createFakePluginHost({
    sdk: {
      threads: { get: async () => makeThreadResponse({ id: "origin-thread" }) },
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

let threadCounter = 0;
/** Every agent succeeds (asking for "Accept" where a review offers it) and reports a worker thread. */
const backend: AgentBackend = {
  run: async (input) => {
    threadCounter += 1;
    input.emit({ type: "agent.thread", threadId: `thr-${input.node.id}-${threadCounter}`, provider: "claude-code", model: "sonnet", reasoningLevel: null });
    return { status: "succeeded", text: `${input.node.id} done`, preferredLabel: "Accept" };
  },
  reportResult: () => {},
  isAwaitingResult: () => false,
  isWorkerThread: () => false,
};

/** Commands answer by script, cycling through scripted outputs so loops actually loop. */
function scriptedExec(script: Record<string, { exitCode: number; stdout: string }[]>) {
  const calls = new Map<string, number>();
  return {
    call: vi.fn(async (_method: "exec", input: { script: string }) => {
      const key = Object.keys(script).find((k) => input.script.includes(k));
      const answers = key ? script[key]! : [{ exitCode: 0, stdout: "ok\n" }];
      const n = calls.get(key ?? "") ?? 0;
      calls.set(key ?? "", n + 1);
      const answer = answers[Math.min(n, answers.length - 1)]!;
      return { ...answer, stderr: "", timedOut: false };
    }),
  };
}

/** Always picks the gate's first option. */
const approveAll: HumanInterviewer = {
  ask: async (input: HumanAskInput): Promise<HumanAskResult> => ({ kind: "choice", option: input.options[0]! }),
};

interface Case {
  file: string;
  loops: boolean;
  exec: Record<string, { exitCode: number; stdout: string }[]>;
  /** At least this many passes once the scripted run is done. */
  minPasses: number;
}

const CASES: Case[] = [
  { file: "examples/plan-implement-review.dot", loops: true, exec: { "npm test": [{ exitCode: 1, stdout: "1 failing\n" }, { exitCode: 0, stdout: "all green\n" }] }, minPasses: 2 },
  { file: "examples/parallel-review.dot", loops: false, exec: {}, minPasses: 1 },
  { file: "examples/branch-loop.dot", loops: true, exec: { "npm run build": [{ exitCode: 1, stdout: "broken\n" }, { exitCode: 0, stdout: "built\n" }] }, minPasses: 2 },
  { file: "examples/dependency-updates.dot", loops: true, exec: { "queue.mjs count": [{ exitCode: 0, stdout: "MORE\n" }, { exitCode: 0, stdout: "DONE\n" }] }, minPasses: 2 },
  { file: "examples/upgrade-vite-8.dot", loops: true, exec: {}, minPasses: 1 },
  {
    file: "skills/gauntlet/gauntlet-loop.dot",
    loops: true,
    exec: { ".gauntlet/g next": [{ exitCode: 0, stdout: "GO_PLAN\n" }, { exitCode: 0, stdout: "GO_BUILD\n" }, { exitCode: 0, stdout: "GO_BUILD\n" }, { exitCode: 0, stdout: "GO_END\n" }] },
    minPasses: 3,
  },
];

async function runToEnd(c: Case) {
  const host = makeHost();
  const store = new RunStore(new Database(":memory:"));
  const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: scriptedExec(c.exec), humanInterviewer: approveAll });
  const { run } = await service.createAndStartRun({ source: read(c.file), threadId: "origin-thread", projectId: "project-1", environmentId: "env-1" });
  await vi.waitFor(() => expect(["succeeded", "failed"]).toContain(store.getRun(run.id).status), { timeout: 5000 });
  const { run: finished, stages } = service.getRun(run.id);
  return { run: finished as unknown as RunView, stages: stages as StageView[], graph: service.getGraph(run.id) as GraphView, events: service.getEvents(run.id) as EventView[] };
}

describe.each(CASES)("run UI model against $file", (c) => {
  it("lays out, routes and words progress sensibly for this graph", async () => {
    const { run, stages, graph, events } = await runToEnd(c);

    // Graph: the layout engine handles it, and every node's outcomes have a plain-language route line.
    expect(() => layoutGraph(graph)).not.toThrow();
    expect(graphHasLoop(graph)).toBe(c.loops);
    for (const n of graph.nodes) {
      const routes = routesFrom(graph, n.id);
      expect(routes).toHaveLength(graph.edges.filter((e) => e.from === n.id).length);
      for (const r of routes) expect(r.when.length).toBeGreaterThan(0);
      if (n.handlerKind === "human") expect(gateChoices(graph, n.id, new Set()).length).toBeGreaterThan(0);
    }

    // Passes: every stage in exactly one pass, no pass entering a node twice; a graph with no loop is one pass.
    const passes = groupPasses(stages);
    expect(passes.flatMap((p) => p.stages)).toEqual(stages);
    for (const p of passes) {
      const entered = p.stages.filter((s) => s.status !== "skipped").map((s) => s.nodeId);
      expect(new Set(entered).size).toBe(entered.length);
    }
    expect(passes.length).toBeGreaterThanOrEqual(c.minPasses);
    if (!c.loops) expect(passes).toHaveLength(1);

    // Progress wording: "n of N stages" only without a loop.
    const progress = progressOf(run, stages, graph, run.finishedAt ?? 0);
    if (c.loops) expect(progress.text).not.toMatch(/ of \d+ stages/);
    else expect(progress.text).toMatch(/^\d+ of \d+ stages$/);

    // A finished run says so, naming a stage that did work.
    const attention = deriveAttention(run, stages, graph, events);
    expect(attention.kind).toBe(run.status === "succeeded" ? "finished" : "failed");
    if (attention.kind === "finished") {
      const lastNode = graph.nodes.find((n) => n.label === attention.label || n.id === attention.label);
      expect(isStructural(lastNode?.handlerKind)).toBe(false);
    }

    // Story: each stage that did work shows up as a milestone; routing is tagged, never dropped.
    const story = storyItems(events, stages, graph);
    expect(story.filter((i) => i.kind === "routing").length).toBeGreaterThan(0);
    const working = stages.filter((s) => !isStructural(graph.nodes.find((n) => n.id === s.nodeId)?.handlerKind));
    for (const s of working) {
      const label = graph.nodes.find((n) => n.id === s.nodeId)?.label ?? s.nodeId;
      expect(story.some((i) => i.kind === "milestone" && i.subject === label)).toBe(true);
    }
  });
});

describe("fan-out membership on stage rows (server support)", () => {
  it("records each branch's parallel group and branch index on its stage row, and none on the main walk", async () => {
    const { stages } = await runToEnd(CASES[1]!);
    const byNode = new Map(stages.map((s) => [s.nodeId, s]));
    for (const [i, id] of ["security", "architecture", "quality"].entries()) {
      expect(byNode.get(id)).toMatchObject({ parallelGroupId: "fork@1", branchIndex: i });
    }
    expect(byNode.get("fork")).toMatchObject({ parallelGroupId: null, branchIndex: null });
    expect(byNode.get("summarise")).toMatchObject({ parallelGroupId: null, branchIndex: null });
  });
});

describe("a gate mid-run (upgrade-vite-8)", () => {
  it("shows the gate's options with where each leads while the run waits", async () => {
    const host = makeHost();
    const store = new RunStore(new Database(":memory:"));
    const waiting: HumanInterviewer = { ask: () => new Promise(() => {}) };
    const service = createService({ bb: host.bb, store, agentBackend: backend, execClient: scriptedExec({}), humanInterviewer: waiting });
    const { run } = await service.createAndStartRun({ source: read("examples/upgrade-vite-8.dot"), threadId: "origin-thread", projectId: "project-1", environmentId: "env-1" });
    await vi.waitFor(() => expect(store.getRun(run.id).status).toBe("blocked"));
    const { run: blocked, stages } = service.getRun(run.id);
    const attention = deriveAttention(blocked as unknown as RunView, stages as StageView[], service.getGraph(run.id) as GraphView);
    expect(attention.kind).toBe("requests");
    if (attention.kind !== "requests") return;
    const gate = attention.requests[0]!;
    expect(gate).toMatchObject({ kind: "gate", label: "Approve migration plan?", freeform: true });
    if (gate.kind !== "gate") return;
    expect(gate.choices.map((ch) => `${ch.text} → ${ch.back ? "back to " : ""}${ch.toLabel}`)).toEqual(["Approve → Bump versions", "Revise → back to Research"]);
    await service.stopRun(run.id);
  });
});
