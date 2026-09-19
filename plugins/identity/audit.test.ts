import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_LINE_PREFIX,
  AUDIT_SCHEMA_VERSION,
  ENFORCEMENT_MODES,
  RequestAuditor,
  dispatchAuditLine,
  emitAudit,
  formatAuditLine,
  normalizeAuditPath,
  parseEnforcement,
  postDispatchAuditLine,
  requestStreamChoice,
  type AuditLine,
} from "./audit.js";
import type { StarterSummary } from "./attribution.js";

const david: StarterSummary = { person: "mrdavidlaing", displayName: "David", github: "mrdavidlaing" };

describe("parseEnforcement", () => {
  it("accepts the three modes and nothing else", () => {
    expect(ENFORCEMENT_MODES).toEqual(["off", "audit", "enforce"]);
    for (const mode of ENFORCEMENT_MODES) expect(parseEnforcement(mode)).toBe(mode);
  });

  it("falls back to off for anything unrecognised, because the default must never enforce", () => {
    for (const value of ["", "ENFORCE", "true", undefined, "restrictStarts"]) {
      expect(parseEnforcement(value)).toBe("off");
    }
  });
});

describe("normalizeAuditPath", () => {
  it("drops the query string, which is where ids and free text hide", () => {
    expect(normalizeAuditPath("/api/v1/plugins/identity/http/thread-starter?threadId=thr_abc"))
      .toBe("/api/v1/plugins/identity/http/thread-starter");
  });

  it("collapses opaque ids so a path is a shape, not a cardinality explosion", () => {
    expect(normalizeAuditPath("/api/v1/threads/thr_01JABC/send")).toBe("/api/v1/threads/:id/send");
    expect(normalizeAuditPath("/api/v1/threads/thr_01JABC/queued-messages/qm_9/send"))
      .toBe("/api/v1/threads/:id/queued-messages/:id/send");
    expect(normalizeAuditPath("/api/v1/hosts/9f8e7d6c-1234-4abc-8def-0123456789ab"))
      .toBe("/api/v1/hosts/:id");
  });

  it("keeps the RPC method name, which is the whole point of an RPC path", () => {
    expect(normalizeAuditPath("/api/v1/plugins/identity/rpc/presence_heartbeat"))
      .toBe("/api/v1/plugins/identity/rpc/presence_heartbeat");
  });

  it("answers something honest for a request with no url at all", () => {
    expect(normalizeAuditPath(undefined)).toBe("(no url)");
  });
});

describe("requestStreamChoice — the volume policy", () => {
  it("gives a mutation its own line", () => {
    expect(requestStreamChoice("POST", "/api/v1/threads")).toBe("line");
    expect(requestStreamChoice("POST", "/api/v1/threads/:id/send")).toBe("line");
    expect(requestStreamChoice("DELETE", "/api/v1/threads/:id")).toBe("line");
  });

  it("rolls up reads, which are the bulk of the traffic and rarely the question", () => {
    expect(requestStreamChoice("GET", "/api/v1/threads")).toBe("rollup");
    expect(requestStreamChoice("GET", "/api/v1/hosts")).toBe("rollup");
  });

  it("rolls up Identity's own presence chatter, which fires every few seconds per tab", () => {
    for (const method of ["presence_heartbeat", "presence_typing", "presence_snapshot", "presence_thread", "presence_leave"]) {
      expect(requestStreamChoice("POST", `/api/v1/plugins/identity/rpc/${method}`)).toBe("rollup");
    }
  });

  it("rolls up Identity's own read RPCs, which the client polls over POST", () => {
    // The shipped BB client sends EVERY plugin RPC over POST, and app.tsx polls
    // identity_whoami every REFRESH_MS (5s) per open tab. "POST = mutation" therefore
    // turned our own read poll into ~12 individual lines a minute per tab and labelled it
    // a human action. A read is a read whatever verb carries it.
    for (const rpc of ["identity_whoami", "identity_thread_starter", "identity_thread_ownership", "identity_machines"]) {
      expect(requestStreamChoice("POST", `/api/v1/plugins/identity/rpc/${rpc}`)).toBe("rollup");
    }
  });

  it("rolls up the known high-frequency core polls too", () => {
    expect(requestStreamChoice("POST", "/api/v1/events")).toBe("rollup");
    expect(requestStreamChoice("POST", "/api/v1/plugins/canvas/rpc/canvas_presence")).toBe("rollup");
  });

  it("rolls up the host daemon's session chatter, which fires every few seconds with no browser at all", () => {
    // Measured on a throwaway bb (2026-09-18): with nothing open, this POST alone
    // produced four individual lines a minute. It is a daemon heartbeat, not an action.
    expect(requestStreamChoice("POST", "/internal/session/events")).toBe("rollup");
  });
});

