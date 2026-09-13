import { describe, expect, it, vi } from "vitest";
import { parseWorkflowGraph } from "../../dot/graph";
import { createContext } from "../../engine/context";
import { createHumanHandler, parseAcceleratorLabel } from "../../handlers/human";
import type { HumanAskResult, HumanInterviewer } from "../../handlers/human";
import type { StageScopedEvent, WorkflowGraph } from "../../engine/types";

const NEVER_ABORT = new AbortController().signal;

const GRAPH_DOT = `digraph G {
  start [shape=Mdiamond]
  exit  [shape=Msquare]
  gate  [shape=hexagon, label="Approve plan?", prompt="Approve or revise?"]
  revise [label="Revise"]
  start -> gate
  gate -> exit   [label="[A] Approve"]
  gate -> revise [label="R) Revise"]
}`;

function graph(): WorkflowGraph {
  return parseWorkflowGraph(GRAPH_DOT) as unknown as WorkflowGraph;
}

function node(g: WorkflowGraph, id: string) {
  const found = g.nodes.get(id);
  if (!found) throw new Error(`no such node ${id}`);
  return found;
}

function baseInput(
  g: WorkflowGraph,
  contextValues: Record<string, unknown> = {},
  emit: (e: StageScopedEvent) => void = () => {},
) {
  return {
    node: node(g, "gate"),
    graph: g,
    context: createContext(contextValues as never),
    visit: 1,
    attempt: 1,
    runId: "r1",
    stageId: "gate@1",
    signal: NEVER_ABORT,
    emit,
  } as never;
}

function interviewer(result: HumanAskResult): { ask: ReturnType<typeof vi.fn>; interviewer: HumanInterviewer } {
  const ask = vi.fn().mockResolvedValue(result);
  return { ask, interviewer: { ask } };
}

describe("parseAcceleratorLabel", () => {
  it("parses a '[K] label' accelerator", () => {
    expect(parseAcceleratorLabel("[A] Approve")).toEqual({ key: "A", text: "Approve" });
  });

  it("parses a 'K) label' accelerator", () => {
    expect(parseAcceleratorLabel("R) Revise")).toEqual({ key: "R", text: "Revise" });
  });

  it("parses a 'K - label' accelerator", () => {
    expect(parseAcceleratorLabel("A - Approve")).toEqual({ key: "A", text: "Approve" });
  });

  it("leaves a label with no accelerator prefix untouched", () => {
    expect(parseAcceleratorLabel("Approve")).toEqual({ key: null, text: "Approve" });
  });

  it("does not mistake a legitimate ')' inside a label for a 'K) ' accelerator", () => {
    expect(parseAcceleratorLabel("run(x) thing")).toEqual({ key: null, text: "run(x) thing" });
  });
});

