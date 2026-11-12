#!/usr/bin/env node
// Bookkeeping helper for skills/gauntlet/gauntlet-loop.dot (a Gauntlet Loop
// run as an Attractor workflow). The graph's command nodes call this so the
// parts of the loop an agent must not be trusted with are deterministic:
// which piece is current, committing a candidate, exporting the blind A/B
// arena, de-blinding the critic's verdict, advancing or resetting the
// ratchet, and deciding when to stop. Plain Node ESM with no dependencies,
// so it runs under either `node` or `bun`.
//
//   setup                 copy this helper + the graph into ./.gauntlet, write the
//                         ./.gauntlet/g wrapper, and git-exclude ./.gauntlet
//   init [--force]        validate goal.md / bar.md / pieces.json, require a clean
//                         tree and a passing baseline `check`, and start the state
//   brief                 select the current piece and write .gauntlet/brief.md for
//                         the builder (prints DONE when every piece is finished)
//   snapshot              commit the builder's changes as a candidate, run `check`,
//                         capture evidence, and export candidate + current best as
//                         .gauntlet/arena/A and B in random order (exit 1, with the
//                         round already recorded as a loss, when there is nothing
//                         to judge: no changes, or `check` fails)
//   verdict --winner A|B --evidence ok|bad --bar-met yes|no --gap TEXT [--why TEXT]
//                         record the blind critic's verdict (the critic runs this)
//   ratchet               de-blind the verdict and apply it: a winning candidate
//                         becomes the new best, a losing one is reset away (exit 1
//                         when no verdict was recorded)
//   count                 print "pieces=N finished=M MORE|DONE"
//   finish                after the smoothing stage: keep its changes only if
//                         `check` passes, then exit with the final `check` result
//   status                print .gauntlet/progress.md
//
// Working files live in ./.gauntlet (git-excluded by `setup`): goal.md,
// bar.md, pieces.json, plan.md, brief.md, progress.md and arena/. The state
// that would un-blind a critic (which of A/B is the candidate, every commit
// id) lives outside the working tree in <git-dir>/gauntlet/state.json.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORK = ".gauntlet";
const ARENA = join(WORK, "arena");
const OUTPUT_LIMIT = 100_000;
const DEFAULT_LIMITS = { max_rounds: 5, plateau: 2, max_voids: 2 };
const FINISHED = new Set(["passed", "plateaued", "capped", "blocked"]);

class UsageError extends Error {}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (...args) => spawnSync("git", args, { stdio: "ignore" }).status === 0;

function statePath() {
  return join(git("rev-parse", "--git-dir"), "gauntlet", "state.json");
}