describe("RequestAuditor", () => {
  const person = { person: "mrdavidlaing", displayName: "David", github: "mrdavidlaing" };

  function auditor(now: () => number, options: { rollupMs?: number; maxBuckets?: number } = {}) {
    const lines: Record<string, unknown>[] = [];
    return {
      lines,
      auditor: new RequestAuditor({ emit: (line) => lines.push(line), now, ...options }),
    };
  }

  it("logs a mutation as one line: method, path, header presence, person and request id", () => {
    const { lines, auditor: a } = auditor(() => 1_000);
    a.observe({ id: "r1", method: "POST", url: "/api/v1/threads?x=1", email: "david@example.com", person });
    expect(lines).toEqual([{
      v: AUDIT_SCHEMA_VERSION,
      kind: "request",
      at: 1_000,
      req: "r1",
      method: "POST",
      path: "/api/v1/threads",
      access: true,
      person: "mrdavidlaing",
    }]);
  });

  it("says plainly when a request carried no Access header and matched nobody", () => {
    const { lines, auditor: a } = auditor(() => 1_000);
    a.observe({ id: "r2", method: "POST", url: "/api/v1/threads", email: null, person: null });
    expect(lines[0]).toMatchObject({ access: false, person: null });
  });

  it("marks an email that matched nobody as identified-but-unknown, not as anonymous", () => {
    const { lines, auditor: a } = auditor(() => 1_000);
    a.observe({ id: "r3", method: "POST", url: "/api/v1/threads", email: "stranger@example.com", person: null });
    expect(lines[0]).toMatchObject({ access: true, person: null });
  });

  it("does not log a line per presence heartbeat — that is the flood the owner must not get", () => {
    const { lines, auditor: a } = auditor(() => 1_000);
    for (let i = 0; i < 50; i += 1) {
      a.observe({
        id: `r${i}`,
        method: "POST",
        url: "/api/v1/plugins/identity/rpc/presence_heartbeat",
        email: "david@example.com",
        person,
      });
    }
    expect(lines).toEqual([]);
  });

  it("counts the rolled-up traffic instead, one line per window, grouped by path and identity", () => {
    let now = 1_000;
    const { lines, auditor: a } = auditor(() => now, { rollupMs: 60_000 });
    for (let i = 0; i < 30; i += 1) {
      a.observe({ id: `r${i}`, method: "GET", url: "/api/v1/threads", email: "david@example.com", person });
    }
    a.observe({ id: "rx", method: "GET", url: "/api/v1/hosts", email: null, person: null });
    expect(lines).toEqual([]);
    now = 62_000;
    a.observe({ id: "last", method: "GET", url: "/api/v1/threads", email: null, person: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ v: AUDIT_SCHEMA_VERSION, kind: "request.rollup", at: 62_000, from: 1_000, total: 31 });
    expect(lines[0]?.buckets).toEqual([
      { method: "GET", path: "/api/v1/threads", access: true, person: "mrdavidlaing", count: 30 },
      { method: "GET", path: "/api/v1/hosts", access: false, person: null, count: 1 },
    ]);
  });

  it("flushes on demand, so a quiet server still reports its window", () => {
    let now = 1_000;
    const { lines, auditor: a } = auditor(() => now);
    a.observe({ id: "r1", method: "GET", url: "/api/v1/threads", email: null, person: null });
    now = 5_000;
    a.flush();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "request.rollup", total: 1 });
    a.flush();
    expect(lines).toHaveLength(1);
  });

  it("caps the buckets it carries, so a path-fuzzing caller cannot grow the line unbounded", () => {
    let now = 1_000;
    const { lines, auditor: a } = auditor(() => now, { maxBuckets: 3 });
    for (let i = 0; i < 25; i += 1) {
      a.observe({ id: `r${i}`, method: "GET", url: `/api/v1/threads/thr_${i}/x${i}`, email: null, person: null });
    }
    now = 62_000;
    a.flush();
    const line = lines[0] as { buckets: unknown[]; total: number; dropped: number };
    expect(line.buckets).toHaveLength(3);
    expect(line.total).toBe(25);
    expect(line.dropped).toBeGreaterThan(0);
  });
});

