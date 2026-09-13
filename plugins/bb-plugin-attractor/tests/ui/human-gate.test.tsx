// @vitest-environment jsdom
/**
 * `ui/human-gate.tsx`'s `pendingInteraction` renderer, per T6 acceptance:
 * "renderer test (buttons per option, freeform input)".
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HumanGate } from "../../ui/human-gate";
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

describe("HumanGate", () => {
  it("renders a button per option, labelled with its accelerator key and stripped text", () => {
    const submit = vi.fn();
    const { getByRole } = render(<HumanGate interaction={interaction(BUTTON_PAYLOAD) as never} submit={submit} cancel={vi.fn()} />);

    expect(getByRole("button", { name: "[A] Approve" })).toBeTruthy();
    expect(getByRole("button", { name: "[R] Revise" })).toBeTruthy();
  });

  it("submits { kind: 'choice', raw } with the option's raw edge label when a button is clicked", () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { getByRole } = render(<HumanGate interaction={interaction(BUTTON_PAYLOAD) as never} submit={submit} cancel={vi.fn()} />);

    fireEvent.click(getByRole("button", { name: "[A] Approve" }));

    expect(submit).toHaveBeenCalledWith({ kind: "choice", raw: "[A] Approve" });
  });

  it("shows a free-text field and submit button only when the payload is freeform", () => {
    const { queryByPlaceholderText, rerender } = render(
      <HumanGate interaction={interaction(BUTTON_PAYLOAD) as never} submit={vi.fn()} cancel={vi.fn()} />,
    );
    expect(queryByPlaceholderText(/type an answer/i)).toBeNull();

    rerender(<HumanGate interaction={interaction({ ...BUTTON_PAYLOAD, freeform: true }) as never} submit={vi.fn()} cancel={vi.fn()} />);
    expect(queryByPlaceholderText(/type an answer/i)).toBeTruthy();
  });

  it("submits { kind: 'text', text } with the typed answer from the freeform field", () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { getByPlaceholderText, getByRole } = render(
      <HumanGate interaction={interaction({ ...BUTTON_PAYLOAD, freeform: true }) as never} submit={submit} cancel={vi.fn()} />,
    );

    fireEvent.change(getByPlaceholderText(/type an answer/i), { target: { value: "sounds good" } });
    fireEvent.click(getByRole("button", { name: /submit/i }));

    expect(submit).toHaveBeenCalledWith({ kind: "text", text: "sounds good" });
  });

  it("does not submit empty freeform text", () => {
    const submit = vi.fn();
    const { getByRole } = render(<HumanGate interaction={interaction({ ...BUTTON_PAYLOAD, freeform: true }) as never} submit={submit} cancel={vi.fn()} />);

    fireEvent.click(getByRole("button", { name: /submit/i }));

    expect(submit).not.toHaveBeenCalled();
  });

  it("calls cancel() from the Cancel button", () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const { getByRole } = render(<HumanGate interaction={interaction(BUTTON_PAYLOAD) as never} submit={vi.fn()} cancel={cancel} />);

    fireEvent.click(getByRole("button", { name: /cancel/i }));

    expect(cancel).toHaveBeenCalled();
  });

  it("shows the gate's question", () => {
    const { getByText } = render(<HumanGate interaction={interaction(BUTTON_PAYLOAD) as never} submit={vi.fn()} cancel={vi.fn()} />);
    expect(getByText("Approve plan?")).toBeTruthy();
  });

  it("renders a fallback message when the interaction payload doesn't match the expected shape", () => {
    const { getByRole } = render(<HumanGate interaction={interaction({ bogus: true } as never) as never} submit={vi.fn()} cancel={vi.fn()} />);
    expect(getByRole("alert")).toBeTruthy();
  });
});
