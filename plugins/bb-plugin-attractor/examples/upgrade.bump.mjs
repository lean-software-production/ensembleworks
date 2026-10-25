#!/usr/bin/env bun
// Version-bump helper for examples/upgrade-vite-8.dot (and any other
// major-upgrade graph): applies a research stage's decision about *which*
// packages move to *which* versions, so the bump itself is a deterministic
// command node rather than an agent edit.
//
//   bun upgrade.bump.mjs <packages.json>
//
// packages.json is a JSON array of { "name", "version", "workspace" } where
// workspace is the package directory relative to the repo root (e.g.
// "client"). Each entry is rewritten in that workspace's package.json,
// keeping whatever range prefix it already had (^, ~, or none). A package
// not declared in that workspace is an error, not a silent add.
import { readFileSync, writeFileSync } from "node:fs";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("usage: bun upgrade.bump.mjs <packages.json>");
  process.exit(2);
}
const entries = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${file}: expected a non-empty JSON array`);

const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const touched = new Map();
for (const { name, version, workspace } of entries) {
  if (!name || !version || !workspace) throw new Error(`bad entry: ${JSON.stringify({ name, version, workspace })}`);
  const path = `${workspace}/package.json`;
  const pkg = touched.get(path) ?? JSON.parse(readFileSync(path, "utf8"));
  let found = false;
  for (const section of SECTIONS) {
    const deps = pkg[section];
    if (!deps || !(name in deps)) continue;
    const prefix = /^[\^~]/.exec(deps[name])?.[0] ?? "";
    console.log(`${path}: ${section}.${name} ${deps[name]} -> ${prefix}${version}`);
    deps[name] = `${prefix}${version}`;
    found = true;
  }
  if (!found) throw new Error(`${path} does not declare ${name}`);
  touched.set(path, pkg);
}
for (const [path, pkg] of touched) writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`updated ${touched.size} package.json file(s)`);
