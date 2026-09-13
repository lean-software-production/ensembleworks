import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { RunPanel } from "./ui/run-panel";
import { HumanGate } from "./ui/human-gate";
import { ActiveRunsBanner } from "./ui/active-runs-banner";
import { HUMAN_GATE_RENDERER_ID } from "./server/contracts";

/**
 * Attractor app entry point, per
 * docs/plans/2026-09-13-attractor-runner-plan.md T5: the `::attractor-run`
 * message directive (compact card) and its matching thread-panel action
 * (full view), both backed by `ui/run-panel.tsx`'s `RunPanel`. T6 adds the
 * human-gate `pendingInteraction` renderer (`ui/human-gate.tsx`), addressed
 * by the same `HUMAN_GATE_RENDERER_ID` server/human.ts passes as
 * `bb.ui.requestInput`'s `rendererId`. The 2026-09-13 "active-runs composer
 * banner" follow-up adds `ui/active-runs-banner.tsx`'s `ActiveRunsBanner`,
 * registered via `app.composer.customize` — every run still in flight for
 * the composer's own thread, shown right above the message box.
 *
 * The 2026-09-13 "cross-thread cards" follow-up adds an optional `thread`
 * directive attribute — the run's origin thread id — so
 * `::attractor-run{run="<runId>" thread="<threadId>"}` can be pasted into
 * any thread and still resolve (every RPC call is scoped to a run's origin
 * thread; see server.ts's `owned()`). Falls back to the hosting message's
 * own thread when absent (a pre-follow-up directive, or one authored by
 * hand without it), which is exactly today's same-thread behavior.
 */
const ACTION_ID = "attractor-run";

function Directive({ attributes, message }: PluginMessageDirectiveProps) {
  const runId = attributes.run?.trim();
  if (!runId) return <p role="alert">Attractor directive has no run id.</p>;
  const threadId = attributes.thread?.trim() || message.threadId;
  return <RunPanel runId={runId} threadId={threadId} mode="directive" />;
}

function Panel({ threadId, params }: PluginThreadPanelProps) {
  const runId = params && typeof params === "object" && "runId" in params && typeof params.runId === "string" ? params.runId : null;
  if (!runId) return <p>This panel has no run id.</p>;
  // A panel opened from a cross-thread card (RunCard's "Open in right
  // panel") carries the run's origin thread id along in its params — see
  // ui/run-panel.tsx's `onOpenPanel` — so the panel keeps addressing that
  // run's actual thread even when opened into a different one.
  const panelThreadId = params && typeof params === "object" && "threadId" in params && typeof params.threadId === "string" ? params.threadId : threadId;
  return <RunPanel runId={runId} threadId={panelThreadId} mode="panel" />;
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: ACTION_ID, component: Directive });
  app.slots.threadPanelAction({ id: ACTION_ID, title: "Attractor run", icon: "Workflow", layout: "flush", component: Panel });
  app.slots.pendingInteraction({ id: HUMAN_GATE_RENDERER_ID, component: HumanGate });
  app.composer.customize({ id: "attractor-status", scopes: ["thread"], banners: [{ id: "active-runs", chrome: "bare", component: ActiveRunsBanner }] });
});
