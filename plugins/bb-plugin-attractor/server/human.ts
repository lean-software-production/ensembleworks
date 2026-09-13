/**
 * The real `HumanInterviewer` (handlers/human.ts's injected dependency),
 * backed by `bb.ui.requestInput` per
 * docs/plans/2026-09-13-attractor-runner-plan.md "BB plugin SDK notes":
 * "Human input from the server: `await bb.ui.requestInput({ threadId,
 * rendererId, title, payload, timeoutMs? }, { signal })`."
 *
 * The `rendererId` (`HUMAN_GATE_RENDERER_ID`) addresses `app.tsx`'s
 * `pendingInteraction` registration (`ui/human-gate.tsx`), which renders the
 * same option list this module sends as `payload` and calls `submit(value)`
 * with a `HumanGateValue` this module validates on the way back.
 *
 * `bb.ui.requestInput`'s own cancellation reasons distinguish a genuine user
 * cancel (`reason: "user"`, the pendingInteraction's Cancel button) — which
 * maps to `HumanAskResult`'s own `{ kind: "cancelled" }` so the handler fails
 * the stage cleanly — from every other reason (`request-aborted` in
 * particular, which is exactly what firing this call's own `signal` argument
 * produces, e.g. via the Panel's Stop button). Those propagate as a thrown
 * error instead, the same way server/backend.ts's agent backend throws on an
 * aborted worker thread wait, so the engine treats it as a cancelled run
 * rather than a merely-declined human gate.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HumanAskInput, HumanAskResult, HumanInterviewer } from "../handlers/human";
import { HUMAN_GATE_RENDERER_ID, humanGateValueSchema } from "./contracts";

export function createThreadHumanInterviewer(bb: BbPluginApi): HumanInterviewer {
  async function ask(input: HumanAskInput): Promise<HumanAskResult> {
    const payload = {
      runId: input.runId,
      nodeId: input.nodeId,
      question: input.question,
      // Rebuilt as bare object literals (not the `HumanGateOption` interface):
      // an interface has no index signature, so an array of it doesn't
      // structurally satisfy `JsonValue`'s `{ [key: string]: JsonValue }`
      // even though every one of its properties does.
      options: input.options.map((o) => ({ raw: o.raw, key: o.key, text: o.text, to: o.to })),
      freeform: input.freeform,
      questionType: input.questionType ?? null,
    };

    const result = await bb.ui.requestInput(
      { threadId: input.threadId, rendererId: HUMAN_GATE_RENDERER_ID, title: input.title, payload, timeoutMs: input.timeoutMs },
      { signal: input.signal },
    );

    if (result.outcome === "cancelled") {
      if (result.reason === "timeout") return { kind: "timeout" };
      if (result.reason === "user") return { kind: "cancelled" };
      throw new Error(`human gate interaction for node "${input.nodeId}" ended without an answer: ${result.reason}`);
    }

    const parsed = humanGateValueSchema.safeParse(result.value);
    if (!parsed.success) {
      throw new Error(`human gate for node "${input.nodeId}" returned an invalid response value`);
    }
    const data = parsed.data;
    if (data.kind === "text") {
      return { kind: "text", text: data.text };
    }
    const raw = data.raw;
    const option = input.options.find((o) => o.raw === raw);
    if (!option) {
      throw new Error(`human gate for node "${input.nodeId}" chose an unknown option: ${raw}`);
    }
    return { kind: "choice", option };
  }

  return { ask };
}