function loadState() {
  const path = statePath();
  if (!existsSync(path)) throw new UsageError("no gauntlet state — run `init` first");
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveState(state) {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(join(WORK, "progress.md"), renderProgress(state));
}

function readWorkFile(name) {
  const path = join(WORK, name);
  if (!existsSync(path)) throw new UsageError(`missing ${path}`);
  const text = readFileSync(path, "utf8").trim();
  if (text === "") throw new UsageError(`${path} is empty`);
  return text;
}

/** Runs a shell command in the repo root; returns its exit code and combined output (tail-capped). */
function runShell(command, timeoutMs) {
  const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const output = combined.length > OUTPUT_LIMIT ? `[…earlier output cut]\n${combined.slice(-OUTPUT_LIMIT)}` : combined;
  const timedOut = result.error?.code === "ETIMEDOUT";
  return { code: timedOut ? 124 : (result.status ?? 1), output: timedOut ? `${output}\n[timed out]` : output };
}

const checkTimeout = () => Number(process.env.GAUNTLET_CHECK_TIMEOUT_MS ?? 30 * 60_000);
const evidenceTimeout = () => Number(process.env.GAUNTLET_EVIDENCE_TIMEOUT_MS ?? 10 * 60_000);

function captureEvidence(piece) {
  if (!piece.evidence) return "(this piece declares no evidence command — inspect the files directly)\n";
  const { code, output } = runShell(piece.evidence, evidenceTimeout());
  return `$ ${piece.evidence}\n${output}\n[exit code ${code}]\n`;
}

function isDirty() {
  return git("status", "--porcelain") !== "";
}

function resetTo(sha) {
  git("reset", "--hard", "-q", sha);
  git("clean", "-fdq");
}

function commitAll(message) {
  git("add", "-A");
  const identity = gitOk("config", "user.name") ? [] : ["-c", "user.name=gauntlet", "-c", "user.email=gauntlet@localhost"];
  // --no-verify: the pieces file's `check` command is this loop's gate, and a
  // slow or interactive pre-commit hook would stall an unattended round.
  git(...identity, "commit", "-q", "--no-verify", "-m", message);
  return git("rev-parse", "HEAD");
}

const currentPiece = (state) => state.pieces.find((piece) => !FINISHED.has(piece.status));

function lastWords(text, limit = 4000) {
  const trimmed = text.trim();
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

/** Records one judged (or unjudgeable) round against a piece and settles the piece's status. */
function recordRound(state, piece, entry) {
  piece.history.push({ round: piece.rounds + 1, ...entry });
  if (entry.result === "void") {
    piece.voids += 1;
  } else {
    piece.rounds += 1;
    if (entry.result === "win") {
      piece.wins += 1;
      piece.losing_streak = 0;
    } else {
      piece.losing_streak += 1;
    }
  }
  const { max_rounds: maxRounds, plateau, max_voids: maxVoids } = state.limits;
  if (entry.bar_met) piece.status = "passed";
  else if (piece.voids >= maxVoids) piece.status = "blocked";
  else if (piece.losing_streak >= plateau) piece.status = "plateaued";
  else if (piece.rounds >= maxRounds) piece.status = "capped";
  else piece.status = "active";
}

function renderProgress(state) {
  const lines = ["# Gauntlet progress", "", "| Piece | Status | Rounds | Wins | Voided | Last result |", "|---|---|---|---|---|---|"];
  for (const piece of state.pieces) {
    const last = piece.history.at(-1);
    const lastText = last ? `${last.result}: ${(last.gap ?? last.why ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 160)}` : "—";
    lines.push(`| ${piece.id} — ${piece.title} | ${piece.status} | ${piece.rounds} | ${piece.wins} | ${piece.voids} | ${lastText} |`);
  }
  lines.push(
    "",
    "Status: `passed` = a blind critic judged the kept version to meet the bar; `plateaued` = consecutive candidates lost to the kept version; `capped` = round budget spent; `blocked` = the evidence was unusable too often.",
    "",
  );
  if (state.round) lines.push(`Round in flight: piece \`${state.round.piece}\`, round ${state.round.n} — waiting for a blind verdict.`, "");
  if (state.finish) lines.push(`Finish: ${state.finish}`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------- commands

function setup() {
  const here = dirname(fileURLToPath(import.meta.url));
  mkdirSync(WORK, { recursive: true });
  for (const name of ["gauntlet-loop.mjs", "gauntlet-loop.dot"]) {
    const from = join(here, name);
    const to = join(WORK, name);
    if (resolve(from) !== resolve(to)) copyFileSync(from, to);
  }
  const wrapper = join(WORK, "g");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/gauntlet-loop.mjs" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const exclude = join(git("rev-parse", "--git-common-dir"), "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  const existing = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!existing.split("\n").includes(`${WORK}/`)) writeFileSync(exclude, `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${WORK}/\n`);
  console.log(`set up ${WORK}/ (git-excluded). Next: write ${WORK}/goal.md and ${WORK}/bar.md, then run ${WORK}/gauntlet-loop.dot.`);
}

function validatePieces(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError("pieces.json must be a JSON object");
  if (raw.check !== undefined && typeof raw.check !== "string") throw new UsageError("pieces.json: `check` must be a shell command string");
  if (!Array.isArray(raw.pieces) || raw.pieces.length === 0) throw new UsageError("pieces.json: `pieces` must be a non-empty array");
  const seen = new Set();
  for (const piece of raw.pieces) {
    if (typeof piece?.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(piece.id)) {
      throw new UsageError("pieces.json: every piece needs an `id` of lowercase letters, digits and dashes");
    }
    if (seen.has(piece.id)) throw new UsageError(`pieces.json: duplicate piece id '${piece.id}'`);
    seen.add(piece.id);
    for (const key of ["title", "brief", "bar"]) {
      if (typeof piece[key] !== "string" || piece[key].trim() === "") throw new UsageError(`pieces.json: piece '${piece.id}' needs a non-empty \`${key}\``);
    }
    if (piece.evidence !== undefined && typeof piece.evidence !== "string") throw new UsageError(`pieces.json: piece '${piece.id}' has a non-string \`evidence\``);
  }
  const limits = { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_LIMITS)) throw new UsageError(`pieces.json: unknown limit '${key}'`);
    if (!Number.isInteger(value) || value < 1) throw new UsageError(`pieces.json: limit '${key}' must be a positive integer`);
  }
  return { check: raw.check?.trim() || null, limits, pieces: raw.pieces };
}

function init(args) {
  readWorkFile("goal.md");
  readWorkFile("bar.md");
  let parsed;
  try {
    parsed = JSON.parse(readWorkFile("pieces.json"));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`pieces.json is not valid JSON: ${error.message}`);
  }
  const { check, limits, pieces } = validatePieces(parsed);
  if (existsSync(statePath()) && !args.includes("--force")) {
    const previous = JSON.parse(readFileSync(statePath(), "utf8"));
    if (previous.round || previous.pieces.some((piece) => piece.rounds > 0 || piece.voids > 0)) {
      throw new UsageError("a gauntlet with recorded rounds already exists here — pass --force to discard its state");
    }
  }
  if (isDirty()) throw new UsageError("the working tree has uncommitted changes — commit or stash them first (a losing round is reset with `git reset --hard`)");
  if (check) {
    const { code, output } = runShell(check, checkTimeout());
    if (code !== 0) {
      console.log(lastWords(output));
      throw new UsageError(`the baseline fails \`check\` (exit ${code}) — fix it before starting; every candidate is gated on the same command`);
    }
  }
  const state = {
    version: 1,
    base: git("rev-parse", "HEAD"),
    check,
    limits,
    round: null,
    pieces: pieces.map((piece) => ({
      id: piece.id,
      title: piece.title.trim(),
      brief: piece.brief.trim(),
      bar: piece.bar.trim(),
      evidence: piece.evidence?.trim() || null,
      status: "pending",
      best: null,
      best_evidence: null,
      rounds: 0,
      wins: 0,
      voids: 0,
      losing_streak: 0,
      history: [],
    })),
  };
  saveState(state);
  console.log(`initialised ${state.pieces.length} piece(s); limits ${JSON.stringify(limits)}; check: ${check ?? "(none)"}`);
}

