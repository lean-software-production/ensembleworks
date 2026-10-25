/**
 * T7 end-to-end: runs each `examples/*.dot` graph through the *real* engine
 * (dot/graph.ts + dot/validate.ts + engine/engine.ts) wired to the *real*
 * handler adapters (handlers/agent.ts, handlers/command.ts,
 * handlers/conditional.ts, handlers/parallel.ts, handlers/start-exit.ts,
 * handlers/human.ts) — only the BB-facing dependencies each adapter is
 * injected with (an AgentBackend, a command exec function, a
 * HumanInterviewer) are scripted fakes, per
 * docs/plans/2026-09-13-attractor-runner-plan.md T7: "an end-to-end test
 * that runs each example through the real engine with a scripted fake
 * backend and asserts the visited path". Unlike tests/engine.test.ts (which
 * uses trivial always-succeed fake Handlers directly), this proves the real
 * handler-adapter wiring — the same wiring server/service.ts assembles for
 * a live run — actually drives each example graph to completion.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflowGraph } from "../dot/graph";
import { validate } from "../dot/validate";
import { runEngine } from "../engine/engine";
import type { HandlerRegistry, Outcome, RunEvent } from "../engine/types";
import { createAgentHandler } from "../handlers/agent";
import { createPromptHandler } from "../handlers/prompt";
import { createCommandHandler } from "../handlers/command";
import type { CommandExecInput, CommandExecResult, CommandHandlerDeps } from "../handlers/command";
import { conditionalHandler } from "../handlers/conditional";
import { forkHandler, joinHandler } from "../handlers/parallel";
import { startHandler, exitHandler } from "../handlers/start-exit";
import { createHumanHandler } from "../handlers/human";
import type { HumanAskInput, HumanAskResult, HumanInterviewer } from "../handlers/human";
import type { AgentBackend, AgentRunInput } from "../server/backend";

const EXAMPLES_DIR = path.join(__dirname, "..", "examples");
const NEVER_ABORT = new AbortController().signal;

function readExample(name: string): string {
  return readFileSync(path.join(EXAMPLES_DIR, name), "utf8");
}

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

function collector(): { events: RunEvent[]; onEvent(e: RunEvent): void } {
  const events: RunEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

/** Main-walk stage.started node ids, in order (excludes parallel-branch stages, which carry parallelGroupId). */
function mainWalkNodeIds(events: RunEvent[]): string[] {
  return events
    .filter((e): e is Extract<RunEvent, { type: "stage.started" }> => e.type === "stage.started" && e.parallelGroupId === undefined)
    .map((e) => e.nodeId);
}

/** Parallel-branch stage.started node ids (any order — branches may interleave). */
function branchNodeIds(events: RunEvent[]): Set<string> {
  return new Set(
    events
      .filter((e): e is Extract<RunEvent, { type: "stage.started" }> => e.type === "stage.started" && e.parallelGroupId !== undefined)
      .map((e) => e.nodeId),
  );
}

/** An AgentBackend whose run() returns a fixed, scripted Outcome per node id (no real BB thread involved). */
function scriptedAgentBackend(byNodeId: Record<string, Outcome>): AgentBackend {
  return {
    run: async (input: AgentRunInput) => byNodeId[input.node.id] ?? { status: "succeeded", text: `${input.node.id} ok` },
    reportResult: () => {},
    isAwaitingResult: () => false,
    isWorkerThread: () => false,
  };
}

/** A CommandHandlerDeps whose exec() calls a per-script-text scripted responder, so a looped command node (e.g. BranchLoop's `build`) can fail then succeed across visits. */
function scriptedExec(bySource: Record<string, () => CommandExecResult>): CommandHandlerDeps {
  return {
    exec: async (input: CommandExecInput) => {
      const respond = bySource[input.script];
      if (!respond) throw new Error(`e2e test: unscripted command script "${input.script}"`);
      return respond();
    },
  };
}

