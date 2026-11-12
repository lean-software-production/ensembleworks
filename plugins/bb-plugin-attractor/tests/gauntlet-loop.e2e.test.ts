/**
 * skills/gauntlet/gauntlet-loop.dot through the *real* engine and handler
 * adapters, with the graph's command nodes running the *real*
 * gauntlet-loop.mjs helper against a throwaway git repository. Only the
 * agents are scripted: a "builder" that edits a file, a "critic" that
 * records a verdict through the same CLI a real critic thread is told to
 * use, and a human who approves the plan. Proves the graph's routing and
 * the helper's bookkeeping agree with each other end to end.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWorkflowGraph } from "../dot/graph";
import { validate } from "../dot/validate";
import { runEngine } from "../engine/engine";
import type { HandlerRegistry, Outcome, RunEvent } from "../engine/types";
import { createAgentHandler } from "../handlers/agent";
import { createCommandHandler } from "../handlers/command";
import { conditionalHandler } from "../handlers/conditional";
import { createHumanHandler } from "../handlers/human";
import { forkHandler, joinHandler } from "../handlers/parallel";
import { createPromptHandler } from "../handlers/prompt";
import { exitHandler, startHandler } from "../handlers/start-exit";
import type { AgentBackend, AgentRunInput } from "../server/backend";

const SKILL_DIR = fileURLToPath(new URL("../skills/gauntlet/", import.meta.url));
const RUN_CONTEXT = { threadId: "origin-thread", projectId: "proj", environmentId: "env" };

let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
const read = (path: string) => readFileSync(join(repo, path), "utf8");
const secretState = () => JSON.parse(read(".git/gauntlet/state.json"));

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gauntlet-e2e-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  write("greet.txt", "hi\n");
  write("bye.txt", "bye\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  expect(spawnSync(process.execPath, [join(SKILL_DIR, "gauntlet-loop.mjs"), "setup"], { cwd: repo }).status).toBe(0);
  write(".gauntlet/goal.md", "Warm greetings and farewells.\n");
  write(".gauntlet/bar.md", "As warm as a handwritten card.\n");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const stagesStarted = (events: RunEvent[]) =>
  events.filter((event): event is Extract<RunEvent, { type: "stage.started" }> => event.type === "stage.started").map((event) => event.nodeId);

type Verdict = { side: "candidate" | "best"; barMet?: boolean } | "forget" | "fail";

function recordVerdict(verdict: Exclude<Verdict, "forget" | "fail">) {
  const { mapping } = secretState().round;
  const winner = mapping.A === verdict.side ? "A" : "B";
  const result = spawnSync(
    join(repo, ".gauntlet", "g"),
    ["verdict", "--winner", winner, "--evidence", "ok", "--bar-met", verdict.barMet ? "yes" : "no", "--gap", "could be warmer"],
    { cwd: repo, encoding: "utf8" },
  );
  expect(result.status).toBe(0);
}

describe("e2e: skills/gauntlet/gauntlet-loop.dot", () => {
  it("validates with no diagnostics and gives both judging stages a history-free prompt", () => {
    const graph = parseWorkflowGraph(readFileSync(join(SKILL_DIR, "gauntlet-loop.dot"), "utf8"));
    expect(validate(graph)).toEqual([]);
    expect(graph.nodes.get("critic")?.fidelity).toBe("truncate");
    expect(graph.nodes.get("review")?.fidelity).toBe("truncate");
    expect(graph.nodes.get("build")?.fidelity).toBeUndefined();
  });

  it("ratchets two pieces through wins, losses, a plateau and a forgotten verdict, then smooths and reviews", async () => {
    // What each builder visit writes, and how each critic visit rules.
    const builds: Array<() => void> = [
      () => write("greet.txt", "Hello, dear friend!\n"), //   greeting r1 — wins
      () => write("greet.txt", "HELLO.\n"), //                 greeting r2 — loses
      () => write("greet.txt", "sup\n"), //                    greeting r3 — loses -> plateau
      () => write("bye.txt", "Farewell, safe travels!\n"), //  farewell r1 — wins, bar met
    ];
    const verdicts: Verdict[] = [
      { side: "candidate" },
      { side: "best" },
      { side: "best" },
      "forget", // the critic replies without recording anything: ratchet fails, a fresh critic is asked
      { side: "candidate", barMet: true },
    ];

    const { result, events } = await drive({ builds, verdicts, human: ["Approve"] });

    expect(result.status).toBe("succeeded");
    expect(result.goalGateFailures).toEqual([]);
    const round = ["next", "brief", "build", "snapshot", "critic", "ratchet"];
    expect(stagesStarted(events)).toEqual([
      "start", "next", "plan", "approve", "init",
      ...round, ...round, ...round, // greeting: win, loss, loss
      "next", "brief", "build", "snapshot", "critic", "ratchet", "critic", "ratchet", // farewell: forgotten verdict, then win
      "next", "smooth", "finish", "next", "review", "next", "exit",
    ]);
    expect(builds).toEqual([]);
    expect(verdicts).toEqual([]);

    // The kept result: greeting's round-1 winner (later losers reset away), farewell's winner, then the smoothing pass.
    expect(read("greet.txt")).toBe("Hello, dear friend.\n");
    expect(read("bye.txt")).toBe("Farewell, safe travels!\n");
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "--format=%s").split("\n")).toEqual([
      "gauntlet: smoothing pass",
      "gauntlet(farewell): round 1 candidate",
      "gauntlet(greeting): round 1 candidate",
      "base",
    ]);
    const progress = read(".gauntlet/progress.md");
    expect(progress).toContain("| greeting — Greeting | plateaued | 3 | 1 | 0 |");
    expect(progress).toContain("| farewell — Farewell | passed | 1 | 1 | 0 |");
    expect(progress).toContain("smoothing pass kept. Final check passed.");
  });

  it("never judges a stage whose agent failed: it stops at the gate, and Resume carries on with nothing lost", async () => {
    // The usage-limit failure mode: builders and a critic die without doing
    // any work. None of that may be recorded as a round.
    const builds: Array<(() => void) | "fail"> = [
      "fail", //                                               greeting r1 — the builder's worker dies
      () => write("greet.txt", "Hello, dear friend!\n"), //   greeting r1 again — wins, bar met
      () => write("bye.txt", "Farewell, safe travels!\n"), //  farewell r1 — wins, bar met
    ];
    const verdicts: Verdict[] = [
      { side: "candidate", barMet: true },
      "fail", // farewell's critic dies with the round waiting for a verdict
      { side: "candidate", barMet: true },
    ];

    const { result, events } = await drive({ builds, verdicts, human: ["Approve", "Resume", "Resume"] });

    expect(result.status).toBe("succeeded");
    expect(stagesStarted(events)).toEqual([
      "start", "next", "plan", "approve", "init",
      "next", "brief", "build", "stalled", //                          builder failed -> gate, not snapshot
      "next", "brief", "build", "snapshot", "critic", "ratchet", //    resumed: the same round, judged properly
      "next", "brief", "build", "snapshot", "critic", "stalled", //    critic failed -> gate, not ratchet
      "next", "snapshot", "critic", "ratchet", //                      resumed: straight back to judging the waiting candidate
      "next", "smooth", "finish", "next", "review", "next", "exit",
    ]);
    const progress = read(".gauntlet/progress.md");
    expect(progress).toContain("| greeting — Greeting | passed | 1 | 1 | 0 |");
    expect(progress).toContain("| farewell — Farewell | passed | 1 | 1 | 0 |");
    expect(read("bye.txt")).toBe("Farewell, safe travels!\n");
  });

  it("carries on from recorded state when the graph is simply run again", async () => {
    // First run: one piece finishes, then a builder fails and the human stops the run.
    const first = await drive({
      builds: [() => write("greet.txt", "Hello, dear friend!\n"), "fail"],
      verdicts: [{ side: "candidate", barMet: true }],
      human: ["Approve", "Stop"],
    });
    expect(stagesStarted(first.events).slice(-3)).toEqual(["build", "stalled", "exit"]);
    expect(read(".gauntlet/progress.md")).toContain("| farewell — Farewell | active | 0 | 0 | 0 |");

    // Second run of the same graph: no plan, no gate, no init — straight to the unfinished piece.
    const second = await drive({
      builds: [() => write("bye.txt", "Farewell, safe travels!\n")],
      verdicts: [{ side: "candidate", barMet: true }],
      human: [],
    });
    expect(second.result.status).toBe("succeeded");
    expect(stagesStarted(second.events)).toEqual([
      "start",
      "next", "brief", "build", "snapshot", "critic", "ratchet",
      "next", "smooth", "finish", "next", "review", "next", "exit",
    ]);
    const progress = read(".gauntlet/progress.md");
    expect(progress).toContain("| greeting — Greeting | passed | 1 | 1 | 0 |");
    expect(progress).toContain("| farewell — Farewell | passed | 1 | 1 | 0 |");
  });
});

interface Script {
  /** One entry per `build` visit: what the builder writes, or "fail" for a worker that dies without doing anything. */
  builds: Array<(() => void) | "fail">;
  /** One entry per `critic` visit. */
  verdicts: Verdict[];
  /** The option each human gate is answered with, in order. */
  human: string[];
}

