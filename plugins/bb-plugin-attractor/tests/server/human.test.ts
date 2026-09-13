/**
 * `server/human.ts`'s real `HumanInterviewer` (bb.ui.requestInput-backed),
 * per docs/plans/2026-09-13-attractor-runner-plan.md T6 acceptance: "server
 * test that bb.ui.requestInput is called with the edge options and the
 * answer routes by preferred_label".
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { HUMAN_GATE_RENDERER_ID } from "../../server/contracts";
import { createThreadHumanInterviewer } from "../../server/human";
import type { HumanGateOption } from "../../handlers/human";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function makeHost() {
  const host = createFakePluginHost();
  hosts.push(host);
  return host;
}

const OPTIONS: HumanGateOption[] = [
  { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" },
  { raw: "R) Revise", key: "R", text: "Revise", to: "revise" },
];

function baseAsk(overrides: Partial<Parameters<ReturnType<typeof createThreadHumanInterviewer>["ask"]>[0]> = {}) {
  return {
    runId: "run-1",
    stageId: "gate@1",
    nodeId: "gate",
    threadId: "thread-1",
    title: "Approve plan?",
    question: "Approve plan?",
    options: OPTIONS,
    freeform: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("createThreadHumanInterviewer", () => {
  it("calls bb.ui.requestInput with the edge options as payload, and the chosen option routes by preferred_label", async () => {
    const host = makeHost();
    const interviewer = createThreadHumanInterviewer(host.bb);

    const askPromise = interviewer.ask(baseAsk());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.harness.pendingInteractions).toHaveLength(1);
    const pending = host.harness.pendingInteractions[0]!;
    expect(pending.threadId).toBe("thread-1");
    expect(pending.rendererId).toBe(HUMAN_GATE_RENDERER_ID);
    expect(pending.payload).toMatchObject({
      runId: "run-1",
      nodeId: "gate",
      options: OPTIONS,
      freeform: false,
    });

    host.harness.submitInteraction(pending.id, { kind: "choice", raw: "[A] Approve" });
    const result = await askPromise;

    expect(result).toEqual({ kind: "choice", option: OPTIONS[0] });
  });

  it("passes freeform=true and question_type through to the payload", async () => {
    const host = makeHost();
    const interviewer = createThreadHumanInterviewer(host.bb);

    const askPromise = interviewer.ask(baseAsk({ freeform: true, questionType: "yesno" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pending = host.harness.pendingInteractions[0]!;
    expect(pending.payload).toMatchObject({ freeform: true, questionType: "yesno" });

    host.harness.submitInteraction(pending.id, { kind: "text", text: "sounds good" });
    expect(await askPromise).toEqual({ kind: "text", text: "sounds good" });
  });

  it("passes the node's timeoutMs through to requestInput", async () => {
    const host = makeHost();
    const interviewer = createThreadHumanInterviewer(host.bb);

    const askPromise = interviewer.ask(baseAsk({ timeoutMs: 30_000 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.harness.pendingInteractions[0]!.timeoutMs).toBe(30_000);
    host.harness.cancelInteraction(host.harness.pendingInteractions[0]!.id);
    await askPromise;
  });

  it("maps a user-cancelled interaction to { kind: 'cancelled' }", async () => {
    const host = makeHost();
    const interviewer = createThreadHumanInterviewer(host.bb);

    const askPromise = interviewer.ask(baseAsk());
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.harness.cancelInteraction(host.harness.pendingInteractions[0]!.id);

    expect(await askPromise).toEqual({ kind: "cancelled" });
  });

  it("maps a signal-aborted interaction (Stop) to a thrown error, not a silent cancel", async () => {
    const host = makeHost();
    const interviewer = createThreadHumanInterviewer(host.bb);
    const controller = new AbortController();

    const askPromise = interviewer.ask(baseAsk({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(askPromise).rejects.toThrow();
  });

  it("rejects a malformed submitted value rather than guessing an answer", async () => {
    const host = makeHost();
    const interviewer = createThreadHumanInterviewer(host.bb);

    const askPromise = interviewer.ask(baseAsk());
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, { bogus: true });

    await expect(askPromise).rejects.toThrow();
  });

  it("rejects a submitted choice naming an option that was never offered", async () => {
    const host = makeHost();
    const interviewer = createThreadHumanInterviewer(host.bb);

    const askPromise = interviewer.ask(baseAsk());
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, { kind: "choice", raw: "Not an option" });

    await expect(askPromise).rejects.toThrow(/unknown option/);
  });
});