/** A HumanInterviewer that always picks the option whose accelerator-stripped text matches. */
function scriptedInterviewer(chooseText: string): HumanInterviewer {
  return {
    ask: async (input: HumanAskInput): Promise<HumanAskResult> => {
      const option = input.options.find((o) => o.text === chooseText);
      if (!option) throw new Error(`e2e test: no human gate option named "${chooseText}"`);
      return { kind: "choice", option };
    },
  };
}

const NEVER_CALLED_HUMAN: HumanInterviewer = {
  ask: async () => {
    throw new Error("e2e test: human interviewer should not be called by this example");
  },
};

function commandOk(stdout = "ok"): CommandExecResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

function commandFail(exitCode: number, stderr: string): CommandExecResult {
  return { exitCode, stdout: "", stderr, timedOut: false };
}

const RUN_CONTEXT = { threadId: "origin-thread", projectId: "proj", environmentId: "env" };

function buildHandlers(deps: {
  backend: AgentBackend;
  command: CommandHandlerDeps;
  interviewer: HumanInterviewer;
}): HandlerRegistry {
  return {
    start: startHandler,
    exit: exitHandler,
    agent: createAgentHandler(deps.backend, RUN_CONTEXT),
    prompt: createPromptHandler(deps.backend, RUN_CONTEXT),
    command: createCommandHandler(deps.command),
    human: createHumanHandler(deps.interviewer, { threadId: RUN_CONTEXT.threadId }),
    conditional: conditionalHandler,
    parallel: forkHandler,
    "parallel.fan_in": joinHandler,
  };
}

describe("e2e: examples/plan-implement-review.dot", () => {
  it("runs plan -> approve -> implement -> test -> review -> exit and succeeds", async () => {
    const source = readExample("plan-implement-review.dot");
    const graph = parseWorkflowGraph(source);
    expect(validate(graph).filter((d) => d.severity === "error")).toEqual([]);

    const handlers = buildHandlers({
      backend: scriptedAgentBackend({
        plan: { status: "succeeded", text: "wrote PLAN.md" },
        implement: { status: "succeeded", text: "implemented the change" },
        review: { status: "succeeded", preferredLabel: "Accept", text: "looks good" },
      }),
      command: scriptedExec({ "npm test": () => commandOk("5 passed") }),
      interviewer: scriptedInterviewer("Approve"),
    });

    const { events, onEvent } = collector();
    const result = await runEngine({
      graph,
      handlers,
      runId: "run-plan-implement-review",
      clock: fakeClock(),
      signal: NEVER_ABORT,
      onEvent,
    });

    expect(result.status).toBe("succeeded");
    expect(result.goalGateFailures).toEqual([]);
    expect(mainWalkNodeIds(events)).toEqual(["start", "plan", "approve", "implement", "test", "review", "exit"]);
  });

  it("loops back through plan on a Revise answer, then succeeds on Approve", async () => {
    const graph = parseWorkflowGraph(readExample("plan-implement-review.dot"));

    let approveAsked = 0;
    const interviewer: HumanInterviewer = {
      ask: async (input) => {
        approveAsked += 1;
        const wantText = approveAsked === 1 ? "Revise" : "Approve";
        const option = input.options.find((o) => o.text === wantText);
        if (!option) throw new Error(`missing option ${wantText}`);
        return { kind: "choice", option };
      },
    };

    const handlers = buildHandlers({
      backend: scriptedAgentBackend({
        plan: { status: "succeeded", text: "wrote PLAN.md" },
        implement: { status: "succeeded", text: "implemented the change" },
        review: { status: "succeeded", preferredLabel: "Accept", text: "looks good" },
      }),
      command: scriptedExec({ "npm test": () => commandOk() }),
      interviewer,
    });

    const { events, onEvent } = collector();
    const result = await runEngine({
      graph,
      handlers,
      runId: "run-plan-implement-review-revise",
      clock: fakeClock(),
      signal: NEVER_ABORT,
      onEvent,
    });

    expect(result.status).toBe("succeeded");
    expect(mainWalkNodeIds(events)).toEqual([
      "start",
      "plan",
      "approve",
      "plan",
      "approve",
      "implement",
      "test",
      "review",
      "exit",
    ]);
  });
});

