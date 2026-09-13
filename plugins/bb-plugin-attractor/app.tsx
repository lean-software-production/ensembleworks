import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { RunPanel } from "./ui/run-panel";
import { HumanGate } from "./ui/human-gate";
import { HUMAN_GATE_RENDERER_ID } from "./server/contracts";

/**
 * Attractor app entry point, per
 * docs/plans/2026-09-13-attractor-runner-plan.md T5: the `::attractor-run`
 * message directive (compact card) and its matching thread-panel action
 * (full view), both backed by `ui/run-panel.tsx`'s `RunPanel`. T6 adds the
 * human-gate `pendingInteraction` renderer (`ui/human-gate.tsx`), addressed
 * by the same `HUMAN_GATE_RENDERER_ID` server/human.ts passes as
 * `bb.ui.requestInput`'s `rendererId`.
 */
const ACTION_ID = "attractor-run";

function Directive({ attributes, message }: PluginMessageDirectiveProps) {
  const runId = attributes.run?.trim();
  if (!runId) return <p role="alert">Attractor directive has no run id.</p>;
  return <RunPanel runId={runId} threadId={message.threadId} mode="directive" />;
}

function Panel({ threadId, params }: PluginThreadPanelProps) {
  const runId = params && typeof params === "object" && "runId" in params && typeof params.runId === "string" ? params.runId : null;
  if (!runId) return <p>This panel has no run id.</p>;
  return <RunPanel runId={runId} threadId={threadId} mode="panel" />;
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: ACTION_ID, component: Directive });
  app.slots.threadPanelAction({ id: ACTION_ID, title: "Attractor run", icon: "Workflow", layout: "flush", component: Panel });
  app.slots.pendingInteraction({ id: HUMAN_GATE_RENDERER_ID, component: HumanGate });
});
