// @vitest-environment jsdom
/**
 * `ui/human-gate.tsx`'s `pendingInteraction` renderer, per T6 acceptance:
 * "renderer test (buttons per option, freeform input)", extended by the
 * 2026-09-13 gate-context follow-up (Reviewing:/Output of/Open thread).
 *
 * Rendered through the SDK's `loadPluginApp`/`renderSlot` harness (as
 * tests/app.test.tsx already does for this same renderer) rather than a raw
 * `@testing-library/react` render: `HumanGate` now calls `useBbNavigate()`
 * directly (for "Open thread"), which only resolves against a real hook
 * implementation once the plugin's app module has been evaluated *after*
 * the test runtime is installed — exactly what `loadPluginApp` guarantees.
 */
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { HumanGatePayload } from "../../server/contracts";

afterEach(cleanup);

function interaction(payload: HumanGatePayload, overrides: Partial<{ id: string; threadId: string; title: string; createdAt: number; expiresAt: number | null }> = {}) {
  return {
    id: overrides.id ?? "interaction-1",
    threadId: overrides.threadId ?? "thread-1",
    title: overrides.title ?? "Approve plan?",
    payload: payload as unknown,
    createdAt: overrides.createdAt ?? 0,
    expiresAt: overrides.expiresAt ?? null,
  };
}

const BUTTON_PAYLOAD: HumanGatePayload = {
  runId: "run-1",
  nodeId: "gate",
  question: "Approve plan?",
  options: [
    { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" },
    { raw: "R) Revise", key: "R", text: "Revise", to: "revise" },
  ],
  freeform: false,
  questionType: null,
};

async function renderGate(payload: HumanGatePayload, submit = vi.fn(), cancel = vi.fn()) {
  const app = await loadPluginApp(() => import("../../app"));
  const slot = renderSlot(app.pendingInteractions[0]!, { interaction: interaction(payload) as never, submit, cancel });
  return { slot, submit, cancel, component: app.pendingInteractions[0]!.component };
}

describe("HumanGate", () => {
  it("renders a button per option, labelled with its accelerator key and stripped text", async () => {
    const { slot } = await renderGate(BUTTON_PAYLOAD);

    expect(slot.getByRole("button", { name: "[A] Approve" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "[R] Revise" })).toBeTruthy();
  });

  it("submits { kind: 'choice', raw } with the option's raw edge label when a button is clicked", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { slot } = await renderGate(BUTTON_PAYLOAD, submit);

    fireEvent.click(slot.getByRole("button", { name: "[A] Approve" }));

    expect(submit).toHaveBeenCalledWith({ kind: "choice", raw: "[A] Approve", via: "ui" });
  });

  it("shows a free-text field and submit button only when the payload is freeform", async () => {
    const { slot, component: Component } = await renderGate(BUTTON_PAYLOAD);
    expect(slot.queryByPlaceholderText(/type an answer/i)).toBeNull();

    slot.rerender(<Component interaction={interaction({ ...BUTTON_PAYLOAD, freeform: true }) as never} submit={vi.fn()} cancel={vi.fn()} />);
    expect(slot.queryByPlaceholderText(/type an answer/i)).toBeTruthy();
  });

  it("submits { kind: 'text', text } with the typed answer from the freeform field", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { slot } = await renderGate({ ...BUTTON_PAYLOAD, freeform: true }, submit);

    fireEvent.change(slot.getByPlaceholderText(/type an answer/i), { target: { value: "sounds good" } });
    fireEvent.click(slot.getByRole("button", { name: /submit/i }));

    expect(submit).toHaveBeenCalledWith({ kind: "text", text: "sounds good", via: "ui" });
  });

  it("does not submit empty freeform text", async () => {
    const submit = vi.fn();
    const { slot } = await renderGate({ ...BUTTON_PAYLOAD, freeform: true }, submit);

    fireEvent.click(slot.getByRole("button", { name: /submit/i }));

    expect(submit).not.toHaveBeenCalled();
  });

  it("calls cancel() from the Cancel button", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const { slot } = await renderGate(BUTTON_PAYLOAD, vi.fn(), cancel);

    fireEvent.click(slot.getByRole("button", { name: /cancel/i }));

    expect(cancel).toHaveBeenCalled();
  });

  it("shows the gate's question", async () => {
    const { slot } = await renderGate(BUTTON_PAYLOAD);
    expect(slot.getByText("Approve plan?")).toBeTruthy();
  });

  it("renders a fallback message when the interaction payload doesn't match the expected shape", async () => {
    const { slot } = await renderGate({ bogus: true } as never);
    expect(slot.getByRole("alert")).toBeTruthy();
  });
});

