import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { completionMarker, findDeliveredMarker } from "./completion";
import type { Job } from "./jobs";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

function job(): Job {
  return { id: "job-1", threadId: "thread-1", projectId: null, environmentId: null, hostId: null,
    workspacePath: null, workflowVersionId: null, engineUrl: null, sourcePath: null, requestKey: "r",
    inputHash: "h", workOrder: {}, runId: "run-1", createdAt: 1, updatedAt: 1, createState: "confirmed",
    createDetail: null, observationState: "succeeded", engineStatus: "succeeded", connectionError: null,
    observationDetail: null, resultRevision: 2, result: { ok: true }, completionState: "uncertain",
    completionDetail: null, completionMessageId: null, acceptanceVerdict: "pending", acceptanceReason: null,
    acceptanceResultRevision: null };
}

describe("completion reconciliation", () => {
  it("recognizes a marker in bounded prompt history", async () => {
    const current = job(); const marker = completionMarker(current);
    const host = createFakePluginHost({ sdk: { threads: {
      promptHistory: async () => [{ id: "turn-1", createdAt: 1, input: [{ type: "text", text: `done ${marker}`, mentions: [] }] }],
      queuedMessages: { list: async () => [] },
    } } }); hosts.push(host);
    expect(await findDeliveredMarker(host.bb, current)).toBe("turn-1");
  });

  it("recognizes a marker in queued content", async () => {
    const current = job(); const marker = completionMarker(current);
    const host = createFakePluginHost({ sdk: { threads: {
      promptHistory: async () => [],
      queuedMessages: { list: async () => [{ id: "queued-1", threadId: current.threadId, content: [{ type: "text", text: marker, mentions: [] }] }] },
    } } }); hosts.push(host);
    expect(await findDeliveredMarker(host.bb, current)).toBe("queued-1");
  });

  it("returns null when neither bounded source contains the marker", async () => {
    const current = job();
    const host = createFakePluginHost({ sdk: { threads: {
      promptHistory: async () => [{ id: "turn-other", createdAt: 1, input: [{ type: "text", text: "unrelated", mentions: [] }] }],
      queuedMessages: { list: async () => [] },
    } } }); hosts.push(host);
    expect(await findDeliveredMarker(host.bb, current)).toBeNull();
  });
});
