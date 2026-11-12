/**
 * skills/gauntlet/gauntlet-loop.mjs — the deterministic bookkeeping behind
 * the Gauntlet Loop graph — driven as a subprocess against a throwaway git
 * repository, exactly as the graph's command nodes (and the critic) call it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HELPER = fileURLToPath(new URL("../skills/gauntlet/gauntlet-loop.mjs", import.meta.url));

let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

/** Runs the installed copy (.gauntlet/g), as the graph does. */
function g(...args: string[]) {
  const result = spawnSync(join(repo, ".gauntlet", "g"), args, { cwd: repo, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const secretState = () => JSON.parse(readFileSync(join(repo, ".git", "gauntlet", "state.json"), "utf8"));
const read = (path: string) => readFileSync(join(repo, path), "utf8");
const write = (path: string, text: string) => writeFileSync(join(repo, path), text);

interface PieceInput {
  id: string;
  title?: string;
  brief?: string;
  bar?: string;
  evidence?: string;
}

function writePlan(options: { check?: string; pieces?: PieceInput[]; limits?: Record<string, number> } = {}) {
  write(".gauntlet/goal.md", "Make greet.txt delightful.\n");
  write(".gauntlet/bar.md", "As warm as a handwritten card.\n");
  const pieces = (options.pieces ?? [{ id: "greeting" }]).map((piece) => ({
    title: "Greeting",
    brief: "Improve greet.txt",
    bar: "Reads like a person wrote it",
    evidence: "cat greet.txt",
    ...piece,
  }));
  write(".gauntlet/pieces.json", JSON.stringify({ check: options.check ?? "test -s greet.txt", pieces, limits: options.limits }));
}

/** Label (A or B) the arena currently assigns to the candidate / the kept version. */
const labelOf = (side: "candidate" | "best") => {
  const { mapping } = secretState().round;
  return mapping.A === side ? "A" : "B";
};

function judge(side: "candidate" | "best", extra: { barMet?: boolean; evidence?: "ok" | "bad" } = {}) {
  return g(
    "verdict", "--winner", labelOf(side), "--evidence", extra.evidence ?? "ok", "--bar-met", extra.barMet ? "yes" : "no",
    "--gap", "still a bit stiff", "--why", "the other one was curt",
  );
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gauntlet-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  write("greet.txt", "hi\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const setup = spawnSync(process.execPath, [HELPER, "setup"], { cwd: repo, encoding: "utf8" });
  expect(setup.status).toBe(0);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("gauntlet-loop: setup", () => {
  it("installs the helper, graph and wrapper into a git-excluded .gauntlet/", () => {
    expect(readdirSync(join(repo, ".gauntlet")).sort()).toEqual(["g", "gauntlet-loop.dot", "gauntlet-loop.mjs"]);
    expect(git("status", "--porcelain")).toBe("");
    expect(g("nonsense").code).toBe(2);
  });

  it("does not duplicate the exclude entry when run twice", () => {
    expect(g("setup").code).toBe(0);
    expect(read(".git/info/exclude").split("\n").filter((line) => line === ".gauntlet/")).toHaveLength(1);
  });
});

describe("gauntlet-loop: init", () => {
  it("refuses a missing bar, a dirty tree, an invalid plan, and a failing baseline", () => {
    write(".gauntlet/goal.md", "goal\n");
    expect(g("init").err).toContain("missing .gauntlet/bar.md");

    writePlan();
    write("stray.txt", "uncommitted\n");
    expect(g("init").err).toContain("uncommitted changes");
    rmSync(join(repo, "stray.txt"));

    writePlan({ pieces: [{ id: "Bad Id" }] });
    expect(g("init").err).toContain("lowercase letters, digits and dashes");

    writePlan({ pieces: [{ id: "a" }, { id: "a" }] });
    expect(g("init").err).toContain("duplicate piece id");

    writePlan({ check: "false" });
    const failing = g("init");
    expect(failing.code).toBe(2);
    expect(failing.err).toContain("baseline fails `check`");
  });

  it("starts every piece pending and writes a progress page", () => {
    writePlan({ pieces: [{ id: "one" }, { id: "two" }] });
    expect(g("init").code).toBe(0);
    expect(secretState().pieces.map((piece: { status: string }) => piece.status)).toEqual(["pending", "pending"]);
    expect(read(".gauntlet/progress.md")).toContain("| one — Greeting | pending | 0 |");
    expect(g("count").out).toContain("pieces=2 finished=0 MORE");
  });
});

describe("gauntlet-loop: a judged round", () => {
  beforeEach(() => {
    writePlan();
    expect(g("init").code).toBe(0);
    expect(g("brief").out).toContain("piece=greeting round=1");
  });

  it("writes a builder brief carrying the goal, the bar and the piece", () => {
    const brief = read(".gauntlet/brief.md");
    expect(brief).toContain("Make greet.txt delightful.");
    expect(brief).toContain("As warm as a handwritten card.");
    expect(brief).toContain("Improve greet.txt");
    expect(brief).toContain("candidate ready");
  });

  it("exports candidate and kept version as an unlabelled A/B arena with evidence", () => {
    write("greet.txt", "Hello, dear friend!\n");
    const snap = g("snapshot");
    expect(snap.code).toBe(0);

    const candidate = labelOf("candidate");
    const best = labelOf("best");
    expect(read(`.gauntlet/arena/${candidate}/greet.txt`)).toBe("Hello, dear friend!\n");
    expect(read(`.gauntlet/arena/${best}/greet.txt`)).toBe("hi\n");
    expect(read(`.gauntlet/arena/${candidate}.evidence.txt`)).toContain("Hello, dear friend!");
    expect(read(`.gauntlet/arena/${best}.evidence.txt`)).toContain("hi");
    expect(read(".gauntlet/arena/BRIEF.md")).toContain("verdict --winner <A|B>");
    // The exported trees carry no git metadata and no helper state.
    expect(existsSync(join(repo, ".gauntlet/arena/A/.git"))).toBe(false);
    expect(existsSync(join(repo, ".gauntlet/arena/A/.gauntlet"))).toBe(false);
  });

  it("leaks nothing that would un-blind the critic", () => {
    write("greet.txt", "Hello, dear friend!\n");
    const snap = g("snapshot");
    const { candidate, mapping } = secretState().round;
    // Neither the command's output (which lands in the run context) nor any
    // file under .gauntlet/ names the candidate commit or the A/B mapping.
    expect(snap.out).not.toContain(candidate);
    expect(snap.out).not.toMatch(/candidate|best|kept/i);
    const everything = [".gauntlet/progress.md", ".gauntlet/brief.md", ".gauntlet/arena/BRIEF.md"].map(read).join("\n");
    expect(everything).not.toContain(candidate);
    expect(everything).not.toContain(JSON.stringify(mapping));
    // Both exports were written now, not stamped with their commit times.
    const age = (label: string) => statSync(join(repo, `.gauntlet/arena/${label}/greet.txt`)).mtimeMs;
    expect(Math.abs(age("A") - age("B"))).toBeLessThan(5_000);
    // Recording a verdict does not reveal it either.
    expect(judge("candidate").out).not.toMatch(/candidate|best|kept|win|loss/i);
  });

  it("keeps a winning candidate and finishes the piece when the bar is met", () => {
    write("greet.txt", "Hello, dear friend!\n");
    g("snapshot");
    expect(judge("candidate", { barMet: true }).code).toBe(0);
    const settled = g("ratchet");
    expect(settled.out).toContain("result=win status=passed");
    expect(read("greet.txt")).toBe("Hello, dear friend!\n");
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "-1", "--format=%s")).toBe("gauntlet(greeting): round 1 candidate");
    expect(existsSync(join(repo, ".gauntlet/arena"))).toBe(false);
    expect(g("count").out).toContain("finished=1 DONE");
    expect(g("brief").out.trim()).toBe("DONE");
  });

  it("keeps a winning candidate as the new kept version and carries the gap into the next brief", () => {
    write("greet.txt", "Hello, dear friend!\n");
    g("snapshot");
    judge("candidate");
    expect(g("ratchet").out).toContain("result=win status=active");
    expect(g("brief").out).toContain("round=2");
    expect(read(".gauntlet/brief.md")).toContain("Round 1 WON");
    expect(read(".gauntlet/brief.md")).toContain("still a bit stiff");

    // Round 2 is judged against round 1's winner, not the original baseline.
    write("greet.txt", "Yo.\n");
    g("snapshot");
    expect(read(`.gauntlet/arena/${labelOf("best")}/greet.txt`)).toBe("Hello, dear friend!\n");
  });

  it("resets a losing candidate away, keeps it reachable by ref, and plateaus after consecutive losses", () => {
    write("greet.txt", "worse\n");
    write("extra.txt", "new file from the builder\n");
    g("snapshot");
    const { candidate } = secretState().round;
    judge("best");
    expect(g("ratchet").out).toContain("result=loss status=active");
    expect(read("greet.txt")).toBe("hi\n");
    expect(existsSync(join(repo, "extra.txt"))).toBe(false);
    expect(git("rev-parse", "refs/gauntlet/greeting/r1")).toBe(candidate);

    g("brief");
    expect(read(".gauntlet/brief.md")).toContain("Round 1 LOST");
    write("greet.txt", "also worse\n");
    g("snapshot");
    judge("best");
    expect(g("ratchet").out).toContain("result=loss status=plateaued");
    expect(g("count").out).toContain("DONE");
  });

  it("finishes the piece when the kept version wins and already meets the bar", () => {
    write("greet.txt", "worse\n");
    g("snapshot");
    judge("best", { barMet: true });
    expect(g("ratchet").out).toContain("result=loss status=passed");
  });

  it("voids a round whose evidence the critic rejects, without counting it as a loss", () => {
    write("greet.txt", "Hello, dear friend!\n");
    g("snapshot");
    judge("candidate", { evidence: "bad" });
    expect(g("ratchet").out).toContain("result=void status=active");
    expect(read("greet.txt")).toBe("hi\n");
    const [piece] = secretState().pieces;
    expect(piece).toMatchObject({ rounds: 0, voids: 1, losing_streak: 0 });

    g("brief");
    write("greet.txt", "Hello again!\n");
    g("snapshot");
    judge("candidate", { evidence: "bad" });
    expect(g("ratchet").out).toContain("result=void status=blocked");
  });

  it("records a round with no changes as a loss and fails the stage", () => {
    const snap = g("snapshot");
    expect(snap.code).toBe(1);
    expect(snap.out).toContain("result=no_change status=active");
    expect(secretState().round).toBeNull();
  });

  it("discards a candidate that fails check before any critic sees it", () => {
    write("greet.txt", "");
    const snap = g("snapshot");
    expect(snap.code).toBe(1);
    expect(snap.out).toContain("result=check_failed");
    expect(read("greet.txt")).toBe("hi\n");
    expect(existsSync(join(repo, ".gauntlet/arena"))).toBe(false);
    g("brief");
    expect(read(".gauntlet/brief.md")).toContain("discarded before judging");
  });

  it("refuses to settle a round with no verdict, and rejects a malformed verdict", () => {
    write("greet.txt", "Hello, dear friend!\n");
    g("snapshot");
    const unsettled = g("ratchet");
    expect(unsettled.code).toBe(2);
    expect(unsettled.err).toContain("did not record a verdict");
    expect(secretState().round).not.toBeNull();

    expect(g("verdict", "--winner", "C", "--evidence", "ok", "--bar-met", "no", "--gap", "x").err).toContain("--winner must be one of A|B");
    expect(g("verdict", "--winner", "A", "--evidence", "ok", "--bar-met", "no").err).toContain("--gap is required");
    // A retried snapshot rebuilds the same arena rather than starting a new round.
    rmSync(join(repo, ".gauntlet/arena"), { recursive: true });
    expect(g("snapshot").out).toContain("arena rebuilt");
    expect(existsSync(join(repo, ".gauntlet/arena/A/greet.txt"))).toBe(true);
  });

  it("caps a piece at max_rounds", () => {
    writePlan({ limits: { max_rounds: 1 } });
    expect(g("init", "--force").code).toBe(0);
    g("brief");
    write("greet.txt", "Hello, dear friend!\n");
    g("snapshot");
    judge("candidate");
    expect(g("ratchet").out).toContain("result=win status=capped");
  });
});

describe("gauntlet-loop: several pieces and finish", () => {
  it("moves to the next piece once one finishes", () => {
    writePlan({ pieces: [{ id: "one" }, { id: "two" }] });
    g("init");
    g("brief");
    write("greet.txt", "Hello, dear friend!\n");
    g("snapshot");
    judge("candidate", { barMet: true });
    g("ratchet");
    expect(g("count").out).toContain("pieces=2 finished=1 MORE");
    expect(g("brief").out).toContain("piece=two round=1");
  });

  it("keeps a smoothing pass that passes check and discards one that breaks it", () => {
    writePlan();
    g("init");
    write("greet.txt", "Hello, smoothed.\n");
    const kept = g("finish");
    expect(kept.code).toBe(0);
    expect(kept.out).toContain("smoothing pass kept. Final check passed.");
    expect(git("log", "-1", "--format=%s")).toBe("gauntlet: smoothing pass");

    write("greet.txt", "");
    const discarded = g("finish");
    expect(discarded.code).toBe(0);
    expect(discarded.out).toContain("smoothing pass discarded");
    expect(read("greet.txt")).toBe("Hello, smoothed.\n");
    expect(g("status").out).toContain("# Gauntlet progress");
  });
});