function brief() {
  const state = loadState();
  if (state.round) throw new UsageError(`round ${state.round.n} of piece '${state.round.piece}' is still waiting for a verdict — run \`ratchet\``);
  const piece = currentPiece(state);
  if (!piece) {
    console.log("DONE");
    return;
  }
  if (piece.best === null) {
    if (isDirty()) throw new UsageError("the working tree has uncommitted changes at the start of a piece");
    piece.best = git("rev-parse", "HEAD");
    piece.best_evidence = captureEvidence(piece);
  } else if (isDirty() || git("rev-parse", "HEAD") !== piece.best) {
    resetTo(piece.best);
  }
  piece.status = "active";
  const round = piece.rounds + 1;
  const feedback = piece.history.slice(-3).map((entry) => {
    if (entry.result === "win") return `- Round ${entry.round} WON and is now the kept version. Largest remaining gap to the bar, per the blind critic: ${entry.gap}`;
    if (entry.result === "void") return `- A round was voided because its evidence was unusable: ${entry.why ?? entry.gap}`;
    if (entry.result === "no_change") return `- Round ${entry.round} made no changes at all, so there was nothing to judge.`;
    if (entry.result === "check_failed") return `- Round ${entry.round} was discarded before judging because \`${state.check}\` failed:\n\n${indent(entry.gap)}`;
    return `- Round ${entry.round} LOST to the kept version and was discarded${entry.why ? ` (${entry.why})` : ""}. Largest remaining gap in the kept version: ${entry.gap}`;
  });
  const text = [
    `# Builder brief — piece \`${piece.id}\`: ${piece.title} (round ${round})`,
    "",
    "## Goal",
    readWorkFile("goal.md"),
    "",
    "## The bar",
    readWorkFile("bar.md"),
    "",
    `### Bar for this piece`,
    piece.bar,
    "",
    "## Your piece",
    piece.brief,
    "",
    ...(feedback.length ? ["## What blind critics said in earlier rounds", ...feedback, ""] : []),
    "## Rules",
    "- Improve this piece only. The working tree is the current kept version; build on it.",
    "- A fresh critic who has never seen your reasoning will compare your result against the kept version, unlabelled, and judge only the artifact. Comments or notes that argue for your work do not help.",
    ...(state.check ? [`- \`${state.check}\` must pass, or the round is discarded unjudged.`] : []),
    ...(piece.evidence ? [`- The critic is shown the output of \`${piece.evidence}\` for both versions.`] : []),
    `- Do not commit, do not run git commands that change history, and do not touch \`${WORK}/\`. The workflow commits, judges, and keeps or resets your changes itself.`,
    "- When you are finished, reply with the single line `candidate ready` and nothing else.",
    "",
  ].join("\n");
  writeFileSync(join(WORK, "brief.md"), text);
  saveState(state);
  console.log(`piece=${piece.id} round=${round} brief=${join(WORK, "brief.md")}`);
}

