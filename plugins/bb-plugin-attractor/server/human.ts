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

/** The SDK's hard cap on a single `requestInput` wait (one hour); see `ask`. */
export const REQUEST_SLICE_MS = 60 * 60_000;

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
      // Same "bare object literal" rebuild as `options` above, for the same
      // reason (HumanGateContext/ReviewTargetSummary are interfaces, with no
      // index signature).
      context: input.gateContext ? { nodeId: input.gateContext.nodeId, label: input.gateContext.label, text: input.gateContext.text, threadId: input.gateContext.threadId } : null,
      reviewTarget: input.reviewTarget ? { path: input.reviewTarget.path, content: input.reviewTarget.content, error: input.reviewTarget.error } : null,
    };

    // `bb.ui.requestInput` times out after ten minutes by default and caps
    // `timeoutMs` at one hour, so one call can never wait as long as a human
    // gate legitimately does (a plan review left overnight). Ask in slices
    // instead: each slice is at most the SDK cap and never past the node's
    // own deadline; a slice that expires with deadline still ahead simply
    // re-issues the interaction. Dogfood run 4 (2026-09-13) lost its
    // "Approve plan?" gate to that ten-minute default.
    const deadline = input.timeoutMs !== undefined ? Date.now() + input.timeoutMs : Number.POSITIVE_INFINITY;
    let result: Awaited<ReturnType<typeof bb.ui.requestInput>>;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "timeout" };
      const slice = Math.min(remaining, REQUEST_SLICE_MS);
      result = await bb.ui.requestInput(
        { threadId: input.threadId, rendererId: HUMAN_GATE_RENDERER_ID, title: input.title, payload, timeoutMs: slice },
        { signal: input.signal },
      );
      // A slice shorter than the remaining budget that expired is just a
      // slice boundary — ask again. A slice that *was* the whole remaining
      // budget expiring is the gate's own timeout (decided by the slice
      // size, not by re-reading the clock, so a fast reply can't be
      // mistaken for time left).
      if (result.outcome === "cancelled" && result.reason === "timeout" && slice < remaining) continue;
      break;
    }

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
      return { kind: "text", text: data.text, actor: data.via };
    }
    const raw = data.raw;
    const option = input.options.find((o) => o.raw === raw);
    if (!option) {
      throw new Error(`human gate for node "${input.nodeId}" chose an unknown option: ${raw}`);
    }
    return { kind: "choice", option, actor: data.via };
  }

  return { ask };
}
