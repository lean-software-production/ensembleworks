import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installRequestContext, selfTestRequestContext } from "./request-context.js";

const context = installRequestContext();
let server: http.Server;
let baseUrl: string;
let releaseGate: () => void = () => undefined;
let gate: Promise<void> = Promise.resolve();

beforeAll(async () => {
  server = http.createServer(async (_req, res) => {
    // Every request awaits the same shared promise chain before reading its context,
    // so the store must survive async hops and interleaving.
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 1));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(context.current() ?? null));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function get(path: string, headers: Record<string, string> = {}): Promise<unknown> {
  return fetch(`${baseUrl}${path}`, { headers }).then((response) => response.json());
}

describe("installRequestContext", () => {
  it("gives concurrent requests their own email across a shared await", async () => {
    gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const emails = ["Matt@Example.com", "david@example.com", " trevoke@example.com "];
    const pending = emails.map((email, index) =>
      get(`/r${index}`, { "cf-access-authenticated-user-email": email }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseGate();
    const results = await Promise.all(pending);
    expect(results).toEqual([
      { email: "matt@example.com", method: "GET", url: "/r0" },
      { email: "david@example.com", method: "GET", url: "/r1" },
      { email: "trevoke@example.com", method: "GET", url: "/r2" },
    ]);
  });

  it("records a null email when the header is absent or empty", async () => {
    gate = Promise.resolve();
    expect(await get("/none")).toEqual({ email: null, method: "GET", url: "/none" });
    expect(await get("/empty", { "cf-access-authenticated-user-email": "  " }))
      .toMatchObject({ email: null });
  });

  it("has no context outside a request", () => {
    expect(context.current()).toBeUndefined();
  });

  it("installs once per process and never double-wraps emit", async () => {
    const emitAfterFirst = http.Server.prototype.emit;
    const second = installRequestContext();
    expect(second).toBe(context);
    expect(http.Server.prototype.emit).toBe(emitAfterFirst);
    gate = Promise.resolve();
    expect(await get("/again", { "cf-access-authenticated-user-email": "x@y.z" }))
      .toEqual({ email: "x@y.z", method: "GET", url: "/again" });
  });
});

describe("selfTestRequestContext", () => {
  it("passes when the patch is live and the store reaches the handler", async () => {
    gate = Promise.resolve();
    const result = await selfTestRequestContext(context, { probe: (headers) => get("/self-test", headers) });
    expect(result).toEqual({ ok: true, detail: "request context is live (probe saw its own tagged email)" });
  });

  it("fails, without throwing, when the live emit patch is not ours", async () => {
    const patched = http.Server.prototype.emit;
    http.Server.prototype.emit = function unpatched(this: http.Server, ...args: unknown[]) {
      return (patched as (...a: unknown[]) => boolean).apply(this, args);
    } as typeof http.Server.prototype.emit;
    try {
      const result = await selfTestRequestContext(context, { probe: (headers) => get("/self-test", headers) });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/http\.Server\.prototype\.emit/);
    } finally {
      http.Server.prototype.emit = patched;
    }
  });

  it("fails, without throwing, when the probe cannot reach the server", async () => {
    const result = await selfTestRequestContext(context, { probe: () => Promise.reject(new Error("econnrefused")) });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/econnrefused/);
  });

  it("fails when the probe returns an unexpected email", async () => {
    const result = await selfTestRequestContext(context, { probe: () => Promise.resolve({ email: "someone@else" }) });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/someone@else/);
  });

  it("leaves the patch installed — it never restores emit", async () => {
    const before = http.Server.prototype.emit;
    await selfTestRequestContext(context, { probe: (headers) => get("/self-test", headers) });
    expect(http.Server.prototype.emit).toBe(before);
  });
});