const indent = (text) => text.split("\n").map((line) => `      ${line}`).join("\n");

function exportTree(sha, dir) {
  mkdirSync(dir, { recursive: true });
  // -m: do not restore the archive's mtimes (they are the commit time, which
  // would tell a critic which version is newer).
  const result = spawnSync("/bin/sh", ["-c", 'git archive "$1" | tar -xm -C "$2"', "sh", sha, dir], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`could not export ${sha}: ${result.stderr}`);
}

function buildArena(state, piece) {
  const { round } = state;
  rmSync(ARENA, { recursive: true, force: true });
  mkdirSync(ARENA, { recursive: true });
  const sides = { best: { sha: piece.best, evidence: piece.best_evidence }, candidate: { sha: round.candidate, evidence: round.candidate_evidence } };
  for (const label of ["A", "B"]) {
    const side = sides[round.mapping[label]];
    exportTree(side.sha, join(ARENA, label));
    writeFileSync(join(ARENA, `${label}.evidence.txt`), side.evidence);
  }
  const text = [
    `# Critic brief — piece \`${piece.id}\`: ${piece.title}`,
    "",
    "Two versions of the same project are in `A/` and `B/` beside this file, with each version's captured evidence in `A.evidence.txt` and `B.evidence.txt`. One of them is the version currently being kept and the other is a new attempt; you are not told which, and the order is random. Decide which one is better **for this piece**, measured against the bar.",
    "",
    "## Goal",
    readWorkFile("goal.md"),
    "",
    "## The bar",
    readWorkFile("bar.md"),
    "",
    "### Bar for this piece",
    piece.bar,
    "",
    "## The piece being judged",
    piece.brief,
    "",
    "## Rules",
    "- Judge the artifact itself: read the files, read the evidence, and run things inside `A/` and `B/` if that helps. Do not trust comments, commit-style notes or documents that merely claim quality.",
    `- Stay inside \`${ARENA}/\`. Do not read git history, the rest of the working tree, or any other file under \`${WORK}/\` — they would tell you which version is which.`,
    "- First decide whether the evidence is usable. If a capture is empty, truncated, or plainly not showing the piece, say so with `--evidence bad`; a verdict built on bad evidence is worse than none.",
    "- There are no ties. Pick the better version even when the margin is small.",
    "- Then judge the winner against the bar: `--bar-met yes` only when nothing material separates it from the bar for this piece.",
    "- `--gap` is the single largest remaining gap between the winner and the bar, stated concretely enough to act on. `--why` is one sentence on why the other version lost. Refer to the versions only as A and B.",
    "",
    "Record your verdict by running exactly one command from the repository root, then stop:",
    "",
    "```",
    `${join(WORK, "g")} verdict --winner <A|B> --evidence <ok|bad> --bar-met <yes|no> --gap "<largest remaining gap>" --why "<why the other lost>"`,
    "```",
    "",
  ].join("\n");
  writeFileSync(join(ARENA, "BRIEF.md"), text);
}