/** Runs the installed graph through the real engine and handler adapters; only the agents and the human are scripted. */
async function drive(script: Script) {
  const graph = parseWorkflowGraph(read(".gauntlet/gauntlet-loop.dot"));
  const failed = (what: string): Outcome => ({ status: "failed", failureReason: `${what}: worker thread failed` });

  const backend: AgentBackend = {
    run: async (input: AgentRunInput): Promise<Outcome> => {
      switch (input.node.id) {
        case "plan":
          write(
            ".gauntlet/pieces.json",
            JSON.stringify({
              check: "test -s greet.txt && test -s bye.txt",
              pieces: [
                { id: "greeting", title: "Greeting", brief: "Improve greet.txt", bar: "Warm", evidence: "cat greet.txt" },
                { id: "farewell", title: "Farewell", brief: "Improve bye.txt", bar: "Warm", evidence: "cat bye.txt" },
              ],
            }),
          );
          write(".gauntlet/plan.md", "# Plan\n");
          return { status: "succeeded", text: "2 pieces" };
        case "build": {
          const build = script.builds.shift()!;
          if (build === "fail") return failed("build");
          build();
          return { status: "succeeded", text: "candidate ready" };
        }
        case "critic": {
          const verdict = script.verdicts.shift()!;
          if (verdict === "fail") return failed("critic");
          if (verdict !== "forget") recordVerdict(verdict);
          return { status: "succeeded", text: "done" };
        }
        case "smooth":
          write("greet.txt", "Hello, dear friend.\n");
          return { status: "succeeded", text: "aligned punctuation" };
        case "review":
          write(".gauntlet/final-review.md", "Nearly.\n");
          return { status: "succeeded", text: "Nearly." };
        default:
          throw new Error(`unscripted agent node ${input.node.id}`);
      }
    },
    reportResult: () => {},
    isAwaitingResult: () => false,
    isWorkerThread: () => false,
  };

  const handlers: HandlerRegistry = {
    start: startHandler,
    exit: exitHandler,
    agent: createAgentHandler(backend, RUN_CONTEXT),
    prompt: createPromptHandler(backend, RUN_CONTEXT),
    command: createCommandHandler({
      // The real thing: run the node's script with /bin/sh in the repo, as host.ts does.
      exec: async (input) => {
        const result = spawnSync("/bin/sh", ["-c", input.script], { cwd: repo, encoding: "utf8" });
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, timedOut: false };
      },
    }),
    human: createHumanHandler(
      {
        ask: async (input) => {
          const answer = script.human.shift();
          const option = input.options.find((candidate) => candidate.text === answer);
          if (!option) throw new Error(`no gate option "${answer}" among ${input.options.map((candidate) => candidate.text).join(", ")}`);
          return { kind: "choice", option };
        },
      },
      { threadId: RUN_CONTEXT.threadId },
    ),
    conditional: conditionalHandler,
    parallel: forkHandler,
    "parallel.fan_in": joinHandler,
  };

  const events: RunEvent[] = [];
  let now = 0;
  const result = await runEngine({
    graph,
    handlers,
    runId: "run-gauntlet",
    clock: { now: () => now, sleep: async (ms: number) => { now += ms; } },
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  return { result, events };
}
