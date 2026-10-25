#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const PREVIEW_BRANCH = "bb-plugin-decomposition-doc";

export function releaseTag(plugin, version) {
  return `${plugin}/v${version}`;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTION_PATH = path.join(ROOT, ".bb", "plugins.json");

export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part))) ||
      match[4]?.split(".").some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) {
    throw new Error(`invalid version: ${value}`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null };
}

export function isPrerelease(value) {
  return parseVersion(value).prerelease !== null;
}

export function assertVersionAdvance(current, target) {
  const a = parseVersion(current), b = parseVersion(target);
  let order = 0;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) { order = b[key] > a[key] ? 1 : -1; break; }
  }
  if (!order && a.prerelease !== b.prerelease) {
    if (a.prerelease === null) order = -1;
    else if (b.prerelease === null) order = 1;
    else {
      const x = a.prerelease.split("."), y = b.prerelease.split(".");
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (x[i] === y[i]) continue;
        if (x[i] === undefined) order = 1;
        else if (y[i] === undefined) order = -1;
        else {
          const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
          order = xn && yn ? (BigInt(y[i]) > BigInt(x[i]) ? 1 : -1)
            : xn !== yn ? (xn ? 1 : -1) : (y[i] > x[i] ? 1 : -1);
        }
        break;
      }
    }
  }
  if (order <= 0) throw new Error("release version must increase");
}

export function assertCleanTree(status) {
  if (status.trim()) throw new Error("release requires a clean working tree");
}

export function assertTagIsNew({ localTagExists, remoteTagExists }) {
  if (localTagExists || remoteTagExists) {
    throw new Error("release tag already exists; refusing to move an existing tag");
  }
}

export function assertReleasePolicy({ mode, version, branch, status, localTagExists = false, remoteTagExists = false, ahead = 0, behind = 0 }) {
  parseVersion(version);
  assertCleanTree(status);
  assertTagIsNew({ localTagExists, remoteTagExists });
  if (mode === "preview") {
    if (branch !== PREVIEW_BRANCH) throw new Error(`preview releases require branch ${PREVIEW_BRANCH}`);
    if (!isPrerelease(version)) throw new Error("preview releases require a prerelease version");
    if (!/^0\.1\.1-preview\.[1-9]\d*$/.test(version)) throw new Error("preview version must match the catalog line 0.1.1-preview.N");
    return;
  }
  if (mode !== "stable") throw new Error(`unknown release mode: ${mode}`);
  if (branch !== "main") throw new Error("stable releases require branch main");
  if (isPrerelease(version)) throw new Error("stable releases require a non-prerelease version");
  if (ahead !== 0 || behind !== 0) throw new Error("stable releases require synchronized origin/main");
}

export function readKnownPlugin(plugin) {
  const collection = JSON.parse(readFileSync(COLLECTION_PATH, "utf8"));
  const entry = collection.plugins.find((candidate) => candidate.name === plugin);
  if (!entry) throw new Error(`unknown plugin: ${plugin}`);
  if (plugin !== "communications-hub") throw new Error("release automation currently supports communications-hub only");
  const source = path.resolve(ROOT, entry.source);
  if (!source.startsWith(`${ROOT}${path.sep}`)) throw new Error("plugin source must stay inside this checkout");
  const packageJson = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  return { entry, source, packageJson };
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function gitStatus() {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" });
}

function hasLocalTag(tag) {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasRemoteTag(tag, remote) {
  try {
    const result = execFileSync("git", ["ls-remote", "--tags", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return Boolean(result.trim());
  } catch {
    throw new Error(`could not inspect tags on remote ${remote}`);
  }
}

export function assertRemoteMain(head, remoteHead) {
  if (!remoteHead || head !== remoteHead) throw new Error("stable releases require synchronized origin/main");
}

function verifyRemoteMain() {
  const remoteHead = git(["ls-remote", "--exit-code", "origin", "refs/heads/main"]).split(/\s+/)[0];
  assertRemoteMain(git(["rev-parse", "HEAD"]), remoteHead);
}

function verifyPlugin(source) {
  const commands = [
    ["npm", ["ci"]],
    ["npm", ["test"]],
    ["npm", ["run", "typecheck"]],
    [process.env.BB_CLI || "bb", ["plugin", "types", "--check"]],
    [process.env.BB_CLI || "bb", ["plugin", "build"]],
  ];
  for (const [command, args] of commands) execFileSync(command, args, { cwd: source, stdio: "inherit" });
}

function usage() {
  console.error("Usage: plugin-release.mjs <preview|stable> --plugin <id> --version <x.y.z[-prerelease]> [--check|--no-push]");
}

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const args = { mode, check: false, push: true };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--check") args.check = true;
    else if (flag === "--no-push") args.push = false;
    else if (flag === "--plugin") args.plugin = rest[++index];
    else if (flag === "--version") args.version = rest[++index];
    else throw new Error(`unknown option: ${flag}`);
  }
  if (!args.plugin || !args.version || !["preview", "stable"].includes(args.mode)) throw new Error("mode, --plugin, and --version are required");
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { source, packageJson } = readKnownPlugin(args.plugin);
  const tag = releaseTag(args.plugin, args.version);
  const branch = git(["branch", "--show-current"]);
  const status = gitStatus();
  assertReleasePolicy({ ...args, branch, status });
  assertTagIsNew({ localTagExists: hasLocalTag(tag), remoteTagExists: hasRemoteTag(tag, "origin") });
  if (args.mode === "stable") verifyRemoteMain();
  assertVersionAdvance(packageJson.version, args.version);
  console.log(`${args.mode} release ${args.plugin} ${packageJson.version} -> ${args.version} (${tag})`);
  if (args.check) return;
  verifyPlugin(source);
  assertCleanTree(gitStatus());
  if (args.mode === "stable") verifyRemoteMain();
  execFileSync("npm", ["version", args.version, "--no-git-tag-version"], { cwd: source, stdio: "inherit" });
  execFileSync("git", ["add", path.relative(ROOT, path.join(source, "package.json")), path.relative(ROOT, path.join(source, "package-lock.json"))], { cwd: ROOT, stdio: "inherit" });
  execFileSync("git", ["commit", "-m", `release(${args.plugin}): ${args.version}`], { cwd: ROOT, stdio: "inherit" });
  execFileSync("git", ["tag", "-a", tag, "-m", `release ${args.plugin} ${args.version}`], { cwd: ROOT, stdio: "inherit" });
  if (args.push) {
    execFileSync("git", ["push", "--atomic", "origin", `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`], { cwd: ROOT, stdio: "inherit" });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) { usage(); console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