function snapshot() {
  const state = loadState();
  const piece = currentPiece(state);
  if (!piece || piece.best === null) throw new UsageError("no active piece — run `brief` first");
  if (state.round) {
    // A retried stage: the candidate is already committed; just rebuild the arena.
    buildArena(state, piece);
    console.log(`piece=${piece.id} round=${state.round.n} arena rebuilt`);
    return;
  }
  const round = piece.rounds + 1;
  if (!isDirty()) {
    recordRound(state, piece, { result: "no_change", gap: "the builder changed nothing" });
    saveState(state);
    console.log(`piece=${piece.id} round=${round} result=no_change status=${piece.status}`);
    process.exitCode = 1;
    return;
  }
  const candidate = commitAll(`gauntlet(${piece.id}): round ${round} candidate`);
  git("update-ref", `refs/gauntlet/${piece.id}/r${round}`, candidate);
  if (state.check) {
    const { code, output } = runShell(state.check, checkTimeout());
    if (code !== 0) {
      resetTo(piece.best);
      recordRound(state, piece, { result: "check_failed", candidate, gap: lastWords(output, 2000) });
      saveState(state);
      console.log(`piece=${piece.id} round=${round} result=check_failed status=${piece.status}`);
      process.exitCode = 1;
      return;
    }
  }
  const candidateEvidence = captureEvidence(piece);
  // Capturing evidence may leave build output behind; the candidate is the commit.
  if (isDirty()) resetTo(candidate);
  const candidateIsA = Math.random() < 0.5;
  state.round = {
    piece: piece.id,
    n: round,
    candidate,
    candidate_evidence: candidateEvidence,
    mapping: candidateIsA ? { A: "candidate", B: "best" } : { A: "best", B: "candidate" },
  };
  buildArena(state, piece);
  saveState(state);
  console.log(`piece=${piece.id} round=${round} arena=${ARENA}`);
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!key?.startsWith("--") || args[index + 1] === undefined) throw new UsageError(`expected --flag value pairs, got '${key ?? ""}'`);
    flags[key.slice(2)] = args[index + 1];
  }
  return flags;
}

function oneOf(flags, key, allowed) {
  const value = typeof flags[key] === "string" ? flags[key].trim() : undefined;
  const match = allowed.find((option) => option.toLowerCase() === value?.toLowerCase());
  if (!match) throw new UsageError(`--${key} must be one of ${allowed.join("|")}`);
  return match;
}

const VERDICT = join(ARENA, "verdict.json");

/** Validates verdict fields (from flags, or re-read from the arena file). */
function parseVerdict(fields) {
  const gap = typeof fields.gap === "string" ? fields.gap.trim() : "";
  const verdictValue = {
    winner: oneOf(fields, "winner", ["A", "B"]),
    evidence: oneOf(fields, "evidence", ["ok", "bad"]),
    bar_met: oneOf(fields, "bar-met", ["yes", "no"]) === "yes",
    gap,
    why: typeof fields.why === "string" && fields.why.trim() !== "" ? fields.why.trim() : null,
  };
  if (gap === "") throw new UsageError("--gap is required: name the single largest remaining gap between the winner and the bar");
  return verdictValue;
}

