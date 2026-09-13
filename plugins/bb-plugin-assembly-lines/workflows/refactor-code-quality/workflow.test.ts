import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeSource } from "./fixture";
import { workflowPackage } from "./fixture";
import { FabroClient } from "../../fabro";
import { homedir } from "node:os";

const order = (baseSha: string, overrides: Record<string, unknown> = {}) => ({
  title: "Tidy parser", objective: "Improve parser clarity", baseSha, scope: ["src/"], constraints: [],
  acceptanceCriteria: ["Tests pass"], validationCommands: ["node -e \"process.exit(0)\""],
  qualityCommand: "node -e \"process.exit(0)\"", setupCommands: [], maxAttempts: 2, maxMinutes: 1,
  maxChangedFiles: 2, ...overrides,
});

// Opt-in integration: real Fabro scheduling and real runtime gates, shell-only
// substitutes for the three LLM stages. No provider calls or model charges.
describe.skipIf(!process.env.FABRO_GRAPH_TEST)("live Fabro graph", () => {
  it.each([
    { name: "first attempt delivers", maxAttempts: 1, failFirst: false, failPlan: false, succeeds: true, attempts: 1 },
    { name: "validation repair delivers", maxAttempts: 2, failFirst: true, failPlan: false, succeeds: true, attempts: 2 },
    { name: "exhaustion stops before another implementation", maxAttempts: 1, failFirst: true, failPlan: false, succeeds: false, attempts: 1 },
    { name: "plan failure stops before implementation", maxAttempts: 1, failFirst: false, failPlan: true, succeeds: false, attempts: 0 },
  ])("$name", async ({ maxAttempts, failFirst, failPlan, succeeds, attempts }) => {
    const fixture = repo({ maxAttempts,
      validationCommands: ["node .fabro-input/check.cjs"],
    });
    writeFileSync(join(fixture.cwd, ".fabro-input/check.cjs"), `const fs=require('node:fs'); if(fs.readFileSync('src/parser.js','utf8').includes('FAIL')) process.exit(1);`);
    writeFileSync(join(fixture.cwd, ".fabro-input/implement.cjs"), `const fs=require('node:fs'); const n=JSON.parse(fs.readFileSync('.fabro-output/execution.json')).attempts; fs.appendFileSync('.fabro-output/implementations.txt', 'run\\n'); fs.writeFileSync('src/parser.js', ((${failFirst} && n===1)?'// FAIL\\n':'// clarified\\n')+'export const parse = (x) => x;\\n');`);
    const pkg = await workflowPackage({ maxAttempts, maxMinutes: 1 });
    pkg.files['workflow.fabro'] = pkg.files['workflow.fabro']
      .replace(/plan \[.*\]/, `plan [shape=parallelogram, goal_gate=true, script="${failPlan ? "exit 7" : "true"}"]`)
      .replace(/implement \[(.*)\]/, (_line, attrs: string) => `implement [shape=parallelogram, goal_gate=true, ${attrs.match(/max_visits=\d+, /)?.[0] ?? ""}script="node .fabro-input/implement.cjs"]`)
      .replace(/review \[(.*)\]/, (_line, attrs: string) => `review [shape=parallelogram, goal_gate=true, ${attrs.match(/max_visits=\d+, /)?.[0] ?? ""}script="echo reviewed > .fabro-output/review.md"]`)
      .replace('condition="preferred_label=Accept"', 'condition="outcome=succeeded"');
    const base = "http://127.0.0.1:3000";
    const auth = JSON.parse(readFileSync(join(homedir(), ".fabro/auth.json"), "utf8"));
    const client = new FabroClient({ baseUrl: base + "/api/v1", token: auth.servers[base].token });
    const version = await client.registerWorkflow(pkg);
    const run = await client.createRun({ workflow_version_id: version, target: { kind: "folder", path: fixture.cwd }, environment_id: "local", title: "Assembly Lines graph regression", args: { auto_approve: true, labels: { bb_test: "assembly-graph" } } });
    console.log("Graph regression run", run.id);
    await client.startRun(run.id);
    const deadline = Date.now() + 60_000;
    let status;
    do {
      status = (await client.inspectRun(run.id)).lifecycle?.status?.kind;
      if (["succeeded", "failed", "dead"].includes(status ?? "")) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    expect(status).toBe(succeeds ? "succeeded" : "failed");
    const log = join(fixture.cwd, ".fabro-output/implementations.txt");
    expect(existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0).toBe(attempts);
    expect(existsSync(join(fixture.cwd, ".fabro-output/delivery.json"))).toBe(succeeds);
    if (!succeeds && !failPlan) expect(readFileSync(join(fixture.cwd, ".fabro-output/failure.json"), "utf8")).toContain("Repair attempt budget exhausted");
  }, 75_000);
});
function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function run(cwd: string, phase: string) {
  try { return { code: 0, output: execFileSync("node", [".fabro-input/runner.mjs", phase], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (error) { const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer }; return { code: e.status ?? 1, output: String(e.stdout ?? "") + String(e.stderr ?? "") }; }
}
function repo(overrides: Record<string, unknown> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "assembly-line-runtime-"));
  git(cwd, "init", "-q"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test");
  mkdirSync(join(cwd, "src")); writeFileSync(join(cwd, "src/parser.js"), "export const parse = (x) => x;\n");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "baseline");
  const baseSha = git(cwd, "rev-parse", "HEAD");
  mkdirSync(join(cwd, ".fabro-input")); mkdirSync(join(cwd, ".fabro-output"));
  writeFileSync(join(cwd, ".fabro-input", "runner.mjs"), runtimeSource);
  writeFileSync(join(cwd, ".fabro-input", "work-order.json"), JSON.stringify(order(baseSha, overrides)));
  return { cwd, baseSha };
}

describe("refactor runtime guard", () => {
  it('requires quality checks to pass unless report-only findings are explicit', () => {
    const gated = repo({qualityCommand: 'node -e "process.exit(9)"'});
    expect(run(gated.cwd,'baseline').code).not.toBe(0);
    const report = repo({qualityCommand: 'node -e "process.exit(9)"', qualityMode: 'report'});
    expect(run(report.cwd,'baseline').code).toBe(0);
    const executionError = repo({qualityCommand: 'node -e "process.exit(127)"', qualityMode: 'report'});
    expect(run(executionError.cwd,'baseline').code).not.toBe(0);
  });
  it("captures baseline, validates a scoped behavior-preserving change, and delivers it", () => {
    const { cwd } = repo();
    expect(run(cwd, "baseline").code).toBe(0);
    expect(existsSync(join(cwd, ".fabro-output", "baseline.json"))).toBe(true);
    expect(run(cwd, "begin-attempt").code).toBe(0);
    // Keep behavior identical while making a real scoped source change.
    writeFileSync(join(cwd, "src/parser.js"), "// parser remains behavior preserving\nexport const parse = (x) => x;\n");
    expect(run(cwd, "validate").code).toBe(0);
    writeFileSync(join(cwd, ".fabro-output", "review.md"), "Scoped change reviewed; checks and quality command passed.\n");
    expect(run(cwd, "deliver").code).toBe(0);
    const delivery = JSON.parse(readFileSync(join(cwd, ".fabro-output", "delivery.json"), "utf8"));
    expect(delivery.resultSha).toBe(git(cwd, "rev-parse", "HEAD"));
    expect(delivery.changedFiles).toEqual(["src/parser.js"]);
    expect(git(cwd, "show", "--format=", "--name-only", "HEAD")).toBe("src/parser.js");
    expect(existsSync(join(cwd, ".fabro-output", "diff.patch"))).toBe(true);
  });

  it("rejects validation failures and every kind of out-of-scope change", () => {
    const failed = repo();
    expect(run(failed.cwd, "baseline").code).toBe(0);
    expect(run(failed.cwd, "begin-attempt").code).toBe(0);
    writeFileSync(join(failed.cwd, "src/parser.js"), "// scoped\nexport const parse = (x) => x;\n");
    writeFileSync(join(failed.cwd, ".fabro-input", "work-order.json"), JSON.stringify(order(failed.baseSha, { validationCommands: ["node -e \"process.exit(3)\""] })));
    expect(run(failed.cwd, "validate").code).not.toBe(0);

    for (const mutation of [
      (cwd: string) => writeFileSync(join(cwd, "README.md"), "changed outside\n"),
      (cwd: string) => writeFileSync(join(cwd, "outside.txt"), "untracked outside\n"),
      (cwd: string) => { git(cwd, "rm", "-q", "README.md"); },
    ]) {
      const fixture = repo();
      expect(run(fixture.cwd, "baseline").code).toBe(0);
      expect(run(fixture.cwd, "begin-attempt").code).toBe(0);
      mutation(fixture.cwd);
      expect(run(fixture.cwd, "validate").code).not.toBe(0);
      expect(JSON.parse(readFileSync(join(fixture.cwd, ".fabro-output", "scope.json"), "utf8")).inScope).toBe(false);
    }
  });

  it("excludes workflow artifacts, enforces maxAttempts, and honors the time budget", () => {
    const fixture = repo({ maxChangedFiles: 1 });
    expect(run(fixture.cwd, "baseline").code).toBe(0);
    expect(run(fixture.cwd, "begin-attempt").code).toBe(0);
    writeFileSync(join(fixture.cwd, ".fabro-input", "note.txt"), "input\n");
    writeFileSync(join(fixture.cwd, ".fabro-output", "note.txt"), "output\n");
    writeFileSync(join(fixture.cwd, "src/one.js"), "1\n");
    writeFileSync(join(fixture.cwd, "src/two.js"), "2\n");
    expect(run(fixture.cwd, "validate").code).not.toBe(0);
    const scope = JSON.parse(readFileSync(join(fixture.cwd, ".fabro-output", "scope.json"), "utf8"));
    expect(scope.changed).toEqual(["src/one.js", "src/two.js"]);
    expect(scope.maxChangedFiles).toBe(1);

    const attempts = repo({ maxAttempts: 1 });
    expect(run(attempts.cwd, "baseline").code).toBe(0);
    expect(run(attempts.cwd, "begin-attempt").code).toBe(0);
    expect(run(attempts.cwd, "begin-attempt").code).not.toBe(0);

    const budget = repo();
    expect(run(budget.cwd, "baseline").code).toBe(0);
    writeFileSync(join(budget.cwd, ".fabro-output", "execution.json"), JSON.stringify({ startedAt: 0, baseline: true, attempts: 0 }));
    expect(run(budget.cwd, "begin-attempt").code).not.toBe(0);
  });
});
