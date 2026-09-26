import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { type MachineList, type PinResolution, type SettingsOverview, type SettingsWriteAnswer } from "./server.js";
import { AUDIT_JQ_COMMAND } from "./settings-admin.js";

/**
 * The settings section's server API, driven through the real plugin factory in bb's fake
 * host: schemas, settings writes, pins and audit lines all behave as they would on a
 * server. The loopback API is a stubbed `fetch`: the host list answers from `hosts`, and
 * the self-test probe fails fast.
 */

const KEY = Buffer.alloc(32, 7).toString("base64url");
const DIRECTORY = JSON.stringify([
  { person: "alex", github: "alexgh", displayName: "Alex Rivera", emails: ["alex@example.com"] },
  { person: "sam", github: "samgh", displayName: "Sam Chen", emails: ["sam@example.org"] },
]);
const EMAILS = ["alex@example.com", "sam@example.org"];

let hosts: Array<{ id: string; name: string }> = [];
let probeCalls = 0;
let host: ReturnType<typeof createFakePluginHost>;
/** The plugin's own settings handle, so a test can read what was stored. */
let stored: { get(): Promise<Record<string, unknown>>; experimental_set(values: Record<string, unknown>): Promise<unknown> };

async function load(settings: Record<string, string | boolean> = {}) {
  host = createFakePluginHost({
    pluginId: "identity",
    settings: { directory: DIRECTORY, teamMachines: "ew-lsp-001-main", selectionSigningKey: KEY, ...settings },
  });
  const define = vi.spyOn(host.bb.settings, "define");
  await plugin(host.bb);
  stored = define.mock.results[0]!.value as typeof stored;
  return host.harness;
}

const call = <T>(method: string, input: unknown = {}) => host.harness.callRpc(method, input) as Promise<T>;
const auditLines = (kind: string) => host.harness.logEntries
  .filter((entry) => entry.message.startsWith("identity-audit "))
  .map((entry) => JSON.parse(entry.message.slice("identity-audit ".length)) as Record<string, unknown>)
  .filter((line) => line.kind === kind);

beforeEach(() => {
  vi.useFakeTimers();
  hosts = [
    { id: "h1", name: "ew-lsp-001-main" },
    { id: "h2", name: "ew-lsp-001-alex" },
    { id: "h3", name: "ew-scratch-009" },
  ];
  probeCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/api/v1/hosts")) return new Response(JSON.stringify(hosts), { status: 200 });
    probeCalls += 1;
    return new Response("probe unavailable", { status: 503 });
  }));
});