describe("createHumanHandler", () => {
  it("presents options parsed from outgoing edge labels and emits human.requested", async () => {
    const g = graph();
    const events: StageScopedEvent[] = [];
    const { ask, interviewer: iv } = interviewer({ kind: "choice", option: { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" } });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    await handler.run(baseInput(g, {}, (e) => events.push(e)));

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        nodeId: "gate",
        freeform: false,
        options: [
          { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" },
          { raw: "R) Revise", key: "R", text: "Revise", to: "revise" },
        ],
      }),
    );
    expect(events).toContainEqual({
      type: "human.requested",
      options: ["[A] Approve", "R) Revise"],
      // Fallback to the gate's single predecessor ("start") since this
      // test's context never sets `last_stage`; "start" has no label/
      // response text of its own, so context is present but mostly null.
      context: { nodeId: "start", label: null, text: null, threadId: null },
      reviewTarget: null,
    });
  });

  it("returns a succeeded outcome with preferredLabel + context keys on a button choice", async () => {
    const g = graph();
    const { interviewer: iv } = interviewer({ kind: "choice", option: { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" } });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    const outcome = await handler.run(baseInput(g));

    expect(outcome).toEqual({
      status: "succeeded",
      preferredLabel: "[A] Approve",
      text: "Approve",
      contextUpdates: {
        "human.gate.selected": "[A] Approve",
        "human.gate.label": "Approve",
        "human.gate.gate.answer": "[A] Approve",
        "human.gate.gate.label": "Approve",
      },
    });
  });

  it("emits human.answered with the chosen edge label", async () => {
    const g = graph();
    const events: StageScopedEvent[] = [];
    const { interviewer: iv } = interviewer({ kind: "choice", option: { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" } });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    await handler.run(baseInput(g, {}, (e) => events.push(e)));

    expect(events).toContainEqual({ type: "human.answered", answer: "[A] Approve" });
  });

  it("carries the interviewer's actor through to the human.answered event and the human.gate.actor context key", async () => {
    const g = graph();
    const events: StageScopedEvent[] = [];
    const { interviewer: iv } = interviewer({ kind: "choice", option: { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" }, actor: "ui" });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    const outcome = await handler.run(baseInput(g, {}, (e) => events.push(e)));

    expect(events).toContainEqual({ type: "human.answered", answer: "[A] Approve", actor: "ui" });
    expect(outcome.contextUpdates).toMatchObject({ "human.gate.actor": "ui" });
  });

  it("attributes a timeout's human.default_choice fallback to the 'default' actor, not an unknown ui/cli one", async () => {
    const g = graph();
    const events: StageScopedEvent[] = [];
    const { interviewer: iv } = interviewer({ kind: "timeout" });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    const outcome = await handler.run(baseInput(g, { human: { default_choice: "[A] Approve" } }, (e) => events.push(e)));

    expect(events).toContainEqual({ type: "human.answered", answer: "[A] Approve", actor: "default" });
    expect(outcome.contextUpdates).toMatchObject({ "human.gate.actor": "default" });
  });

  it("marks freeform=true when any outgoing edge declares it, and returns a succeeded outcome from free text with no preferredLabel", async () => {
    const g = parseWorkflowGraph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      gate  [shape=hexagon, label="Anything else?"]
      start -> gate
      gate -> exit [freeform=true]
    }`) as unknown as WorkflowGraph;
    const { ask, interviewer: iv } = interviewer({ kind: "text", text: "let's ship it" });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    const outcome = await handler.run({
      node: node(g, "gate"),
      graph: g,
      context: createContext({}),
      visit: 1,
      attempt: 1,
      runId: "r1",
      stageId: "gate@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ freeform: true }));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.preferredLabel).toBeUndefined();
    expect(outcome.text).toBe("let's ship it");
    expect(outcome.contextUpdates).toEqual({
      "human.gate.selected": "let's ship it",
      "human.gate.text": "let's ship it",
      "human.gate.gate.answer": "let's ship it",
    });
  });

  it("routes free text to the freeform edge's target (not a button edge) via jumpToNode", async () => {
    const g = parseWorkflowGraph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      notes [label="Record notes"]
      gate  [shape=hexagon, label="Approve?"]
      start -> gate
      gate -> exit  [label="[A] Approve"]
      gate -> notes [freeform=true]
      notes -> exit
    }`) as unknown as WorkflowGraph;
    const { interviewer: iv } = interviewer({ kind: "text", text: "please hold off" });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    const outcome = await handler.run({
      node: node(g, "gate"),
      graph: g,
      context: createContext({}),
      visit: 1,
      attempt: 1,
      runId: "r1",
      stageId: "gate@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(outcome.status).toBe("succeeded");
    expect(outcome.jumpToNode).toBe("notes");
  });

  it("falls back to the human.default_choice context value on timeout", async () => {
    const g = graph();
    const { interviewer: iv } = interviewer({ kind: "timeout" });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    const outcome = await handler.run(baseInput(g, { human: { default_choice: "[A] Approve" } }));

    expect(outcome.status).toBe("succeeded");
    expect(outcome.preferredLabel).toBe("[A] Approve");
    expect(outcome.contextUpdates).toMatchObject({ "human.gate.selected": "[A] Approve" });
  });

  it("fails clearly on timeout with no human.default_choice context value", async () => {
    const g = graph();
    const { interviewer: iv } = interviewer({ kind: "timeout" });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    const outcome = await handler.run(baseInput(g));

    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toMatch(/timed out/i);
    expect(outcome.failureReason).toMatch(/default_choice/);
  });

  it("fails clearly on timeout when human.default_choice does not match any outgoing edge label (validation finding, T6 round 2)", async () => {
    const g = graph();
    const { interviewer: iv } = interviewer({ kind: "timeout" });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    const outcome = await handler.run(baseInput(g, { human: { default_choice: "Approvve" } }));

    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toMatch(/default_choice/);
    expect(outcome.failureReason).toMatch(/Approvve/);
  });

  it("fails clearly when the human cancels the interaction", async () => {
    const g = graph();
    const { interviewer: iv } = interviewer({ kind: "cancelled" });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    const outcome = await handler.run(baseInput(g));

    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toMatch(/cancelled/i);
  });

  it("passes the node's timeoutMs and question_type through to the interviewer", async () => {
    const g = parseWorkflowGraph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      gate  [shape=hexagon, label="Pick one", timeout=30s, question_type="yesno"]
      start -> gate
      gate -> exit [label="Yes"]
    }`) as unknown as WorkflowGraph;
    const { ask, interviewer: iv } = interviewer({ kind: "choice", option: { raw: "Yes", key: null, text: "Yes", to: "exit" } });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    await handler.run({
      node: node(g, "gate"),
      graph: g,
      context: createContext({}),
      visit: 1,
      attempt: 1,
      runId: "r1",
      stageId: "gate@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000, questionType: "yesno" }));
  });
});

describe("createHumanHandler: gate context (2026-09-13 follow-up)", () => {
  it("passes the last_stage node's label, response text and worker thread id as gateContext", async () => {
    const g = graph();
    const { ask, interviewer: iv } = interviewer({ kind: "choice", option: { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" } });
    iv.stageThreadId = vi.fn().mockReturnValue("worker-thread-7");
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    await handler.run(
      baseInput(g, { last_stage: "revise", response: { revise: "Here is the revised plan." } }),
    );

    expect(iv.stageThreadId).toHaveBeenCalledWith("r1", "revise");
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        gateContext: { nodeId: "revise", label: "Revise", text: "Here is the revised plan.", threadId: "worker-thread-7" },
      }),
    );
  });

  it("falls back to the gate's single predecessor in the graph when last_stage is absent", async () => {
    const g = graph();
    const { ask, interviewer: iv } = interviewer({ kind: "choice", option: { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" } });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    await handler.run(baseInput(g));

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ gateContext: { nodeId: "start", label: null, text: null, threadId: null } }),
    );
  });

  it("reads a node's review_target file through the injected reader and passes it to the interviewer", async () => {
    const g = parseWorkflowGraph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      gate  [shape=hexagon, label="Approve plan?", review_target="PLAN.md"]
      start -> gate
      gate -> exit [label="[A] Approve"]
    }`) as unknown as WorkflowGraph;
    const { ask, interviewer: iv } = interviewer({ kind: "choice", option: { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" } });
    const readReviewTarget = vi.fn().mockResolvedValue({ path: "PLAN.md", content: "# The plan", error: null });
    const handler = createHumanHandler(iv, { threadId: "thread-1", readReviewTarget });

    await handler.run({
      node: node(g, "gate"),
      graph: g,
      context: createContext({}),
      visit: 1,
      attempt: 1,
      runId: "r1",
      stageId: "gate@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(readReviewTarget).toHaveBeenCalledWith("PLAN.md");
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ reviewTarget: { path: "PLAN.md", content: "# The plan", error: null } }));
  });

  it("surfaces a rejected review_target (e.g. path traversal) as an error field, not a thrown error", async () => {
    const g = parseWorkflowGraph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      gate  [shape=hexagon, label="Approve plan?", review_target="../secrets.md"]
      start -> gate
      gate -> exit [label="[A] Approve"]
    }`) as unknown as WorkflowGraph;
    const { ask, interviewer: iv } = interviewer({ kind: "choice", option: { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" } });
    const readReviewTarget = vi.fn().mockResolvedValue({ path: "../secrets.md", content: null, error: "workflow path escapes the environment root: ../secrets.md" });
    const handler = createHumanHandler(iv, { threadId: "thread-1", readReviewTarget });

    const outcome = await handler.run({
      node: node(g, "gate"),
      graph: g,
      context: createContext({}),
      visit: 1,
      attempt: 1,
      runId: "r1",
      stageId: "gate@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(outcome.status).toBe("succeeded");
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ reviewTarget: { path: "../secrets.md", content: null, error: expect.stringMatching(/escapes/) } }),
    );
  });

  it("reports review_target as unreadable when no reader is configured for this run", async () => {
    const g = parseWorkflowGraph(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      gate  [shape=hexagon, label="Approve plan?", review_target="PLAN.md"]
      start -> gate
      gate -> exit [label="[A] Approve"]
    }`) as unknown as WorkflowGraph;
    const { ask, interviewer: iv } = interviewer({ kind: "choice", option: { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" } });
    const handler = createHumanHandler(iv, { threadId: "thread-1" });

    await handler.run({
      node: node(g, "gate"),
      graph: g,
      context: createContext({}),
      visit: 1,
      attempt: 1,
      runId: "r1",
      stageId: "gate@1",
      signal: NEVER_ABORT,
      emit: () => {},
    } as never);

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ reviewTarget: { path: "PLAN.md", content: null, error: expect.any(String) } }),
    );
  });
});
