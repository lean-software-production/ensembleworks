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
    expect(events).toContainEqual({ type: "human.requested", options: ["[A] Approve", "R) Revise"] });
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