afterEach(async () => {
  await host?.harness.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("identity_settings_overview", () => {
  it("answers the settings, the directory, the six readiness items and the audit command", async () => {
    await load();
    const overview = await call<SettingsOverview>("identity_settings_overview");
    expect(overview.settings).toEqual({
      teamMachines: "ew-lsp-001-main", sharedMachineUser: "ensembleworks-agent", enforcement: "off",
      fallbackEmail: "", selfSelectedIdentity: false, selectionPublicOrigin: "", signingKey: "valid",
    });
    expect(overview.directory).toEqual({ ok: true, error: null, people: 2 });
    expect(overview.firstRun).toBe(false);
    expect(overview.accessSeen).toBe(false);
    expect(overview.pickerStatus).toBe("off");
    expect(overview.selfTest).toBeNull();
    expect(overview.ledgers).toEqual({ starters: { count: 0, max: 2000 }, queued: { count: 0, max: 1000 } });
    expect(overview.conflicts).toBe(0);
    expect(overview.enforceRisks).toEqual([]);
    expect(overview.readiness.map((item) => item.id)).toEqual(["profile", "people", "machines", "browser", "guardrail", "check"]);
    expect(overview.lint.map((issue) => issue.id)).toEqual(["unclaimed-machines"]);
    expect(overview.auditCommand).toBe(AUDIT_JQ_COMMAND);
  });

  it("never carries the signing key", async () => {
    await load();
    expect(JSON.stringify(await call("identity_settings_overview"))).not.toContain(KEY);
  });

  it("calls a server with nobody registered and every setting at its default a first run", async () => {
    host = createFakePluginHost({ pluginId: "identity" });
    await plugin(host.bb);
    const overview = await call<SettingsOverview>("identity_settings_overview");
    expect(overview.firstRun).toBe(true);
    expect(overview.settings.signingKey).toBe("valid");
  });

  it("reports an invalid directory with its error", async () => {
    await load({ directory: "{not json" });
    const overview = await call<SettingsOverview>("identity_settings_overview");
    expect(overview.directory.ok).toBe(false);
    expect(overview.directory.error).toMatch(/not valid JSON/);
    expect(overview.firstRun).toBe(false);
  });
});

describe("identity_update_settings", () => {
  it("refuses to move into enforce without an acknowledgement, and writes nothing", async () => {
    await load();
    expect(await call("identity_update_settings", { enforcement: "enforce" }))
      .toEqual({ ok: false, reason: "enforce-needs-acknowledgement" });
    expect((await stored.get()).enforcement).toBe("off");
    expect(auditLines("settings.change")).toEqual([]);
  });

  it("refuses a fallback email without the sole-user confirmation", async () => {
    await load();
    expect(await call("identity_update_settings", { fallbackEmail: "me@example.com" }))
      .toEqual({ ok: false, reason: "fallback-needs-sole-user" });
    expect((await stored.get()).fallbackEmail).toBe("");
  });

  it("writes, re-applies at once and logs exactly one settings.change line", async () => {
    await load();
    expect((await call<MachineList>("identity_machines")).machines.find((entry) => entry.hostId === "h3")?.kind)
      .toBe("unclaimed");
    const answer = await call<SettingsWriteAnswer>("identity_update_settings",
      { teamMachines: "ew-lsp-001-main\new-scratch-009", enforcement: "enforce", acknowledgeEnforce: true });
    expect(answer).toEqual({ ok: true, changed: ["teamMachines", "enforcement"] });
    expect(await stored.get()).toMatchObject({ teamMachines: "ew-lsp-001-main\new-scratch-009", enforcement: "enforce" });
    const listed = await call<MachineList>("identity_machines");
    expect(listed.machines.find((entry) => entry.hostId === "h3")?.kind).toBe("team");
    expect(listed.enforcement).toBe("enforce");
    expect(auditLines("settings.change")).toEqual([expect.objectContaining({
      kind: "settings.change",
      mode: "enforce",
      by: null,
      provenance: "unknown",
      changes: [
        { key: "teamMachines", from: "ew-lsp-001-main", to: "ew-lsp-001-main\new-scratch-009" },
        { key: "enforcement", from: "off", to: "enforce" },
      ],
    })]);
  });

  it("writes and logs nothing when nothing would change", async () => {
    await load();
    const set = vi.spyOn(stored, "experimental_set");
    expect(await call("identity_update_settings", { enforcement: "off", teamMachines: " ew-lsp-001-main " }))
      .toEqual({ ok: true, changed: [] });
    expect(set).not.toHaveBeenCalled();
    expect(auditLines("settings.change")).toEqual([]);
  });

  it("rejects the directory and the signing key at the schema", async () => {
    await load();
    await expect(call("identity_update_settings", { directory: "[]" })).rejects.toThrow(/input validation failed/);
    await expect(call("identity_update_settings", { selectionSigningKey: "x" })).rejects.toThrow(/input validation failed/);
    expect((await stored.get()).directory).toBe(DIRECTORY);
    expect((await stored.get()).selectionSigningKey).toBe(KEY);
  });
});

describe("identity_rotate_signing_key", () => {
  it("stores a fresh key and logs the rotation without either key", async () => {
    await load();
    expect(await call("identity_rotate_signing_key", { confirm: "rotate" })).toEqual({ ok: true });
    const fresh = (await stored.get()).selectionSigningKey as string;
    expect(fresh).not.toBe(KEY);
    expect(Buffer.from(fresh, "base64url")).toHaveLength(32);
    expect((await call<SettingsOverview>("identity_settings_overview")).settings.signingKey).toBe("valid");
    expect(auditLines("settings.change")).toEqual([expect.objectContaining({
      changes: [{ key: "selectionSigningKey", from: "[secret]", to: "[rotated]" }],
    })]);
    const logged = host.harness.logEntries.map((entry) => entry.message).join("\n");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(fresh);
  });

  it("needs the typed word", async () => {
    await load();
    await expect(call("identity_rotate_signing_key", { confirm: "yes" })).rejects.toThrow(/input validation failed/);
    expect((await stored.get()).selectionSigningKey).toBe(KEY);
  });
});

describe("identity_resolve_pin", () => {
  /** h2 is pinned to Alex on first sight, then renamed for Sam: a conflict. */
  async function conflicted() {
    await load();
    await call("identity_machines");
    hosts = hosts.map((entry) => entry.id === "h2" ? { ...entry, name: "ew-lsp-001-sam" } : entry);
    vi.setSystemTime(Date.now() + 60_000);
    expect((await call<SettingsOverview>("identity_settings_overview")).conflicts).toBe(1);
  }

  it("keep silences the conflict under the current name", async () => {
    await conflicted();
    const answer = await call<PinResolution>("identity_resolve_pin", { hostId: "h2", action: "keep" });
    expect(answer).toEqual({ ok: true, machine: {
      kind: "person", hostId: "h2", hostName: "ew-lsp-001-sam",
      person: { person: "alex", displayName: "Alex Rivera", github: "alexgh" }, conflict: null,
    } });
    expect((await call<SettingsOverview>("identity_settings_overview")).conflicts).toBe(0);
    expect(auditLines("host.pin")).toEqual([expect.objectContaining({
      hostId: "h2", hostName: "ew-lsp-001-sam", action: "keep", from: "alex", to: "alex",
    })]);
  });

  it("repin with no person follows the name", async () => {
    await conflicted();
    const answer = await call<PinResolution>("identity_resolve_pin", { hostId: "h2", action: "repin" });
    expect(answer.ok && answer.machine?.kind === "person" && answer.machine.person.person).toBe("sam");
    expect(answer.ok && answer.machine?.conflict).toBeNull();
    expect(auditLines("host.pin")).toEqual([expect.objectContaining({ action: "repin", from: "alex", to: "sam" })]);
  });

  it("repin to a named directory person", async () => {
    await conflicted();
    const answer = await call<PinResolution>("identity_resolve_pin", { hostId: "h3", action: "repin", person: "sam" });
    expect(answer.ok && answer.machine?.kind === "person" && answer.machine.person.person).toBe("sam");
    expect(auditLines("host.pin")).toEqual([expect.objectContaining({ hostId: "h3", action: "repin", from: null, to: "sam" })]);
  });

  it("unpin forgets the pin and the machine re-derives from its name", async () => {
    await conflicted();
    const answer = await call<PinResolution>("identity_resolve_pin", { hostId: "h2", action: "unpin" });
    expect(answer.ok && answer.machine?.kind === "person" && answer.machine.person.person).toBe("sam");
    expect(answer.ok && answer.machine?.conflict).toBeNull();
    expect(auditLines("host.pin")).toEqual([expect.objectContaining({ action: "unpin", from: "alex", to: null })]);
  });

  it("names each refusal and logs nothing for it", async () => {
    await conflicted();
    expect(await call("identity_resolve_pin", { hostId: "nope", action: "keep" })).toEqual({ ok: false, reason: "unknown-host" });
    expect(await call("identity_resolve_pin", { hostId: "h3", action: "keep" })).toEqual({ ok: false, reason: "no-pin" });
    expect(await call("identity_resolve_pin", { hostId: "h3", action: "unpin" })).toEqual({ ok: false, reason: "no-pin" });
    expect(await call("identity_resolve_pin", { hostId: "h3", action: "repin" })).toEqual({ ok: false, reason: "no-person" });
    expect(await call("identity_resolve_pin", { hostId: "h2", action: "repin", person: "stranger" }))
      .toEqual({ ok: false, reason: "not-in-directory" });
    vi.spyOn(host.bb.storage.kv, "set").mockRejectedValue(new Error("kv down"));
    expect(await call("identity_resolve_pin", { hostId: "h2", action: "keep" })).toEqual({ ok: false, reason: "write-failed" });
    expect(auditLines("host.pin")).toEqual([]);
  });
});

describe("identity_rerun_self_test", () => {
  it("runs the self-test once now, cancels the pending boot run, and answers it", async () => {
    await load();
    const answer = await call<{ selfTest: { ok: boolean }; pickerStatus: string }>("identity_rerun_self_test");
    expect(answer.selfTest.ok).toBe(false);
    expect(answer.pickerStatus).toBe("off");
    expect(host.harness.logEntries.some((entry) => entry.message.includes("self-test FAILED"))).toBe(true);
    const once = probeCalls;
    expect(once).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probeCalls).toBe(once);
    expect((await call<SettingsOverview>("identity_settings_overview")).selfTest?.ok).toBe(false);
  });

  it("coalesces concurrent re-runs onto one", async () => {
    await load();
    await call("identity_rerun_self_test");
    const perRun = probeCalls;
    await Promise.all([call("identity_rerun_self_test"), call("identity_rerun_self_test")]);
    expect(probeCalls).toBe(perRun * 2);
  });
});

describe("identity_diagnostics", () => {
  it("answers a redacted support bundle", async () => {
    await load({ fallbackEmail: "alex@example.com" });
    const { text } = await call<{ text: string }>("identity_diagnostics");
    expect(JSON.parse(text)).toMatchObject({ plugin: "identity", fallbackEmail: "a***@example.com" });
    for (const email of EMAILS) expect(text).not.toContain(email);
    expect(text).not.toContain("Alex Rivera");
    expect(text).not.toContain(KEY);
  });
});
