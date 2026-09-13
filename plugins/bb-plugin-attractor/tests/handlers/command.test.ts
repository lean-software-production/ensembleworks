import { describe, expect, it, vi } from "vitest";
import { createContext } from "../../engine/context";
import { createCommandHandler } from "../../handlers/command";
import type { WorkflowNode } from "../../engine/types";

function node(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: "build",
    shape: "parallelogram",
    handlerKind: "command",
    classes: [],
    goalGate: false,
    allowPartial: false,
    attrs: {},
    ...overrides,
  };
}

const NEVER_ABORT = new AbortController().signal;

describe("command handler", () => {
  it("maps exit code 0 to a succeeded outcome carrying stdout as text and command.* context updates", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "all good\n", stderr: "", timedOut: false });
    const handler = createCommandHandler({ exec });
    const outcome = await handler.run({
      node: node({ script: "npm test" }),
      context: createContext({}),
      runId: "r",
      attempt: 1,
      visit: 1,
      stageId: "build@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(outcome).toEqual({
      status: "succeeded",
      text: "all good\n",
      contextUpdates: { "command.output": "all good\n", "command.exit_code": 0 },
    });
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ script: "npm test", env: expect.objectContaining({ ATTRACTOR_RUN_ID: "r", ATTRACTOR_NODE_ID: "build" }) }),
      expect.objectContaining({ signal: NEVER_ABORT }),
    );
  });

  it("maps a non-zero exit code to a failed outcome with the exit code and stderr tail in failureReason", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 2, stdout: "partial\n", stderr: "boom", timedOut: false });
    const handler = createCommandHandler({ exec });
    const outcome = await handler.run({
      node: node({ script: "npm test" }),
      context: createContext({}),
      runId: "r",
      attempt: 1,
      visit: 1,
      stageId: "build@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(outcome.status).toBe("failed");
    expect(outcome.contextUpdates).toEqual({ "command.output": "partial\n", "command.exit_code": 2 });
    expect(outcome.failureReason).toMatch(/exit code 2/);
    expect(outcome.failureReason).toMatch(/boom/);
  });

  it("maps a timeout to a failed outcome", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: -1, stdout: "", stderr: "", timedOut: true });
    const handler = createCommandHandler({ exec });
    const outcome = await handler.run({
      node: node({ script: "sleep 999", timeoutMs: 10 }),
      context: createContext({}),
      runId: "r",
      attempt: 1,
      visit: 1,
      stageId: "build@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toMatch(/timed out/);
  });

  it("passes stdin_source's resolved context value as stdin", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    const handler = createCommandHandler({ exec });
    await handler.run({
      node: node({ script: "cat", stdinSource: "response.plan" }),
      context: createContext({ response: { plan: "do the thing" } }),
      runId: "r",
      attempt: 1,
      visit: 1,
      stageId: "build@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ stdin: "do the thing" }), expect.anything());
  });

  it("fails fast with a clear error when the node has no script", async () => {
    const exec = vi.fn();
    const handler = createCommandHandler({ exec });
    const outcome = await handler.run({
      node: node({ script: undefined }),
      context: createContext({}),
      runId: "r",
      attempt: 1,
      visit: 1,
      stageId: "build@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toMatch(/no script/);
    expect(exec).not.toHaveBeenCalled();
  });
});
