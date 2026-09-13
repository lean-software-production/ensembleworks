import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "../host";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function cwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "attractor-host-"));
  dirs.push(dir);
  return dir;
}

describe("attractor host exec entry", () => {
  it("runs the script with /bin/sh -c, in cwd, with the run/node env vars, and returns exit code + stdout", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const result = await harness.experimental_call("exec", {
      script: "echo hello $ATTRACTOR_RUN_ID $ATTRACTOR_NODE_ID; pwd",
      cwd: await cwd(),
      env: { ATTRACTOR_RUN_ID: "run-1", ATTRACTOR_NODE_ID: "build" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello run-1 build");
    expect(result.timedOut).toBe(false);
    await harness.experimental_dispose();
  });

  it("returns a non-zero exit code and stderr for a failing command", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const result = await harness.experimental_call("exec", { script: "echo oops 1>&2; exit 3", cwd: await cwd() });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("oops");
    await harness.experimental_dispose();
  });

  it("pipes stdin through to the script", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const result = await harness.experimental_call("exec", { script: "cat", cwd: await cwd(), stdin: "piped in" });
    expect(result.stdout).toBe("piped in");
    await harness.experimental_dispose();
  });

  it("kills a script that exceeds timeoutMs and reports timedOut", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const result = await harness.experimental_call("exec", { script: "sleep 5", cwd: await cwd(), timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    await harness.experimental_dispose();
  }, 10_000);

  it("bounds stdout to the last MAX_OUTPUT_BYTES, keeping the tail", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const result = await harness.experimental_call("exec", {
      script: "node -e \"process.stdout.write('a'.repeat(100000) + 'END')\"",
      cwd: await cwd(),
    });
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.stdout.endsWith("END")).toBe(true);
    await harness.experimental_dispose();
  });
});
