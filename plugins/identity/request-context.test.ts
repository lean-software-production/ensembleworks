import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installRequestContext } from "./request-context.js";

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
