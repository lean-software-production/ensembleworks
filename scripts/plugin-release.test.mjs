import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertCleanTree, assertReleasePolicy, assertTagIsNew, assertRemoteMain, assertVersionAdvance, parseArgs, isPrerelease, parseVersion, readKnownPlugin, releaseTag, PREVIEW_BRANCH } from "./plugin-release.mjs";

describe("plugin release guardrails", () => {
  it("requires increasing versions within the advertised preview line", () => {
    assert.doesNotThrow(() => assertVersionAdvance("0.1.0", "0.1.1-preview.1"));
    assert.doesNotThrow(() => assertVersionAdvance("0.1.1-preview.2", "0.1.1-preview.10"));
    assert.doesNotThrow(() => assertVersionAdvance("0.1.1-preview.10", "0.1.1"));
    for (const [a,b] of [["0.1.0","0.0.1"], ["0.1.1-preview.2","0.1.1-preview.1"], ["0.1.1","0.1.1-preview.1"], ["0.1.1","0.1.1"]]) assert.throws(() => assertVersionAdvance(a,b), /increase/);
    assert.throws(() => assertReleasePolicy({mode:"preview",version:"0.2.0-preview.1",branch:PREVIEW_BRANCH,status:""}), /catalog line/);
  });
  it("checks actual remote main and rejects bypassing verification", () => {
    assert.doesNotThrow(() => assertRemoteMain("current", "current"));
    assert.throws(() => assertRemoteMain("stale-local-tracking-ref", "new-remote-commit"), /synchronized/);
    assert.throws(() => assertRemoteMain("current", ""), /synchronized/);
    assert.throws(() => parseArgs(["stable", "--plugin", "communications-hub", "--version", "0.1.0", "--skip-verify"]), /unknown option/);
    assert.throws(() => parseVersion("0.1.1-preview.01"), /invalid version/);
  });
  it("accepts release versions and identifies prereleases", () => {
    assert.deepEqual(parseVersion("0.1.1-preview.2"), { major: 0, minor: 1, patch: 1, prerelease: "preview.2" });
    assert.equal(isPrerelease("0.1.1-preview.2"), true);
    assert.equal(isPrerelease("0.1.0"), false);
    assert.throws(() => parseVersion("v0.1.0"), /invalid version/);
    assert.throws(() => parseVersion("01.1.0"), /invalid version/);
  });

  it("requires a clean tree", () => {
    assert.doesNotThrow(() => assertCleanTree(""));
    assert.throws(() => assertCleanTree(" M package.json\n"), /clean working tree/);
  });

  it("only permits the known collection plugin", () => {
    const plugin = readKnownPlugin("communications-hub");
    assert.equal(plugin.entry.source, "./plugins/communications-hub");
    assert.equal(plugin.packageJson.name, "bb-plugin-communications-hub");
    assert.throws(() => readKnownPlugin("not-a-plugin"), /unknown plugin/);
  });

  it("keeps the demo catalog to the preview Communications Hub entry", () => {
    const catalog = JSON.parse(readFileSync(new URL("../marketplace.json", import.meta.url), "utf8"));
    assert.equal(catalog.name, "ensembleworks");
    assert.deepEqual(catalog.plugins.map((plugin) => plugin.id), ["communications-hub"]);
    assert.equal(catalog.plugins[0].source.git.range, ">=0.1.1-preview.1 <0.1.1");
    assert.equal(catalog.plugins[0].source.git.tagPrefix, "communications-hub/");
  });

  it("keeps preview releases explicit and branch-scoped", () => {
    assert.doesNotThrow(() => assertReleasePolicy({ mode: "preview", version: "0.1.1-preview.1", branch: PREVIEW_BRANCH, status: "" }));
    assert.throws(() => assertReleasePolicy({ mode: "preview", version: "0.1.0", branch: PREVIEW_BRANCH, status: "" }), /prerelease/);
    assert.throws(() => assertReleasePolicy({ mode: "preview", version: "0.1.1-preview.1", branch: "main", status: "" }), /require branch/);
  });

  it("requires clean synchronized main for stable releases", () => {
    assert.doesNotThrow(() => assertReleasePolicy({ mode: "stable", version: "0.1.0", branch: "main", status: "", ahead: 0, behind: 0 }));
    assert.throws(() => assertReleasePolicy({ mode: "stable", version: "0.1.0", branch: "main", status: "", ahead: 1, behind: 0 }), /synchronized/);
    assert.throws(() => assertReleasePolicy({ mode: "stable", version: "0.1.0", branch: "feature", status: "", ahead: 0, behind: 0 }), /branch main/);
  });

  it("never moves an existing local or remote tag", () => {
    assert.equal(releaseTag("communications-hub", "0.1.1-preview.1"), "communications-hub/v0.1.1-preview.1");
    assert.doesNotThrow(() => assertTagIsNew({ localTagExists: false, remoteTagExists: false }));
    assert.throws(() => assertTagIsNew({ localTagExists: true, remoteTagExists: false }), /already exists/);
    assert.throws(() => assertTagIsNew({ localTagExists: false, remoteTagExists: true }), /already exists/);
  });
});
