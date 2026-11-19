import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ACCESS_EMAIL_HEADER } from "./request-context.js";
import { SenderLedger } from "./senders.js";
import plugin from "./server.js";
import { TIME_ZONES_KEY } from "./time-zones.js";

/**
 * Each person's BB app reports its time zone with the presence heartbeat, and agents read
 * it back through `identity_recent_senders`, the instructions line and `bb identity
 * time-zones`. Driven through the real plugin factory in bb's fake host.
 */

const DIRECTORY = JSON.stringify([
  { person: "alex", github: "alexgh", displayName: "Alex Rivera", emails: ["alex@example.com"] },
  { person: "sam", github: "samgh", displayName: "Sam Chen", emails: ["sam@example.org"] },
]);
const alex = { person: "alex", github: "alexgh", displayName: "Alex Rivera" };
const sam = { person: "sam", github: "samgh", displayName: "Sam Chen" };
/** Wednesday 18 November 2026, 9:53 p.m. in Los Angeles; already Thursday in UTC. */
const NOW = Date.UTC(2026, 10, 19, 5, 53);
const THREAD = "thr_pairing";

let host: ReturnType<typeof createFakePluginHost>;

async function load(settings: Record<string, string> = {}, seed: (kv: typeof host.bb.storage.kv) => Promise<unknown> = async () => undefined) {
  host = createFakePluginHost({ pluginId: "identity", settings: { directory: DIRECTORY, ...settings } });
  await seed(host.bb.storage.kv);
  await plugin(host.bb);
}

const call = <T>(method: string, input: unknown = {}) => host.harness.callRpc(method, input) as Promise<T>;
/** Run `work` inside the request context of an http request carrying `headers`. */
const asRequest = <T>(headers: Record<string, string>, work: () => Promise<T>) => new Promise<T>((resolve, reject) => {
  const server = new http.Server();
  server.on("request", () => { work().then(resolve, reject); });
  server.emit("request", { headers, method: "POST", url: "/api/v1/plugins/identity/rpc" }, undefined);
});
const heartbeat = (email: string | null, timeZone?: unknown) =>
  asRequest(email === null ? {} : { [ACCESS_EMAIL_HEADER]: email }, () => call("presence_heartbeat", {
    tabId: `tab-${email ?? "anon"}`, viewerId: `viewer-${email ?? "anon"}`,
    location: { kind: "thread", threadId: THREAD }, ...(timeZone === undefined ? {} : { timeZone }),
  }));
const recentSenders = async () => {
  const result = await host.harness.callAgentTool("identity_recent_senders", {}, { threadId: THREAD });
  return typeof result === "string" ? result : JSON.stringify(result);
};
const recordSenders = async (...people: Array<typeof alex>) => {
  const ledger = new SenderLedger(host.bb.storage.kv);
  for (const [index, person] of people.entries()) {
    await ledger.record({ threadId: THREAD, text: `prompt ${index}`, person, email: null, at: NOW - 60_000 });
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // The boot self-test probes bb's loopback API; nothing answers it here.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
});

afterEach(async () => {
  await host?.harness.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("time zones reported by each person's BB app", () => {
  it("shows an identified sender's reported zone and local time in identity_recent_senders", async () => {
    await load();
    await recordSenders(alex, sam);
    expect(await heartbeat("alex@example.com", "America/Los_Angeles")).toEqual({ ok: true });
    const text = await recentSenders();
    expect(text).toContain("- Alex Rivera (@alexgh): America/Los_Angeles, local time Wednesday 18 November 2026, 21:53 (UTC-8), reported 0s ago");
    expect(text).toContain("- Sam Chen (@samgh): no time zone reported by their BB app.");
  });

  it("names the zone in the instructions line for the person prompting", async () => {
    await load();
    await recordSenders(alex);
    await heartbeat("alex@example.com", "America/Los_Angeles");
    vi.setSystemTime(NOW + 120_000);
    await recentSenders(); // warms the sender list the synchronous provider reads
    const instructions = host.harness.registrations.instructionProvider!({ threadId: THREAD, projectId: "p" });
    expect(instructions).toContain("The person prompting you on this thread so far: Alex Rivera (@alexgh, America/Los_Angeles, reported 2m ago).");
    expect(instructions).toContain("call identity_recent_senders for their current time zone and local time");
  });

  it("updates the zone when the app reports a new one", async () => {
    await load();
    await recordSenders(alex);
    await heartbeat("alex@example.com", "America/Los_Angeles");
    await heartbeat("alex@example.com", "Europe/London");
    expect(await recentSenders()).toContain("- Alex Rivera (@alexgh): Europe/London, local time Thursday 19 November 2026, 05:53 (UTC)");
  });

  it("knows a zone stored before a restart", async () => {
    await load({}, (kv) => kv.set(TIME_ZONES_KEY, { alex: { zone: "Asia/Kolkata", at: NOW - 3_600_000 } }));
    await recordSenders(alex);
    expect(await recentSenders()).toContain("- Alex Rivera (@alexgh): Asia/Kolkata, local time Thursday 19 November 2026, 11:23 (UTC+5:30), reported 1h ago");
  });

  it("records no zone for a configured-fallback identity, which may not be the person at the keyboard", async () => {
    await load({ fallbackEmail: "alex@example.com" });
    await recordSenders(alex);
    expect(await heartbeat(null, "Europe/Berlin")).toEqual({ ok: true });
    expect(await recentSenders()).toContain("- Alex Rivera (@alexgh): no time zone reported by their BB app.");
  });

  it("keeps presence working when the zone is missing or invalid", async () => {
    await load();
    await recordSenders(alex);
    expect(await heartbeat("alex@example.com")).toEqual({ ok: true });
    expect(await heartbeat("alex@example.com", "Mars/Olympus")).toEqual({ ok: true });
    expect(await call<{ viewers: number }>("presence_thread", { threadId: THREAD, excludeViewerId: "someone-else" }))
      .toMatchObject({ viewers: 1 });
    expect(await recentSenders()).toContain("- Alex Rivera (@alexgh): no time zone reported by their BB app.");
  });

  it("lists everyone in the directory with `bb identity time-zones`", async () => {
    await load();
    await heartbeat("alex@example.com", "America/Los_Angeles");
    const result = await host.harness.runCli(["time-zones"]);
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stdout).toBe([
      "Time zones reported by each person's BB app:",
      "- Alex Rivera (@alexgh): America/Los_Angeles, local time Wednesday 18 November 2026, 21:53 (UTC-8), reported 0s ago",
      "- Sam Chen (@samgh): no time zone reported by their BB app",
      "",
    ].join("\n"));
  });

  it("explains both subcommands when the CLI is used wrongly", async () => {
    await load();
    const result = await host.harness.runCli(["what"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("bb identity time-zones");
    expect(result.stderr).toContain("bb identity repair-starter");
  });
});
