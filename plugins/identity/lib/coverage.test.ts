import { describe, expect, it } from "vitest";
import { COVERAGE_ROWS } from "./coverage.js";

describe("COVERAGE_ROWS", () => {
  it("lists the seven paths in order, each with its status", () => {
    expect(COVERAGE_ROWS.map((row) => [row.path, row.status])).toEqual([
      ["Composer send (new thread or follow-up)", "checked"],
      ["Send now (queued message)", "seen-after"],
      ["Automation spawning a thread (threads.spawn)", "checked"],
      ["Automation sending into an existing thread (threads.send)", "blind"],
      ["Agents and the CLI (no Access header)", "checked"],
      ["Terminals, Stop, Archive, approvals, host routes, plugin RPCs", "logged-only"],
      ["Raw API calls with an Access header", "checked"],
    ]);
  });

  it("says why threads.send is blind and what Send now needs", () => {
    const send = COVERAGE_ROWS.find((row) => row.path.includes("threads.send"))!;
    expect(send.status).toBe("blind");
    expect(send.note).toBe("Arrives unstamped, so rule C cannot see it. Needs BB core to stamp threads.send.");
    const sendNow = COVERAGE_ROWS.find((row) => row.path === "Send now (queued message)")!;
    expect(sendNow.status).toBe("seen-after");
    expect(sendNow.note).toBe("Skips the dispatch hook; Identity records the requester afterwards. "
      + "A Send-now dispatch hook in BB core would move this to Checked.");
  });

  it("carries the exact note for every row", () => {
    expect(COVERAGE_ROWS.map((row) => row.note)).toEqual([
      "The dispatch hook sees it and the guardrail can refuse it.",
      "Skips the dispatch hook; Identity records the requester afterwards. A Send-now dispatch hook in BB core would move this to Checked.",
      "Rule C applies to stamped automation spawns.",
      "Arrives unstamped, so rule C cannot see it. Needs BB core to stamp threads.send.",
      "Always allowed: no identity means nothing to refuse. Attributed to the fallback email when one is set.",
      "Seen by the request stream in audit/enforce modes; never refused.",
      "Same hook as the composer.",
    ]);
  });
});
