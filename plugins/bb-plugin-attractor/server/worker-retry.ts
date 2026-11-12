/**
 * When a worker thread's turn fails for a reason that will pass by itself —
 * the account's usage window is spent, the provider is overloaded or briefly
 * unreachable — the stage should wait and continue the same worker, not fail.
 * This is the policy that decides which failures those are and when to try
 * again. It mirrors bb's own provider-retry plugin (which Attractor declines
 * for its workers, see server.ts's `provider-retry.v1.consent` handler) so a
 * worker waits exactly as long as an ordinary thread would.
 *
 * Pure module: no BB imports beyond types, no I/O, no clock, no randomness.
 */

import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";

export const RESET_BUFFER_MS = 15_000;
export const RESET_JITTER_MS = 30_000;
export const MAXIMUM_WAIT_MS = 6 * 60 * 60 * 1_000;
export const OVERLOAD_RETRY_BASE_MS = 5_000;
export const UNAVAILABLE_RETRY_BASE_MS = 60_000;
/** The original attempt plus four retries. */
export const MAX_ATTEMPTS = 5;

export type WorkerRetryReason = "Rate limited" | "Provider overloaded" | "Provider unavailable";

export type WorkerRetryDecision =
  | { kind: "retry"; sendAt: number; reason: WorkerRetryReason }
  | { kind: "fail"; why: "not-retryable" | "attempts-exhausted" | "no-reset-time" | "beyond-maximum-wait" };

const UNAVAILABLE_CATEGORIES = new Set(["connection-failed", "internal", "stream-disconnected"]);
const UNAVAILABLE_HTTP_STATUS_CODES = new Set([500, 502, 503, 504]);

function backoff(baseMs: number, attemptNumber: number, now: number, random: number): number {
  const delay = baseMs * 2 ** (attemptNumber - 1);
  return now + delay + Math.floor(random * delay);
}

/** The latest reset among the blocked windows (or among all of them when none is marked blocked); null when no window reports one. */
function resetAtMs(rateLimits: NonNullable<PluginTurnFailedEvent["rateLimits"]>): number | null {
  const blocked = rateLimits.windows.filter((window) => window.status === "blocked");
  const relevant = blocked.length > 0 ? blocked : rateLimits.windows;
  const resets = relevant.flatMap((window) => (window.resetsAtMs === null ? [] : [window.resetsAtMs]));
  return resets.length === 0 ? null : Math.max(...resets);
}

export function decideWorkerRetry(failure: PluginTurnFailedEvent, now: number, random: number): WorkerRetryDecision {
  if (failure.attemptNumber >= MAX_ATTEMPTS) return { kind: "fail", why: "attempts-exhausted" };
  const info = failure.errorInfo;
  if (info === null) return { kind: "fail", why: "not-retryable" };

  if (info.category === "overloaded") {
    return { kind: "retry", sendAt: backoff(OVERLOAD_RETRY_BASE_MS, failure.attemptNumber, now, random), reason: "Provider overloaded" };
  }

  if (info.category === "rate-limit" || info.httpStatusCode === 429) {
    // Only a subscription window with a known reset is worth waiting for: a
    // spent credit balance or spend cap does not come back by itself.
    const rateLimits = failure.rateLimits;
    const resetsAt = rateLimits !== null && rateLimits.kind === "subscription-window" ? resetAtMs(rateLimits) : null;
    if (resetsAt === null) return { kind: "fail", why: "no-reset-time" };
    if (resetsAt - now > MAXIMUM_WAIT_MS) return { kind: "fail", why: "beyond-maximum-wait" };
    return { kind: "retry", sendAt: Math.max(resetsAt, now) + RESET_BUFFER_MS + Math.floor(random * RESET_JITTER_MS), reason: "Rate limited" };
  }

  if (UNAVAILABLE_CATEGORIES.has(info.category) || (info.httpStatusCode !== null && UNAVAILABLE_HTTP_STATUS_CODES.has(info.httpStatusCode))) {
    return { kind: "retry", sendAt: backoff(UNAVAILABLE_RETRY_BASE_MS, failure.attemptNumber, now, random), reason: "Provider unavailable" };
  }

  return { kind: "fail", why: "not-retryable" };
}

/** The stage's waiting reason while a retry is queued, e.g. "Rate limited, retrying at 2026-11-12 20:20 UTC". */
export function describeWorkerRetry(reason: WorkerRetryReason, sendAt: number): string {
  const when = new Date(sendAt).toISOString();
  return `${reason}, retrying at ${when.slice(0, 10)} ${when.slice(11, 16)} UTC`;
}
