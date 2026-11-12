import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { decideWorkerRetry, describeWorkerRetry, MAXIMUM_WAIT_MS } from "../../server/worker-retry";

const NOW = Date.UTC(2026, 10, 12, 18, 41);
const RESET = Date.UTC(2026, 10, 12, 20, 20);

type Category = NonNullable<PluginTurnFailedEvent["errorInfo"]>["category"];

function failure(overrides: Partial<PluginTurnFailedEvent> & { category?: Category; httpStatusCode?: number | null } = {}): PluginTurnFailedEvent {
  const { category = "rate-limit", httpStatusCode = null, ...rest } = overrides;
  return {
    threadId: "worker-thread",
    requestId: "req-1",
    turnId: null,
    errorInfo: { category, httpStatusCode, providerCode: null },
    inputAccepted: false,
    rateLimits: null,
    attemptNumber: 1,
    ...rest,
  };
}

function window(resetsAtMs: number | null, kind: "subscription-window" | "credits" = "subscription-window"): PluginTurnFailedEvent["rateLimits"] {
  return {
    kind,
    overageReason: null,
    overageStatus: null,
    providerId: "claude-code",
    reachedReason: null,
    status: "blocked",
    windows: [
      { label: "5-hour", providerKey: null, resetsAtMs, status: "blocked" },
      { label: "weekly", providerKey: null, resetsAtMs: RESET + 86_400_000, status: "allowed" },
    ],
  };
}

describe("server/worker-retry: decideWorkerRetry", () => {
  it("waits for a spent subscription window to reopen, plus a buffer", () => {
    expect(decideWorkerRetry(failure({ rateLimits: window(RESET) }), NOW, 0)).toEqual({ kind: "retry", sendAt: RESET + 15_000, reason: "Rate limited" });
    expect(decideWorkerRetry(failure({ rateLimits: window(RESET) }), NOW, 0.5)).toEqual({ kind: "retry", sendAt: RESET + 30_000, reason: "Rate limited" });
  });

  it("treats a bare HTTP 429 as a rate limit", () => {
    expect(decideWorkerRetry(failure({ category: "unknown", httpStatusCode: 429, rateLimits: window(RESET) }), NOW, 0).kind).toBe("retry");
  });

  it("fails a rate limit that will not clear by itself or has no known reset", () => {
    expect(decideWorkerRetry(failure({ rateLimits: null }), NOW, 0)).toEqual({ kind: "fail", why: "no-reset-time" });
    expect(decideWorkerRetry(failure({ rateLimits: window(null) }), NOW, 0)).toEqual({ kind: "fail", why: "no-reset-time" });
    expect(decideWorkerRetry(failure({ rateLimits: window(RESET, "credits") }), NOW, 0)).toEqual({ kind: "fail", why: "no-reset-time" });
  });

  it("fails a reset further away than the maximum wait", () => {
    expect(decideWorkerRetry(failure({ rateLimits: window(NOW + MAXIMUM_WAIT_MS + 1) }), NOW, 0)).toEqual({ kind: "fail", why: "beyond-maximum-wait" });
  });

  it("backs off, doubling per attempt, for an overloaded or unreachable provider", () => {
    expect(decideWorkerRetry(failure({ category: "overloaded" }), NOW, 0)).toEqual({ kind: "retry", sendAt: NOW + 5_000, reason: "Provider overloaded" });
    expect(decideWorkerRetry(failure({ category: "overloaded", attemptNumber: 3 }), NOW, 0)).toEqual({ kind: "retry", sendAt: NOW + 20_000, reason: "Provider overloaded" });
    expect(decideWorkerRetry(failure({ category: "stream-disconnected" }), NOW, 0)).toEqual({ kind: "retry", sendAt: NOW + 60_000, reason: "Provider unavailable" });
    expect(decideWorkerRetry(failure({ category: "unknown", httpStatusCode: 503, attemptNumber: 2 }), NOW, 0)).toEqual({ kind: "retry", sendAt: NOW + 120_000, reason: "Provider unavailable" });
  });

  it("fails everything else: real errors, unclassified failures, and a fifth failed attempt", () => {
    expect(decideWorkerRetry(failure({ category: "context-window-exceeded" }), NOW, 0)).toEqual({ kind: "fail", why: "not-retryable" });
    expect(decideWorkerRetry(failure({ category: "unauthorized" }), NOW, 0)).toEqual({ kind: "fail", why: "not-retryable" });
    expect(decideWorkerRetry({ ...failure(), errorInfo: null }, NOW, 0)).toEqual({ kind: "fail", why: "not-retryable" });
    expect(decideWorkerRetry(failure({ rateLimits: window(RESET), attemptNumber: 5 }), NOW, 0)).toEqual({ kind: "fail", why: "attempts-exhausted" });
  });
});

describe("server/worker-retry: describeWorkerRetry", () => {
  it("names the reason and the retry time", () => {
    expect(describeWorkerRetry("Rate limited", RESET + 15_000)).toBe("Rate limited, retrying at 2026-11-12 20:20 UTC");
  });
});