describe("dispatchAuditLine", () => {
  const base = {
    requestId: "r1",
    requestMethod: "POST",
    requestPath: "/api/v1/threads",
    mode: "audit" as const,
    at: 2_000,
    facts: {
      threadId: "thr_new",
      email: "david@example.com",
      person: david,
      viaFallback: false,
      origin: "app" as const,
      originPluginId: null,
      lineage: ["thr_parent"],
      host: { id: "h2", name: "ew-lsp-001-mattwynne" },
      now: 2_000,
    },
    hostKind: "person" as const,
    recordedStarter: null,
    verdict: {
      action: "reject" as const,
      rule: "start-on-another-persons-machine" as const,
      message: "ew-lsp-001-mattwynne is Matt's machine.",
    },
    action: "proceed" as const,
    via: "browser" as const,
    starter: david,
  };

  it("carries the attribution facts, the verdict and the action actually returned", () => {
    expect(dispatchAuditLine(base)).toEqual({
      v: AUDIT_SCHEMA_VERSION,
      kind: "dispatch",
      at: 2_000,
      req: "r1",
      method: "POST",
      path: "/api/v1/threads",
      mode: "audit",
      threadId: "thr_new",
      email: "david@example.com",
      person: "mrdavidlaing",
      viaFallback: false,
      origin: "app",
      originPluginId: null,
      lineage: ["thr_parent"],
      host: { id: "h2", name: "ew-lsp-001-mattwynne", kind: "person" },
      recordedStarter: null,
      starter: "mrdavidlaing",
      via: "browser",
      verdict: "reject",
      rule: "start-on-another-persons-machine",
      refusal: "ew-lsp-001-mattwynne is Matt's machine.",
      action: "proceed",
    });
  });

  it("says proceed/null for a dispatch no rule fired on", () => {
    const line = dispatchAuditLine({ ...base, verdict: { action: "proceed" }, action: "proceed" });
    expect(line).toMatchObject({ verdict: "proceed", rule: null, refusal: null, action: "proceed" });
  });

  it("never carries message text or thread content — identity facts only", () => {
    const serialized = JSON.stringify(dispatchAuditLine(base));
    expect(serialized).not.toContain("input");
    expect(serialized).not.toContain("text");
  });
});

describe("postDispatchAuditLine", () => {
  it("records what identity a queued row's event ran in", () => {
    expect(postDispatchAuditLine({
      kind: "message.queued",
      at: 3_000,
      requestId: "r7",
      requestMethod: "POST",
      requestPath: "/api/v1/threads/:id/send",
      mode: "enforce",
      entryId: "qm_1",
      threadId: "thr_1",
      senderThreadId: "thr_0",
      email: "david@example.com",
      person: david,
    })).toEqual({
      v: AUDIT_SCHEMA_VERSION,
      kind: "message.queued",
      at: 3_000,
      req: "r7",
      method: "POST",
      path: "/api/v1/threads/:id/send",
      mode: "enforce",
      entryId: "qm_1",
      threadId: "thr_1",
      senderThreadId: "thr_0",
      access: true,
      email: "david@example.com",
      person: "mrdavidlaing",
    });
  });

  it("is honest about an event that ran in no request at all (a drain)", () => {
    const line = postDispatchAuditLine({
      kind: "message.dispatched",
      at: 3_000,
      requestId: null,
      requestMethod: null,
      requestPath: null,
      mode: "audit",
      entryId: "qm_2",
      threadId: "thr_1",
      senderThreadId: null,
      email: null,
      person: null,
    });
    expect(line).toMatchObject({ req: null, method: null, path: null, access: false, email: null, person: null });
  });
});

describe("formatAuditLine / emitAudit", () => {
  it("is one prefixed JSON object per line, so `bb plugin logs identity` can be piped to jq", () => {
    const text = formatAuditLine({ v: 1, kind: "request", at: 1 });
    expect(text.startsWith(`${AUDIT_LINE_PREFIX} `)).toBe(true);
    expect(text).not.toContain("\n");
    expect(JSON.parse(text.slice(AUDIT_LINE_PREFIX.length + 1))).toEqual({ v: 1, kind: "request", at: 1 });
  });

  it("swallows a broken sink: logging may never throw into the dispatch hook", () => {
    const sink = vi.fn(() => {
      throw new Error("log is broken");
    });
    expect(() => emitAudit(sink, { v: 1, kind: "request", at: 1 })).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("survives a value JSON cannot serialize, rather than failing the caller", () => {
    const cyclic: AuditLine = { v: 1, kind: "request", at: 1 };
    cyclic.self = cyclic;
    const sink = vi.fn();
    expect(() => emitAudit(sink, cyclic)).not.toThrow();
  });
});
