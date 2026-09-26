import { describe, expect, it } from "vitest";
import { COVERAGE_ROWS } from "./coverage.js";

describe("COVERAGE_ROWS", () => {
  it("lists the seven paths in order, each with its status", () => {
    expect(COVERAGE_ROWS.map((row) => [row.path, row.status])).toEqual([
      ["Composer send (new thread or follow-up)", "checked"],
      ["Send now (queued message)", "seen-after"],
      ["Automation spawning a thread (threads.spawn)", "checked"],
      ["Automation sending into an existing thread (threads.send)", "blind"],
      ["Agents and the CLI sending a message (no Access header)", "checked"],
      ["Terminals, Stop, Archive, approvals, host routes, plugin RPCs", "logged-only"],
      ["Raw API message sends with an Access header", "checked"],
    ]);
  });

  it("says why threads.send is blind and what Send now needs", () => {
    const send = COVERAGE_ROWS.find((row) => row.path.includes("threads.send"))!;
    expect(send.status).toBe("blind");
    expect(send.note).toBe("Arrives unstamped, so the automation rule cannot see it. Needs BB core to stamp threads.send.");
    const sendNow = COVERAGE_ROWS.find((row) => row.path === "Send now (queued message)")!;
    expect(sendNow.status).toBe("seen-after");
    expect(sendNow.note).toBe("Skips the dispatch hook; in audit and enforce modes Identity logs it afterwards, naming the sender when it can. "
      + "A Send-now dispatch hook in BB core would move this to Checked.");
  });

  it("says Send now is logged afterwards only in audit and enforce modes", () => {
    // server.ts emits the post-dispatch line only when auditing(); Off writes nothing and the
    // queued-requester entry is dropped after dispatch.
    const sendNow = COVERAGE_ROWS.find((row) => row.path === "Send now (queued message)")!;
    expect(sendNow.note).not.toContain("records the requester");
    expect(sendNow.note).toContain("in audit and enforce modes Identity logs it afterwards");
  });

  it("carries the exact note for every row", () => {
    expect(COVERAGE_ROWS.map((row) => row.note)).toEqual([
      "The dispatch hook sees it and the guardrail can refuse it.",
      "Skips the dispatch hook; in audit and enforce modes Identity logs it afterwards, naming the sender when it can. A Send-now dispatch hook in BB core would move this to Checked.",
      "The automation rule applies to stamped automation spawns headed for a named machine; a spawn with no machine named is allowed.",
      "Arrives unstamped, so the automation rule cannot see it. Needs BB core to stamp threads.send.",
      "Never refused unless BB stamps it as an automation: the person rules need an Access email. Attributed to the fallback email when one is set.",
      "Seen by the request stream in audit/enforce modes; never refused.",
      "Same hook as the composer.",
    ]);
  });
});