describe("HumanGate: gate context (2026-09-13 follow-up)", () => {
  it("renders a Markdown 'Reviewing: <path>' block for a .md review_target", async () => {
    const payload: HumanGatePayload = { ...BUTTON_PAYLOAD, reviewTarget: { path: "PLAN.md", content: "# The plan", error: null } };
    const { slot } = await renderGate(payload);

    expect(slot.getByText("Reviewing: PLAN.md")).toBeTruthy();
    const markdown = slot.getByTestId("bb-markdown");
    expect(markdown.textContent).toBe("# The plan");
  });

  it("renders a <pre> block (not Markdown) for a non-.md review_target", async () => {
    const payload: HumanGatePayload = { ...BUTTON_PAYLOAD, reviewTarget: { path: "notes.txt", content: "plain text content", error: null } };
    const { slot } = await renderGate(payload);

    expect(slot.queryByTestId("bb-markdown")).toBeNull();
    const pre = slot.container.querySelector("pre");
    expect(pre?.textContent).toBe("plain text content");
  });

  it("shows the review_target's error instead of its content when reading it failed", async () => {
    const payload: HumanGatePayload = { ...BUTTON_PAYLOAD, reviewTarget: { path: "../secrets.md", content: null, error: "workflow path escapes the environment root: ../secrets.md" } };
    const { slot } = await renderGate(payload);

    expect(slot.getByText(/escapes the environment root/)).toBeTruthy();
    expect(slot.queryByTestId("bb-markdown")).toBeNull();
  });

  it("shows a collapsible 'Output of <label>' block for the routing predecessor's response text, open by default with no review_target", async () => {
    const payload: HumanGatePayload = { ...BUTTON_PAYLOAD, context: { nodeId: "revise", label: "Revise", text: "Here is the revised plan.", threadId: null } };
    const { slot } = await renderGate(payload);

    const summary = slot.getByText("Output of Revise");
    const details = summary.closest("details");
    expect(details?.open).toBe(true);
    expect(slot.getByTestId("bb-markdown").textContent).toBe("Here is the revised plan.");
  });

  it("falls back to the node id when the predecessor has no label", async () => {
    const payload: HumanGatePayload = { ...BUTTON_PAYLOAD, context: { nodeId: "revise", label: null, text: "Here is the revised plan.", threadId: null } };
    const { slot } = await renderGate(payload);

    expect(slot.getByText("Output of revise")).toBeTruthy();
  });

  it("collapses the 'Output of' block by default when a review_target is also shown, and expands it on click", async () => {
    const payload: HumanGatePayload = {
      ...BUTTON_PAYLOAD,
      reviewTarget: { path: "PLAN.md", content: "# The plan", error: null },
      context: { nodeId: "revise", label: "Revise", text: "Here is the revised plan.", threadId: null },
    };
    const { slot } = await renderGate(payload);

    const summary = slot.getByText("Output of Revise");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);

    fireEvent.click(summary);
    expect(details.open).toBe(true);
  });

  it("shows no 'Output of' block when the context has no response text", async () => {
    const payload: HumanGatePayload = { ...BUTTON_PAYLOAD, context: { nodeId: "start", label: null, text: null, threadId: null } };
    const { slot } = await renderGate(payload);

    expect(slot.queryByText(/output of/i)).toBeNull();
  });

  it("shows an 'Open thread' button that navigates to the predecessor's worker thread", async () => {
    const payload: HumanGatePayload = { ...BUTTON_PAYLOAD, context: { nodeId: "revise", label: "Revise", text: "Here is the revised plan.", threadId: "worker-thread-7" } };
    const { slot } = await renderGate(payload);

    fireEvent.click(slot.getByRole("button", { name: /open thread/i }));

    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "worker-thread-7" }));
  });

  it("shows no 'Open thread' button when the predecessor's worker thread is unknown", async () => {
    const payload: HumanGatePayload = { ...BUTTON_PAYLOAD, context: { nodeId: "revise", label: "Revise", text: "Here is the revised plan.", threadId: null } };
    const { slot } = await renderGate(payload);

    expect(slot.queryByRole("button", { name: /open thread/i })).toBeNull();
  });

  it("shows neither block when context/reviewTarget are absent (a payload from before this follow-up)", async () => {
    const { slot } = await renderGate(BUTTON_PAYLOAD);

    expect(slot.queryByText(/reviewing:/i)).toBeNull();
    expect(slot.queryByText(/output of/i)).toBeNull();
    expect(slot.queryByRole("button", { name: /open thread/i })).toBeNull();
  });
});
