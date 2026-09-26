import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ACCESS_EMAIL_HEADER, SELF_TEST_COOKIE, SELF_TEST_EMAIL } from "./request-context.js";
import { mintSelection, selectionCookieName } from "./selection.js";
import plugin, { type MachineList, type PinResolution, type SettingsOverview, type SettingsWriteAnswer } from "./server.js";
import { AUDIT_JQ_COMMAND } from "./settings-admin.js";

/**
 * The settings section's server API, driven through the real plugin factory in bb's fake
 * host: schemas, settings writes, pins and audit lines all behave as they would on a
 * server. The loopback API is a stubbed `fetch`: the host list answers from `hosts`, and
 * the self-test probe answers through `probe`, which fails fast unless a test swaps it.
 */

const KEY = Buffer.alloc(32, 7).toString("base64url");
const DIRECTORY = JSON.stringify([
  { person: "alex", github: "alexgh", displayName: "Alex Rivera", emails: ["alex@example.com"] },
  { person: "sam", github: "samgh", displayName: "Sam Chen", emails: ["sam@example.org"] },
]);
const EMAILS = ["alex@example.com", "sam@example.org"];

let hosts: Array<{ id: string; name: string }> = [];
let probeCalls = 0;
type ProbeAnswer = { ok: boolean; json(): Promise<unknown> };
const probeFails = async (): Promise<ProbeAnswer> => new Response("probe unavailable", { status: 503 });
/** A live request context: the probe reads back the tagged email and the named cookie. */
const probeEchoes = async (headers: Record<string, string>): Promise<ProbeAnswer> => ({
  ok: true,
  json: async () => headers[ACCESS_EMAIL_HEADER] === SELF_TEST_EMAIL ? { email: SELF_TEST_EMAIL } : { selection: SELF_TEST_COOKIE },
});
let probe: (headers: Record<string, string>) => Promise<ProbeAnswer> = probeFails;
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
/** Run `work` inside the request context of an http request carrying `headers`. */
const asRequest = <T>(headers: Record<string, string>, work: () => Promise<T>) => new Promise<T>((resolve, reject) => {
  const server = new http.Server();
  server.on("request", () => { work().then(resolve, reject); });
  server.emit("request", { headers, method: "POST", url: "/api/v1/plugins/identity/rpc" }, undefined);
});
const ORIGIN = "https://bb.example.com";
/** A server with the picker ready, and the headers of a browser that selected Alex on it. */
async function alexSelected() {
  probe = probeEchoes;
  await load({ selfSelectedIdentity: true, selectionPublicOrigin: ORIGIN });
  expect((await call<{ pickerStatus: string }>("identity_rerun_self_test")).pickerStatus).toBe("ready");
  return { cookie: `${selectionCookieName(ORIGIN)}=${mintSelection("alex", ORIGIN, Buffer.from(KEY, "base64url"))}` };
}
/** From the next write on, every settings read fails: the write lands, the refresh does not. */
function failReadsAfterWrite() {
  const write = stored.experimental_set.bind(stored);
  vi.spyOn(stored, "experimental_set").mockImplementation(async (values) => {
    const written = await write(values);
    vi.spyOn(stored, "get").mockRejectedValue(new Error("settings store down"));
    return written;
  });
}
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
  probe = probeFails;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    if (url.endsWith("/api/v1/hosts")) return new Response(JSON.stringify(hosts), { status: 200 });
    probeCalls += 1;
    return await probe(init?.headers ?? {});
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

  it("names the caller as they were before the write, not as the new fallback makes them", async () => {
    await load();
    expect(await call("identity_update_settings", { fallbackEmail: "alex@example.com", confirmSoleUser: true }))
      .toEqual({ ok: true, changed: ["fallbackEmail"] });
    expect((await call<{ person: unknown }>("identity_whoami")).person).toMatchObject({ person: "alex" });
    expect(auditLines("settings.change")).toEqual([expect.objectContaining({ by: null, provenance: "unknown" })]);
  });

  it("still logs a committed write when re-reading the settings afterwards fails", async () => {
    await load();
    failReadsAfterWrite();
    expect(await call("identity_update_settings", { enforcement: "audit" })).toEqual({ ok: true, changed: ["enforcement"] });
    expect(auditLines("settings.change")).toEqual([expect.objectContaining({
      mode: "audit", changes: [{ key: "enforcement", from: "off", to: "audit" }],
    })]);
    expect(host.harness.logEntries.some((entry) => entry.message.includes("settings store down"))).toBe(true);
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

  it("names the browser that asked, though rotating expires its own selection", async () => {
    const headers = await alexSelected();
    expect((await asRequest(headers, () => call<{ person: unknown }>("identity_whoami"))).person)
      .toMatchObject({ person: "alex" });
    expect(await asRequest(headers, () => call("identity_rotate_signing_key", { confirm: "rotate" }))).toEqual({ ok: true });
    expect((await asRequest(headers, () => call<{ person: unknown }>("identity_whoami"))).person).toBeNull();
    expect(auditLines("settings.change")).toEqual([expect.objectContaining({
      by: "alex", provenance: "self-selected",
    })]);
  });

  it("still logs the rotation when re-reading the settings afterwards fails", async () => {
    await load();
    failReadsAfterWrite();
    expect(await call("identity_rotate_signing_key", { confirm: "rotate" })).toEqual({ ok: true });
    expect(auditLines("settings.change")).toEqual([expect.objectContaining({
      changes: [{ key: "selectionSigningKey", from: "[secret]", to: "[rotated]" }],
    })]);
    expect(host.harness.logEntries.some((entry) => entry.message.includes("settings store down"))).toBe(true);
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

  it("supersedes a boot run still in flight: one run, and the re-run's result wins", async () => {
    const pending: Array<{ headers: Record<string, string>; answer(value: ProbeAnswer): void }> = [];
    probe = (headers) => new Promise((answer) => pending.push({ headers, answer }));
    const settle = async (count: number) => {
      for (let turn = 0; turn < 50 && pending.length < count; turn += 1) await Promise.resolve();
      expect(pending).toHaveLength(count);
    };
    await load({ selfSelectedIdentity: true, selectionPublicOrigin: ORIGIN });
    await vi.advanceTimersByTimeAsync(500);
    await settle(1);
    const rerun = call<{ selfTest: { ok: boolean }; pickerStatus: string }>("identity_rerun_self_test");
    await settle(2);
    pending[1]!.answer(await probeEchoes(pending[1]!.headers));
    await settle(3);
    pending[2]!.answer(await probeEchoes(pending[2]!.headers));
    expect(await rerun).toMatchObject({ selfTest: { ok: true }, pickerStatus: "ready" });
    pending[0]!.answer(await probeFails());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pending).toHaveLength(3);
    expect((await call<SettingsOverview>("identity_settings_overview")).selfTest?.ok).toBe(true);
    expect(host.harness.logEntries.some((entry) => entry.message.includes("self-test FAILED"))).toBe(false);
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
  it("keeps a malformed directory's text out of the bundle", async () => {
    await load({ directory: "Alex Rivera <alex@example.com>" });
    const { text } = await call<{ text: string }>("identity_diagnostics");
    expect(JSON.parse(text).directory).toMatchObject({ ok: false, error: "directory is not valid JSON" });
    expect(text).not.toContain("Alex Rivera");
    expect(text).not.toContain("alex@example.com");
  });

  // The generated Configuration form stores free text unvalidated, so every such setting
  // can carry an email or a display name; none may reach the bundle, whichever field.
  const malformed = {
    teamMachines: "ew-lsp-001-main\nAlex Rivera <alex@example.com>\nRobin\nrobin@example.net",
    sharedMachineUser: "Alex Rivera <alex@example.com>",
    fallbackEmail: "alex@example.com, Alex Rivera",
    selectionPublicOrigin: "https://Alex Rivera@alex@example.com",
    enforcement: "Alex Rivera <alex@example.com>",
    selfSelectedIdentity: "Alex Rivera alex@example.com" as unknown as boolean,
  };

  it("keeps every malformed free-text setting's email and display name out of the bundle", async () => {
    const directory = JSON.stringify([
      { person: "alex", github: "alexgh", displayName: "Alex Rivera", emails: ["alex@example.com"] },
      { person: "robin", github: "robingh", displayName: "Robin", emails: ["robin@example.net"] },
    ]);
    hosts = [{ id: "h1", name: "ew-lsp-001-main" }, { id: "h9", name: "Robin alex@example.com" }];
    await load({ ...malformed, directory });
    probe = async () => { throw new Error("probe saw Alex Rivera <alex@example.com> and Robin"); };
    await call("identity_rerun_self_test");
    const { text } = await call<{ text: string }>("identity_diagnostics");
    for (const leak of ["alex@example.com", "robin@example.net", "Alex Rivera", "Robin"]) expect(text).not.toContain(leak);
    expect(JSON.parse(text)).toMatchObject({
      sharedMachineUser: "invalid",
      fallbackEmail: "invalid",
      picker: { origin: "invalid", enabled: false },
      enforcement: "off",
      // "Robin" is a well-formed host name, but also a configured display name.
      teamMachines: ["ew-lsp-001-main", "invalid", "[redacted]", "invalid"],
      selfTest: { ok: false, detail: "the self-test probe failed: probe saw [redacted] <a***@example.com> and [redacted]" },
    });
  });

  it("keeps the malformed settings out when the directory is malformed too", async () => {
    await load({ ...malformed, directory: "Alex Rivera <alex@example.com>" });
    const { text } = await call<{ text: string }>("identity_diagnostics");
    for (const leak of ["alex@example.com", "robin@example.net", "Alex Rivera"]) expect(text).not.toContain(leak);
    expect(JSON.parse(text)).toMatchObject({ sharedMachineUser: "invalid", fallbackEmail: "invalid",
      teamMachines: ["ew-lsp-001-main", "invalid", "Robin", "invalid"] });
  });
});

describe("generated Configuration form copy", () => {
  async function descriptions() {
    host = createFakePluginHost({ pluginId: "identity", settings: { directory: DIRECTORY } });
    const define = vi.spyOn(host.bb.settings, "define");
    await plugin(host.bb);
    const schema = define.mock.calls[0]![0] as Record<string, { description?: string }>;
    return (key: string) => schema[key]!.description ?? "";
  }

  // Precedence: Access → valid browser name → fallback → anonymous; a bad name never falls through.
  it("says when Fallback email applies and that a stale browser name stays anonymous", async () => {
    const fallback = (await descriptions())("fallbackEmail");
    expect(fallback).not.toMatch(/Every header-less caller|every caller without/i);
    expect(fallback).toMatch(/no Cloudflare Access header and no valid browser name/);
    expect(fallback).toMatch(/stale, expired or invalid browser name stays anonymous/);
  });

  // Audit lines for settings, pins and colours are written whatever the enforcement mode.
  it("says Off still writes change audit lines", async () => {
    const enforcement = (await descriptions())("enforcement");
    expect(enforcement).not.toMatch(/off logs nothing/);
    expect(enforcement).toMatch(/off logs no verdicts/);
    expect(enforcement).toMatch(/settings, pin and colour changes are logged in every mode/);
  });
});
