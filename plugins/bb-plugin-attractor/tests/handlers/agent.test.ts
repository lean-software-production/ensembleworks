import { describe, expect, it, vi } from "vitest";
import { createContext } from "../../engine/context";
import { createAgentHandler } from "../../handlers/agent";
import type { WorkflowNode } from "../../engine/types";
import type { AgentBackend } from "../../server/backend";

function node(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id: "plan", shape: "box", handlerKind: "agent", classes: [], goalGate: false, allowPartial: false, attrs: {}, ...overrides };
}

const NEVER_ABORT = new AbortController().signal;

function fakeBackend(run: AgentBackend["run"]): AgentBackend {
  return { run, reportResult: vi.fn(), isAwaitingResult: () => false, isWorkerThread: () => false };
}

describe("agent/prompt handler", () => {
  it("delegates to the backend with the run's threadId/projectId/environmentId context", async () => {
    const calls: unknown[] = [];
    const backend = fakeBackend(async (input) => {
      calls.push(input);
      return { status: "succeeded", text: "ok" };
    });
    const handler = createAgentHandler(backend, { threadId: "origin", projectId: "proj", environmentId: "env" });
    const outcome = await handler.run({
      node: node(),
      graph: { name: "G", nodes: new Map(), edges: [], nodeOrder: [], rankdir: "TB", onFailure: "route", maxNodeVisits: 0 },
      context: createContext({}),
      runId: "r",
      attempt: 1,
      visit: 1,
      stageId: "plan@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(outcome).toEqual({ status: "succeeded", text: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ threadId: "origin", projectId: "proj", environmentId: "env" });
  });
});
