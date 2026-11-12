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

type Verdict = { side: "candidate" | "best"; barMet?: boolean } | "forget";

function recordVerdict(verdict: Exclude<Verdict, "forget">) {
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
    const graph = parseWorkflowGraph(read(".gauntlet/gauntlet-loop.dot"));

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
          case "build":
            builds.shift()!();
            return { status: "succeeded", text: "candidate ready" };
          case "critic": {
            const verdict = verdicts.shift()!;
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
          ask: async (input) => ({ kind: "choice", option: input.options.find((option) => option.text === "Approve")! }),
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

    expect(result.status).toBe("succeeded");
    expect(result.goalGateFailures).toEqual([]);
    const round = ["brief", "build", "snapshot", "critic", "ratchet", "count"];
    expect(
      events.filter((event): event is Extract<RunEvent, { type: "stage.started" }> => event.type === "stage.started").map((event) => event.nodeId),
    ).toEqual([
      "start", "plan", "approve", "init",
      ...round, ...round, ...round, // greeting: win, loss, loss
      "brief", "build", "snapshot", "critic", "ratchet", "critic", "ratchet", "count", // farewell: forgotten verdict, then win
      "smooth", "finish", "review", "exit",
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
});