// The critic runs this. It writes only into the arena (never the git dir, so
// it works from a sandbox that keeps .git read-only) and says nothing about
// which version is which — the verdict is in A/B terms until `ratchet`.
function verdict(args) {
  if (!existsSync(ARENA)) throw new UsageError("there is no round waiting for a verdict");
  const flags = parseFlags(args);
  parseVerdict(flags);
  writeFileSync(VERDICT, `${JSON.stringify(flags, null, 2)}\n`);
  console.log("verdict recorded");
}

function readVerdict() {
  if (!existsSync(VERDICT)) throw new UsageError("the critic did not record a verdict for this round");
  let fields;
  try {
    fields = JSON.parse(readFileSync(VERDICT, "utf8"));
  } catch {
    throw new UsageError(`${VERDICT} is not valid JSON — the critic must record its verdict with the \`verdict\` command`);
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new UsageError(`${VERDICT} must hold a JSON object`);
  return parseVerdict(fields);
}

function ratchet() {
  const state = loadState();
  const { round } = state;
  if (!round) throw new UsageError("there is no round to settle");
  const v = readVerdict();
  const piece = state.pieces.find((candidatePiece) => candidatePiece.id === round.piece);
  let result;
  if (v.evidence === "bad") {
    result = "void";
    resetTo(piece.best);
    recordRound(state, piece, { result, candidate: round.candidate, gap: v.gap, why: v.why });
  } else if (round.mapping[v.winner] === "candidate") {
    result = "win";
    piece.best = round.candidate;
    piece.best_evidence = round.candidate_evidence;
    recordRound(state, piece, { result, candidate: round.candidate, gap: v.gap, why: v.why, bar_met: v.bar_met });
  } else {
    result = "loss";
    resetTo(piece.best);
    recordRound(state, piece, { result, candidate: round.candidate, gap: v.gap, why: v.why, bar_met: v.bar_met });
  }
  state.round = null;
  rmSync(ARENA, { recursive: true, force: true });
  saveState(state);
  console.log(`piece=${piece.id} round=${round.n} result=${result} status=${piece.status}`);
}

function count() {
  const state = loadState();
  const finished = state.pieces.filter((piece) => FINISHED.has(piece.status)).length;
  console.log(`pieces=${state.pieces.length} finished=${finished} ${finished < state.pieces.length ? "MORE" : "DONE"}`);
}

function finish() {
  const state = loadState();
  let checked = false;
  if (isDirty()) {
    git("add", "-A");
    const before = git("rev-parse", "HEAD");
    const smoothed = state.check ? runShell(state.check, checkTimeout()) : { code: 0, output: "" };
    if (smoothed.code === 0) {
      commitAll("gauntlet: smoothing pass");
      state.finish = "smoothing pass kept.";
      checked = true;
    } else {
      resetTo(before);
      state.finish = "smoothing pass discarded: it broke `check`.";
      console.log(lastWords(smoothed.output, 2000));
    }
  } else {
    state.finish = "no smoothing changes.";
  }
  let code = 0;
  if (state.check && !checked) {
    const final = runShell(state.check, checkTimeout());
    code = final.code;
    if (code !== 0) console.log(lastWords(final.output, 2000));
  }
  state.finish += code === 0 ? " Final check passed." : ` Final check FAILED (exit ${code}).`;
  saveState(state);
  console.log(state.finish);
  console.log(`commits since start: ${git("rev-list", "--count", `${state.base}..HEAD`)}`);
  process.exitCode = code === 0 ? 0 : 1;
}

function status() {
  process.stdout.write(renderProgress(loadState()));
}

const COMMANDS = { setup, init, brief, snapshot, verdict, ratchet, count, finish, status };

const [command, ...args] = process.argv.slice(2);
try {
  const run = COMMANDS[command];
  if (!run) throw new UsageError(`usage: ${Object.keys(COMMANDS).join(" | ")}`);
  run(args);
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`gauntlet: ${error.message}`);
  process.exitCode = 2;
}