describe("e2e: examples/parallel-review.dot", () => {
  it("fans out to all three lenses, merges, summarises, and succeeds", async () => {
    const graph = parseWorkflowGraph(readExample("parallel-review.dot"));
    expect(validate(graph).filter((d) => d.severity === "error")).toEqual([]);

    const handlers = buildHandlers({
      backend: scriptedAgentBackend({
        security: { status: "succeeded", text: "no security findings" },
        architecture: { status: "succeeded", text: "no architecture findings" },
        quality: { status: "succeeded", text: "no quality findings" },
        summarise: { status: "succeeded", text: "combined report" },
      }),
      command: scriptedExec({}),
      interviewer: NEVER_CALLED_HUMAN,
    });

    const { events, onEvent } = collector();
    const result = await runEngine({
      graph,
      handlers,
      runId: "run-parallel-review",
      clock: fakeClock(),
      signal: NEVER_ABORT,
      onEvent,
    });

    expect(result.status).toBe("succeeded");
    expect(mainWalkNodeIds(events)).toEqual(["start", "fork", "merge", "summarise", "exit"]);
    expect(branchNodeIds(events)).toEqual(new Set(["security", "architecture", "quality"]));

    const parallel = result.context.parallel as { results: unknown[]; branch_count: number };
    expect(Array.isArray(parallel.results)).toBe(true);
    expect(parallel.results.length).toBe(3);
    expect(parallel.branch_count).toBe(3);
  });
});

describe("e2e: examples/branch-loop.dot", () => {
  it("loops build -> check -> fix until the build is green, then exits", async () => {
    const graph = parseWorkflowGraph(readExample("branch-loop.dot"));
    expect(validate(graph).filter((d) => d.severity === "error")).toEqual([]);

    let buildAttempts = 0;
    const handlers = buildHandlers({
      backend: scriptedAgentBackend({ fix: { status: "succeeded", text: "fixed the build" } }),
      command: scriptedExec({
        "npm run build": () => {
          buildAttempts += 1;
          return buildAttempts === 1 ? commandFail(1, "syntax error") : commandOk("build succeeded");
        },
      }),
      interviewer: NEVER_CALLED_HUMAN,
    });

    const { events, onEvent } = collector();
    const result = await runEngine({
      graph,
      handlers,
      runId: "run-branch-loop",
      clock: fakeClock(),
      signal: NEVER_ABORT,
      onEvent,
    });

    expect(result.status).toBe("succeeded");
    expect(result.goalGateFailures).toEqual([]);
    expect(mainWalkNodeIds(events)).toEqual(["start", "build", "check", "fix", "build", "check", "exit"]);
    expect(buildAttempts).toBe(2);
  });

  it("fails the run's goal gate when the build never turns green within max_node_visits", async () => {
    const graph = parseWorkflowGraph(readExample("branch-loop.dot"));

    const handlers = buildHandlers({
      backend: scriptedAgentBackend({ fix: { status: "succeeded", text: "attempted a fix" } }),
      command: scriptedExec({ "npm run build": () => commandFail(1, "still broken") }),
      interviewer: NEVER_CALLED_HUMAN,
    });

    const { events, onEvent } = collector();
    const result = await runEngine({
      graph,
      handlers,
      runId: "run-branch-loop-never-green",
      clock: fakeClock(),
      signal: NEVER_ABORT,
      onEvent,
    });

    expect(result.status).toBe("failed");
    expect(result.goalGateFailures).toContain("build");
    // max_node_visits=4 bounds the loop: it does not run forever.
    expect(mainWalkNodeIds(events).filter((id) => id === "build").length).toBeLessThanOrEqual(4);
  });
});
